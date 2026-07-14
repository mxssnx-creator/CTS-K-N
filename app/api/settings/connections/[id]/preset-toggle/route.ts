import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { maskConnectionSecrets } from "@/lib/connection-secrets"
import { checkProductionReadiness, productionReadinessJson } from "@/lib/production-readiness"

/**
 * Preset mode is a mode of the connection's single shared engine. Disabling it
 * never stops the Main pipeline; enabling it wakes or queues that shared engine
 * and publishes a durable settings generation for its owner process.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 15

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const rawFlag = body?.is_preset_trade ?? body?.enabled
    if (rawFlag === undefined || rawFlag === null) {
      return NextResponse.json(
        { success: false, error: "Missing required is_preset_trade flag" },
        { status: 400 },
      )
    }
    const isPresetTrade = parseBooleanInput(rawFlag)

    if (isPresetTrade && process.env.NODE_ENV === "production") {
      const readiness = await checkProductionReadiness()
      if (!readiness.ready) return NextResponse.json(productionReadinessJson(readiness), { status: 503 })
    }

    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const apiKey = String(connection.api_key || connection.apiKey || "")
    const apiSecret = String(connection.api_secret || connection.apiSecret || "")
    if (isPresetTrade && (apiKey.length <= 10 || apiSecret.length <= 10)) {
      return NextResponse.json(
        {
          success: false,
          error: "API credentials required for preset trading",
          hint: "Add API key and secret in Settings to enable preset trading",
        },
        { status: 400 },
      )
    }

    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const changedAt = new Date().toISOString()
    const connectionPatch = {
      is_preset_trade: toRedisFlag(isPresetTrade),
      ...(isPresetTrade
        ? {
            is_assigned: "1",
            is_active_inserted: "1",
            is_dashboard_inserted: "1",
            is_enabled_dashboard: "1",
            is_active: "1",
          }
        : {}),
      state_switch_version: stateSwitchVersion,
      preset_trade_changed_at: changedAt,
      updated_at: changedAt,
    }
    const presetFlagFields = new Set([
      "is_preset_trade",
      "is_assigned",
      "is_active_inserted",
      "is_dashboard_inserted",
      "is_enabled_dashboard",
      "is_active",
    ])
    const changedFieldsOverride = Object.keys(connectionPatch).filter((field) => {
      if (field === "updated_at" || field === "preset_trade_changed_at") return false
      if (field === "state_switch_version") return true
      if (presetFlagFields.has(field)) {
        return parseBooleanInput((connection as any)[field]) !== parseBooleanInput((connectionPatch as any)[field])
      }
      return JSON.stringify((connection as any)[field]) !== JSON.stringify((connectionPatch as any)[field])
    })

    const { connection: updatedConnection, completion, stateTransitionApplied } = await applyMainConnectionSettingsChange(
      connectionId,
      connection,
      {
        connectionPatch,
        changedFieldsOverride,
        logTag: "POST /settings/preset-toggle",
        settingsVersion: stateSwitchVersion,
        stateSwitchVersion,
      },
    )
    if (!stateTransitionApplied) {
      return NextResponse.json(
        { success: false, error: "Preset switch was superseded by a newer state", state_switch_version: updatedConnection.state_switch_version },
        { status: 409 },
      )
    }

    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus: "running" | "queued" | "stopped" | "error" =
      coordinator.isEngineRunning(connectionId) ? "running" : "stopped"
    let engineStartedNow = false

    if (isPresetTrade && !coordinator.isEngineRunning(connectionId)) {
      const client = getRedisClient()
      await client.hset("trade_engine:global", {
        status: "running",
        desired_status: "running",
        operator_intent: "running",
        coordinator_ready: "true",
        operator_stopped: "0",
        operator_stopped_at: "",
        stopped_at: "",
        mode: "preset",
        updated_at: changedAt,
      })

      const localStartAllowed =
        process.env.DISABLE_TRADE_ENGINE_IN_PROCESS !== "1" &&
        process.env.NEXT_RUNTIME !== "edge" &&
        (process.env.VERCEL !== "1" ||
          (process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
            process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"))

      try {
        if (localStartAllowed) {
          const settings = await loadSettingsAsync()
          const started = await coordinator.startEngine(connectionId, {
            connectionId,
            connection_name: connection.name,
            exchange: connection.exchange,
            engine_type: "preset",
            allowInProcessStart: true,
            indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
          }, { markAssigned: true, forceLocalTakeover: true })
          engineStartedNow = started
          engineStatus = coordinator.isEngineRunning(connectionId) ? "running" : "queued"
        } else {
          await queueEngineRefreshRequest({
            connectionId,
            action: "start",
            state_switch_version: stateSwitchVersion,
            reason: "preset_trade_enable",
            timestamp: changedAt,
          })
          engineStatus = "queued"
        }
      } catch (startError) {
        await queueEngineRefreshRequest({
          connectionId,
          action: "start",
          state_switch_version: stateSwitchVersion,
          reason: "preset_trade_enable_foreground_start_failed",
          timestamp: new Date().toISOString(),
        }).catch(() => undefined)
        engineStatus = "queued"
        await SystemLogger.logError(startError, "api", `Preset start queued for ${connection.name}`)
      }
    }

    await SystemLogger.logConnection(
      `Preset Mode ${isPresetTrade ? "enabled" : "disabled"} via UI toggle`,
      connectionId,
      "info",
      { is_preset_trade: isPresetTrade, engineStartedNow, engineStatus, stateSwitchVersion },
    )

    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: {
        mode: "preset",
        enabled: isPresetTrade,
        engineStatus,
        refreshQueued: completion.refreshQueued === true,
      },
    })

    return NextResponse.json({
      success: true,
      is_preset_trade: isPresetTrade,
      engineStatus,
      engineStartedNow,
      connection: maskConnectionSecrets(updatedConnection),
      message: `Preset Mode ${isPresetTrade ? "enabled" : "disabled"}`,
    })
  } catch (error) {
    console.error("[v0] [Preset Trade] Exception:", error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/${connectionId}/preset-toggle`)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to toggle preset trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
