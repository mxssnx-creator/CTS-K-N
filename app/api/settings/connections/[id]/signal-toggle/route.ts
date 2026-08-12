import { type NextRequest, NextResponse } from "next/server"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { maskConnectionSecrets } from "@/lib/connection-secrets"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import {
  allocateStateSwitchVersion,
  queueEngineRefreshRequest,
} from "@/lib/engine-refresh-queue"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { checkProductionReadiness, productionReadinessJson } from "@/lib/production-readiness"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { SystemLogger } from "@/lib/system-logger"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 15

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectionId } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const rawFlag = body?.is_signal_trade ?? body?.enabled
    if (rawFlag === undefined || rawFlag === null) {
      return NextResponse.json(
        { success: false, error: "Missing required is_signal_trade flag" },
        { status: 400 },
      )
    }
    const requested = parseBooleanInput(rawFlag)
    if (requested && process.env.NODE_ENV === "production") {
      const production = await checkProductionReadiness({ requireConnectionCredentials: false })
      if (!production.ready) {
        return NextResponse.json(productionReadinessJson(production), { status: 503 })
      }
    }

    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }

    const readiness = evaluateRealTradeReadiness({
      ...connection,
      is_signal_trade: toRedisFlag(requested),
      signal_trade_enabled: toRedisFlag(requested),
      signal_trade_requested: toRedisFlag(requested),
      signal_trade_blocked_reason: "",
    }, "signal")
    const effective = requested && readiness.canPlaceRealOrders
    const blockedReason = requested && !effective ? readiness.blockReason : ""
    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const changedAt = new Date().toISOString()
    const connectionPatch = {
      is_signal_trade: toRedisFlag(effective),
      signal_trade_enabled: toRedisFlag(effective),
      signal_trade_requested: toRedisFlag(requested),
      signal_trade_blocked_reason: blockedReason,
      signal_trade_block_code: blockedReason ? String(readiness.blockCode || "unknown") : "",
      // The Signal switch owns channel intent and visibility, not a second
      // processor. A requested-but-exchange-blocked channel must still wake the
      // one shared Main engine so Signal indications, paper state, attribution,
      // and overview statistics keep progressing.
      ...(requested
        ? {
            is_assigned: "1",
            is_active_inserted: "1",
            is_dashboard_inserted: "1",
            is_enabled_dashboard: "1",
            is_active: "1",
          }
        : {}),
      state_switch_version: stateSwitchVersion,
      signal_trade_changed_at: changedAt,
      updated_at: changedAt,
    }
    const changedFieldsOverride = Object.keys(connectionPatch).filter((field) => {
      if (field === "updated_at") return false
      return JSON.stringify((connection as any)[field]) !==
        JSON.stringify((connectionPatch as any)[field])
    })
    const {
      connection: updatedConnection,
      completion,
      stateTransitionApplied,
    } = await applyMainConnectionSettingsChange(connectionId, connection, {
      connectionPatch,
      changedFieldsOverride,
      logTag: "POST /settings/connections/[id]/signal-toggle",
      settingsVersion: stateSwitchVersion,
      stateSwitchVersion,
    })
    if (!stateTransitionApplied) {
      return NextResponse.json(
        {
          success: false,
          error: "Signal switch was superseded by a newer state",
          state_switch_version: updatedConnection.state_switch_version,
        },
        { status: 409 },
      )
    }

    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus: "running" | "queued" | "stopped" | "error" =
      coordinator.isEngineRunning(connectionId) ? "running" : "stopped"
    let engineStartedNow = false
    if (requested) {
      await getRedisClient().hset("trade_engine:global", {
        status: "running",
        desired_status: "running",
        operator_intent: "running",
        coordinator_ready: "true",
        operator_stopped: "0",
        operator_stopped_at: "",
        stopped_at: "",
        mode: effective ? "signal" : "signal_requested",
        updated_at: changedAt,
      }).catch(() => undefined)
    }
    if (requested && !coordinator.isEngineRunning(connectionId)) {
      const localStartAllowed =
        process.env.DISABLE_TRADE_ENGINE_IN_PROCESS !== "1" &&
        process.env.NEXT_RUNTIME !== "edge" &&
        (process.env.VERCEL !== "1" ||
          (process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
            process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"))
      try {
        if (localStartAllowed) {
          const settings = await loadSettingsAsync()
          engineStartedNow = await coordinator.startEngine(connectionId, {
            connectionId,
            connection_name: connection.name,
            exchange: connection.exchange,
            engine_type: "main",
            allowInProcessStart: true,
            indicationInterval: settings?.mainEngineIntervalMs
              ? settings.mainEngineIntervalMs / 1000
              : 5,
            strategyInterval: settings?.strategyUpdateIntervalMs
              ? settings.strategyUpdateIntervalMs / 1000
              : 10,
            realtimeInterval: settings?.realtimeIntervalMs
              ? settings.realtimeIntervalMs / 1000
              : 0.3,
          }, { markAssigned: true, forceLocalTakeover: true })
          engineStatus = coordinator.isEngineRunning(connectionId) ? "running" : "queued"
        } else {
          await queueEngineRefreshRequest({
            connectionId,
            action: "start",
            state_switch_version: stateSwitchVersion,
            reason: "signal_trade_enable",
            timestamp: changedAt,
          })
          engineStatus = "queued"
        }
      } catch (error) {
        await queueEngineRefreshRequest({
          connectionId,
          action: "start",
          state_switch_version: stateSwitchVersion,
          reason: "signal_trade_enable_foreground_start_failed",
          timestamp: new Date().toISOString(),
        }).catch(() => undefined)
        engineStatus = "queued"
        await SystemLogger.logError(error, "api", `Signal start queued for ${connection.name}`)
      }
    }

    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: {
        mode: "signal",
        enabled: effective,
        requested,
        executionMode: readiness.executionMode,
        blockCode: blockedReason ? readiness.blockCode : undefined,
        blockReason: blockedReason || undefined,
        engineStatus,
        refreshQueued: completion.refreshQueued === true,
      },
    })

    return NextResponse.json({
      success: true,
      is_signal_trade: effective,
      signal_trade_enabled: effective,
      signal_trade_requested: requested,
      signal_trade_blocked_reason: blockedReason,
      signal_trade_block_code: blockedReason ? readiness.blockCode : null,
      signal_execution_mode: effective ? "live" : requested ? "blocked" : "simulation",
      engineStatus,
      engineStartedNow,
      connection: maskConnectionSecrets(updatedConnection),
    })
  } catch (error) {
    await SystemLogger.logError(
      error,
      "api",
      `POST /api/settings/connections/${connectionId}/signal-toggle`,
    )
    return NextResponse.json(
      {
        success: false,
        error: "Failed to toggle signal trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
