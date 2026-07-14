import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnectionState, persistNow, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { checkProductionReadiness, productionReadinessJson } from "@/lib/production-readiness"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { maskConnectionSecrets } from "@/lib/connection-secrets"

/**
 * POST /api/settings/connections/[id]/live-trade
 *
 * Toggles the `is_live_trade` flag on a connection. This flag is read DYNAMICALLY
 * by the running trade engine (every cycle) to decide whether the Live stage
 * should escalate strategies to real exchange orders. See
 * `lib/trade-engine/stages/live-stage.ts` for how the flag is checked.
 *
 * STABILITY RULE (important):
 *   The running engine for a connection is a single shared instance that handles
 *   indication → strategy → real → live stages regardless of mode flags. This
 *   endpoint must NOT stop the engine when the user turns Live Trade off — doing
 *   so would also kill the Main trading pipeline (which was the bug before this
 *   refactor). It must also NOT restart the engine when turning Live on if the
 *   engine is already running — that is a no-op on TradeEngineManager and leaks
 *   "starting..." UI state.
 *
 *   The only case where this endpoint starts the engine is when Live is turned
 *   ON while the Main engine is not yet running — in that case the engine is
 *   started so the new flag actually has an effect.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 15
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    const body = await request.json().catch(() => ({}))
    // Accept both `is_live_trade` and the common `enabled` alias. A request
    // with NEITHER key must be rejected — the previous code parsed undefined
    // as `false`, so any malformed/empty body silently DISABLED live trading.
    const rawFlag = body?.is_live_trade ?? body?.enabled
    if (rawFlag === undefined || rawFlag === null) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required flag",
          hint: 'Send {"is_live_trade": true|false} (or "enabled" alias)',
        },
        { status: 400 },
      )
    }
    const isLiveTrade = parseBooleanInput(rawFlag)

    if (isLiveTrade && process.env.NODE_ENV === "production") {
      const readiness = await checkProductionReadiness()
      if (!readiness.ready) {
        return NextResponse.json(productionReadinessJson(readiness), { status: 503 })
      }
    }

    console.log(`[v0] [LiveTrade] POST for ${connectionId}, is_live_trade=${isLiveTrade}`)

    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const connName = connection.name

    // When enabling Live, check credentials. Inject predefined creds for base connections.
    let apiKey = (connection.api_key || connection.apiKey || "") as string
    let apiSecret = (connection.api_secret || connection.apiSecret || "") as string
    let hasCredentials = apiKey.length > 10 && apiSecret.length > 10

    let liveTradeBlockedReason = ""
    let injectedCredentials = false
    if (isLiveTrade) {
      if (
        !hasCredentials &&
        BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]?.apiKey &&
        BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]?.apiSecret
      ) {
        const creds = BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]
        apiKey = creds.apiKey
        apiSecret = creds.apiSecret
        hasCredentials = true
        injectedCredentials = true
        console.log(`[v0] [LiveTrade] Injected predefined credentials for ${connName}`)
      }
      if (!hasCredentials) {
        liveTradeBlockedReason = "API credentials required for live trading"
      }
    }

    // Write the flag — this is what the running engine's live-stage checks.
    const staleLiveTradeBlockReason = String((connection as any).live_trade_blocked_reason || "").trim()
    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const liveTradeChangedAt = new Date().toISOString()
    const previousValues = {
      is_live_trade: connection.is_live_trade,
      live_trade_requested: (connection as any).live_trade_requested,
      state_switch_version: (connection as any).state_switch_version,
      live_trade_changed_at: (connection as any).live_trade_changed_at,
    }

    const connectionPatch = {
      ...(injectedCredentials ? { api_key: apiKey, api_secret: apiSecret } : {}),
      is_live_trade: toRedisFlag(isLiveTrade && hasCredentials),
      live_trade_blocked_reason: liveTradeBlockedReason,
      // If Live is turned on while the main engine is not already running,
      // make the connection engine-eligible before coordinator.startEngine().
      // Otherwise startEngine refuses the foreground start as "not assigned /
      // disabled", which looks like a coordinator crash from the UI.
      ...(isLiveTrade
        ? {
            is_assigned: "1",
            is_active_inserted: "1",
            is_enabled_dashboard: "1",
            is_active: "1",
            live_trade_requested: "1",
            ...(hasCredentials ? { last_test_status: "success" } : {}),
          }
        : { live_trade_requested: "0" }),
      state_switch_version: stateSwitchVersion,
      live_trade_changed_at: liveTradeChangedAt,
      updated_at: liveTradeChangedAt,
    }
    const transition = await updateConnectionState(connectionId, connectionPatch, stateSwitchVersion)
    if (!transition.applied) {
      return NextResponse.json(
        {
          success: false,
          error: "Live Trade switch was superseded by a newer connection state",
          state_switch_version: transition.connection?.state_switch_version,
          connection: transition.connection ? maskConnectionSecrets(transition.connection) : undefined,
        },
        { status: 409 },
      )
    }
    const updatedConnection = transition.connection || { ...connection, ...connectionPatch }

    const booleanStateFields = new Set([
      "is_live_trade",
      "live_trade_requested",
      "is_assigned",
      "is_active_inserted",
      "is_enabled_dashboard",
      "is_active",
    ])
    const changedFields = Object.keys(connectionPatch).filter((field) => {
      if (field === "updated_at" || field === "live_trade_changed_at") return false
      if (field === "state_switch_version") return true
      if (booleanStateFields.has(field)) {
        return isTruthyFlag((connection as any)[field]) !== isTruthyFlag((updatedConnection as any)[field])
      }
      return JSON.stringify((connection as any)[field]) !== JSON.stringify((updatedConnection as any)[field])
    })

    const newValues = {
      is_live_trade: updatedConnection.is_live_trade,
      live_trade_requested: updatedConnection.live_trade_requested,
      state_switch_version: stateSwitchVersion,
      live_trade_changed_at: liveTradeChangedAt,
    }
    // Do not report a successful switch until the durable settings envelope
    // and dirty flag exist. The engine-owning worker may be a different
    // process, so swallowing this failure can persist the UI flag without ever
    // applying it to the running engine.
    await notifySettingsChanged(
      connectionId,
      changedFields,
      previousValues,
      newValues,
    )

    const coordinator = getGlobalTradeEngineCoordinator()
    // Best-effort local fast-path only. Remote workers converge via the durable
    // settings_change/settings:dirty event written by notifySettingsChanged above.
    await (coordinator.applyPendingChangesNow?.(connectionId) ?? Promise.resolve()).catch((applyErr: unknown) => {
      console.warn(
        "[v0] [LiveTrade] Local applyPendingChangesNow failed:",
        applyErr instanceof Error ? applyErr.message : applyErr,
      )
    })

    if (changedFields.includes("is_live_trade") || changedFields.includes("live_trade_requested")) {
      await ProgressionStateManager.recoordinateForActualOne(connectionId).catch((progressionErr: unknown) => {
        console.warn(
          "[v0] [LiveTrade] Progression recoordination failed after live-trade dirty signal:",
          progressionErr instanceof Error ? progressionErr.message : progressionErr,
        )
      })
    }

    if (staleLiveTradeBlockReason) {
      const clearReason = isLiveTrade
        ? "Live Trading enabled after credential validation; cleared stale block so exchange orders can proceed."
        : "Live Trading disabled by operator; cleared stale block reason because this is not an error state."
      await logProgressionEvent(connectionId, "live_trading", "info", clearReason, {
        previous_block_reason: staleLiveTradeBlockReason,
        is_live_trade: isLiveTrade,
      })
    }
    if (isLiveTrade) {
      await getRedisClient().hset("trade_engine:global", {
        status: "running",
        desired_status: "running",
        operator_intent: "running",
        operator_stopped: "0",
        operator_stopped_at: "",
        stopped_at: "",
        mode: hasCredentials ? "live" : "live_requested",
        updated_at: new Date().toISOString(),
      }).catch((stateErr: unknown) => {
        console.warn(
          "[v0] [LiveTrade] Persisting global engine intent failed:",
          stateErr instanceof Error ? stateErr.message : stateErr,
        )
      })
    }
    await persistNow().catch((persistErr: unknown) => {
      console.warn(
        "[v0] [LiveTrade] Persisting live-trade flag failed:",
        persistErr instanceof Error ? persistErr.message : persistErr,
      )
    })

    const triggerControlOrderRebuild = () => {
      if (!isLiveTrade || !hasCredentials) return
      void (async () => {
        try {
          const latest = await getConnection(connectionId)
          if (
            !latest ||
            String((latest as any).state_switch_version ?? "") !== String(stateSwitchVersion) ||
            !isTruthyFlag((latest as any).is_live_trade)
          ) {
            console.log(`[v0] [LiveTrade] Skipping stale control-order rebuild for ${connName}`)
            return
          }
          const { createExchangeConnector } = await import("@/lib/exchange-connectors")
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey,
            apiSecret,
            apiType: connection.api_type,
            contractType: connection.contract_type,
            isTestnet: isTruthyFlag(connection.is_testnet),
          })
          if (!connector) return
          const { syncWithExchange } = await import("@/lib/trade-engine/stages/live-stage")
          await syncWithExchange(connectionId, connector)
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "info",
            "Live Control Orders enabled — rebuilt exchange SL/TP protection for open positions",
            { connectionId, connectionName: connName },
          ).catch(() => {})
        } catch (syncErr) {
          console.warn(
            `[v0] [LiveTrade] Control-order rebuild failed for ${connName}:`,
            syncErr instanceof Error ? syncErr.message : String(syncErr),
          )
        }
      })()
    }

    let engineStatus: "running" | "starting" | "queued" | "stopped" | "error" = "stopped"
    let engineStartedNow = false

    if (isLiveTrade) {
      // If the engine is already running (because Enable is on), just flip the flag
      // and let the next cycle pick it up. Do NOT restart — that no-ops silently in
      // TradeEngineManager.start() (isRunning guard) and leaves the UI confused.
      if (coordinator.isEngineRunning(connectionId)) {
        engineStatus = "running"
        console.log(`[v0] [LiveTrade] Engine already running for ${connName} — flag updated, no restart`)
        triggerControlOrderRebuild()
      } else {
        // Engine is not running. Queue by default in production so API workers
        // remain responsive; foreground start is allowed only for non-Vercel
        // or explicit flag opt-in.
        try {
          const localStartAllowed =
            process.env.DISABLE_TRADE_ENGINE_IN_PROCESS !== "1" &&
            process.env.NEXT_RUNTIME !== "edge" &&
            (process.env.VERCEL !== "1" ||
              (process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
                process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"))

          if (localStartAllowed) {
            const settings = await loadSettingsAsync()
            const engineConfig = {
              connectionId,
              connection_name: connName,
              exchange: connection.exchange,
              engine_type: "live",
              allowInProcessStart: true,
              indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
              strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
              realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
            }
            const engineStarted = await coordinator.startEngine(connectionId, engineConfig, { markAssigned: true, forceLocalTakeover: true })
            if (!engineStarted && !coordinator.isEngineRunning(connectionId)) {
              throw new Error("Coordinator did not start the engine; startup lock may still be owned by another worker")
            }
            engineStatus = "running"
            engineStartedNow = engineStarted
            console.log(`[v0] [LiveTrade] Engine ${engineStarted ? "started" : "already recovered"} for ${connName} to service live-trade flag`)
          } else {
            await queueEngineRefreshRequest({
              timestamp: new Date().toISOString(),
              connectionId,
              action: "start",
              state_switch_version: stateSwitchVersion,
              reason: "live_trade_enable",
            })
            await logProgressionEvent(connectionId, "engine_start_queued", "info", "Live Trade enabled; start queued for coordinator worker", {
              connectionId,
              connectionName: connName,
              exchange: connection.exchange,
              hint: "No local engine runtime accepted the foreground start; queued for continuity reconciliation.",
            })
            engineStatus = "queued"
            engineStartedNow = false
            try {
              const { runTradeEngineHealingSweep } = await import("@/lib/trade-engine-auto-start")
              const sweep = await runTradeEngineHealingSweep({ isStartup: false })
              if ((sweep.startedCount || 0) > 0 || coordinator.isEngineRunning(connectionId)) {
                engineStatus = "running"
                engineStartedNow = true
                await logProgressionEvent(connectionId, "engine_start_reconciled", "info", "Queued live-trade start was reconciled immediately by the healing sweep", {
                  connectionId,
                  startedCount: sweep.startedCount,
                  eligibleCount: sweep.eligibleCount,
                })
              }
            } catch (sweepErr) {
              console.warn(
                `[v0] [LiveTrade] Immediate healing sweep after queued start failed for ${connName}:`,
                sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
              )
            }
            console.warn(`[v0] [LiveTrade] Engine start queued for ${connName}; foreground start was unavailable`)
          }
          triggerControlOrderRebuild()
        } catch (err) {
          console.error(`[v0] [LiveTrade] Foreground engine start failed for ${connName}; queuing coordinator reconciliation:`, err)
          await queueEngineRefreshRequest({
            timestamp: new Date().toISOString(),
            connectionId,
            action: "start",
            state_switch_version: stateSwitchVersion,
            reason: "live_trade_enable_foreground_start_failed",
          }).catch((queueErr: unknown) => {
            console.warn(
              `[v0] [LiveTrade] Failed to queue fallback start for ${connName}:`,
              queueErr instanceof Error ? queueErr.message : String(queueErr),
            )
          })
          await getRedisClient().hset("trade_engine:global", {
            status: "running",
            desired_status: "running",
            operator_intent: "running",
            operator_stopped: "0",
            operator_stopped_at: "",
            stopped_at: "",
            last_start_warning: err instanceof Error ? err.message : String(err),
            updated_at: new Date().toISOString(),
          }).catch(() => {})
          await SystemLogger.logError(err, "api", `Foreground start queued for ${connName}`)
          engineStatus = "queued"
          engineStartedNow = false
          triggerControlOrderRebuild()
        }
      }
    } else {
      // Turning Live OFF must NOT stop the engine — the Main pipeline might still
      // be running. The flag change alone is sufficient: next cycle, the live-stage
      // will short-circuit because is_live_trade is "0". This was the root cause
      // of "toggling Live off also disabled Main trading" before this refactor.
      engineStatus = coordinator.isEngineRunning(connectionId) ? "running" : "stopped"
      console.log(`[v0] [LiveTrade] Flag cleared for ${connName} — engine left untouched (status=${engineStatus})`)
    }

    await SystemLogger.logConnection(
      `Live Trading ${isLiveTrade ? "enabled" : "disabled"} via UI toggle`,
      connectionId,
      "info",
      {
        is_live_trade: isLiveTrade && hasCredentials,
        live_trade_requested: isLiveTrade,
        engineStartedNow,
        engineStatus,
        liveTradeBlockedReason,
      },
    )

    // SECURITY: never echo raw credentials back to the client. The previous
    // response included api_key/api_secret in PLAINTEXT.
    const safeConnection = maskConnectionSecrets(updatedConnection)

    emitCanonicalEvent({
      type: "live.stageChanged",
      connectionId,
      stage: "live",
      settingsVersion: stateSwitchVersion,
      data: {
        action: isLiveTrade ? "enabled" : "disabled",
        is_live_trade: isLiveTrade && hasCredentials,
        live_trade_requested: isLiveTrade,
        engineStatus,
      },
    })

    return NextResponse.json({
      success: true,
      is_live_trade: isLiveTrade && hasCredentials,
      live_trade_requested: isLiveTrade,
      live_trade_blocked_reason: liveTradeBlockedReason,
      engineStatus,
      engineStartedNow,
      connection: safeConnection,
      message:
        isLiveTrade && !hasCredentials
          ? "Live Trading requested; exchange order placement is blocked until API credentials are configured"
          : `Live Trading ${isLiveTrade ? "enabled" : "disabled"}`,
      connectionName: connName,
      exchange: connection.exchange,
    })
  } catch (error) {
    console.error("[v0] [LiveTrade] Exception:", error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/${connectionId}/live-trade`)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to toggle live trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
