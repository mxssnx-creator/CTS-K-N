import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { checkProductionReadiness, productionReadinessJson } from "@/lib/production-readiness"
import { allocateStateSwitchVersion } from "@/lib/engine-refresh-queue"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"

export const dynamic = "force-dynamic"

// RUNTIME FIX: Patch IndicationProcessor cache on every API call
// This fixes the "Cannot read properties of undefined (reading 'get')" error

function isLiveTradeRequested(connection: any): boolean {
  const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "true"
  const requested = connection?.live_trade_requested
  return truthy(requested) || truthy(connection?.is_live_trade) || truthy(connection?.live_trade_enabled)
}

function validateLiveTradeRequirements(connection: any): { valid: boolean; reason: string; blockCode: string | null } {
  // Global Start is a state-reconciliation operation, not a venue health test.
  // Gating it on testConnection() made one transient API/rate-limit failure
  // disable Live for the whole run and added up to 30 seconds per connection.
  // Re-evaluate the intended ON state with generated/stale block text cleared;
  // the live stage repeats this exact gate immediately before placeOrder().
  const readiness = evaluateRealTradeReadiness({
    ...(connection || {}),
    is_live_trade: "1",
    live_trade_requested: "1",
    live_trade_blocked_reason: "",
  })
  return {
    valid: readiness.canPlaceRealOrders,
    reason: readiness.blockReason,
    blockCode: readiness.blockCode,
  }
}

function patchIndicationProcessorCaches(coordinator: any) {
  if (!coordinator) return
  
  try {
    // Access all engine managers and patch their indication processors
    const engines = coordinator.engines || coordinator._engines || new Map()
    for (const [, manager] of engines) {
      if (manager?.indicationProcessor) {
        const proc = manager.indicationProcessor
        if (!proc.marketDataCache || !(proc.marketDataCache instanceof Map)) {
          proc.marketDataCache = new Map()
          console.log("[v0] [CacheFix] Patched marketDataCache for indication processor")
        }
        if (!proc.settingsCache) {
          proc.settingsCache = { data: null, timestamp: 0 }
        }
        if (!proc.CACHE_TTL) {
          proc.CACHE_TTL = 500
        }
      }
    }
  } catch (e) {
    console.warn("[v0] [CacheFix] Error patching caches:", e)
  }
}

/**
 * POST /api/trade-engine/start
 * Start the Global Trade Engine Coordinator (independent of any connections)
 * 
 * The Global Coordinator is the overall control system.
 * Individual connection engines (Main and Preset) are controlled separately via:
 * - /api/settings/connections/[id]/live-trade (Main Engine)
 * - /api/settings/connections/[id]/preset-toggle (Preset Engine)
 */
export async function POST(request: NextRequest) {
  try {
    console.log("[v0] [Trade Engine] Starting Global Trade Engine Coordinator (independent of connections)")
    
    // Do NOT clear global engine timers on Start.  In production a redundant
    // Start click or route warm-reload can hit while a coordinator is already
    // healthy; clearing timers here kills live processors and leaves managers
    // reporting "running" with stalled progress.  Explicit Stop remains the
    // only route that tears down timers/managers.
    
    await SystemLogger.logTradeEngine(`Starting Global Coordinator`, "info")

    const coordinator = getGlobalTradeEngineCoordinator()
    
    if (!coordinator) {
      return NextResponse.json({ error: "Coordinator not initialized" }, { status: 503 })
    }

    // Initialize Redis and verify production readiness before any engine start intent is committed.
    await initRedis()
    const readiness = await checkProductionReadiness()
    if (!readiness.ready) {
      return NextResponse.json(productionReadinessJson(readiness), { status: 503 })
    }
    const client = getRedisClient()
    
    // DOUBLE-START GUARD: Check if already running to prevent concurrent startup issues.
    // Do not return early here: production can have trade_engine:global.status
    // "running" while the selected connection engine was stopped/crashed or
    // lives in another worker. A Start click must reconcile missing engines.
    let wasAlreadyRunning = false
    try {
      const currentStatus = await client.hget("trade_engine:global", "status")
      if (currentStatus === "running") {
        wasAlreadyRunning = true
        console.log("[v0] [Trade Engine] Global state already running — reconciling missing engines instead of returning early")
      }
    } catch (e) {
      console.warn("[v0] [Trade Engine] Double-start check failed (continuing anyway):", e)
    }
    
    // Set global state in Redis (write-through to Upstash via persistent key prefix)
    // CRITICAL: clear `operator_stopped` so the migration bootstrap stops
    // honouring a prior explicit halt. Without this, a subsequent module
    // reload would re-respect the stop flag and refuse to bootstrap
    // engines, even though the operator just pressed Start.
    await client.hset("trade_engine:global", { 
      status: "running", 
      desired_status: "running",
      operator_intent: "running",
      started_at: new Date().toISOString(),
      coordinator_ready: "true",
      operator_stopped: "0",
      operator_stopped_at: "",
      stopped_at: "",
    })
    
    console.log("[v0] [Trade Engine] Global Coordinator state saved to Redis + Upstash: status=running")

    // Sync only the panel-assignment flag for engines that are already running.
    // Never backfill is_enabled_dashboard here: it is the explicit processing
    // switch and legacy is_active_inserted=1 rows must not be auto-enabled.
    try {
      const { getAllConnections, updateConnection: updateConn } = await import("@/lib/redis-db")
      const runningIds: Set<string> = new Set()
      // The coordinator is stored at globalThis.__tradeEngineCoordinator and
      // tracks running engines in its private `engineManagers` Map. Access it
      // through the globalThis singleton so we always hit the live instance.
      const liveCoord: any =
        (globalThis as any).__tradeEngineCoordinator ?? coordinator
      const engines: Map<string, unknown> =
        liveCoord?.engineManagers ??
        (coordinator as any).engineManagers ??
        new Map()
      for (const [connId] of engines) runningIds.add(String(connId))
      console.log(`[v0] [Trade Engine] Flag sync: found ${runningIds.size} running engine(s): ${[...runningIds].join(", ")}`)
      if (runningIds.size > 0) {
        const allConns = await getAllConnections()
        for (const conn of allConns) {
          if (!runningIds.has(conn.id)) continue
          const needsUpdate = conn.is_active_inserted !== "1" && conn.is_active_inserted !== true
          if (needsUpdate) {
            await updateConn(conn.id, { is_active_inserted: "1", is_assigned: "1" })
            console.log(`[v0] [Trade Engine] Synced assignment flags for running engine: ${conn.id}`)
          }
        }
      }
    } catch (flagSyncErr) {
      console.warn("[v0] [Trade Engine] Flag sync warning:", flagSyncErr instanceof Error ? flagSyncErr.message : flagSyncErr)
    }

    // Auto-resume and start assigned Main connections while preserving the
    // operator's Live Trade intent. Starting the Main engine must never turn a
    // previously-disabled live switch back on.
    let resumedConnections: string[] = []
    let startedConnections: string[] = []
    let liveTradeEnabledConnections: string[] = []
    let liveTradeRequestedConnections: string[] = []
    try {
      const { getConnection, updateConnectionState, getAllConnections } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")
      const settings = await loadSettingsAsync()
      
      // First resume paused connections
      const pausedRaw = await client.get("trade_engine:paused_connections")
      if (pausedRaw) {
        const pausedIds: string[] = JSON.parse(String(pausedRaw))
        
        for (const connId of pausedIds) {
          try {
            const conn = await getConnection(connId)
            if (conn && conn.paused_by_global === "1") {
              const liveTradeRequested = isLiveTradeRequested(conn)
              const staleLiveTradeBlockReason = String((conn as any).live_trade_blocked_reason || "").trim()
              const credentialCheck = liveTradeRequested
                ? validateLiveTradeRequirements(conn)
                : { valid: false, reason: "", blockCode: null }
              const liveTradeUpdate = liveTradeRequested
                ? credentialCheck.valid
                  ? {
                      is_live_trade: "1",
                      live_trade_blocked_reason: "",
                      live_trade_requested: "1",
                    }
                  : {
                      is_live_trade: "0",
                      live_trade_blocked_reason: credentialCheck.reason,
                      live_trade_requested: "1",
                    }
                : {
                    is_live_trade: "0",
                    live_trade_blocked_reason: "",
                    live_trade_requested: "0",
                  }

              const stateSwitchVersion = await allocateStateSwitchVersion(connId, conn)
              const transition = await updateConnectionState(connId, {
                ...liveTradeUpdate,
                paused_by_global: "0",
                state_switch_version: stateSwitchVersion,
                state_switch_action: "global_start",
                updated_at: new Date().toISOString(),
              }, stateSwitchVersion)
              if (!transition.applied) continue
              if (staleLiveTradeBlockReason && liveTradeRequested) {
                await logProgressionEvent(
                  connId,
                  "live_trading",
                  credentialCheck.valid ? "info" : "warning",
                  credentialCheck.valid
                    ? "Global start resumed live trading and cleared the stale block."
                    : `Global start kept live trading blocked after revalidation: ${credentialCheck.reason}`,
                  {
                    previous_block_reason: staleLiveTradeBlockReason,
                    live_trade_blocked_reason: credentialCheck.reason || undefined,
                  },
                )
              }
              if (liveTradeRequested) {
                await logProgressionEvent(
                  connId,
                  credentialCheck.valid ? "global_start_live_trade_enabled" : "global_start_live_trade_requested",
                  credentialCheck.valid ? "info" : "warning",
                  credentialCheck.valid
                    ? "Live trading enabled by global start"
                    : "Live trading requested by global start, but exchange order placement remains blocked",
                  {
                    connectionId: connId,
                    connectionName: conn.name,
                    liveTradeRequested: true,
                    liveTradeEnabled: credentialCheck.valid,
                    liveTradeBlockedReason: credentialCheck.reason || undefined,
                    liveTradeBlockCode: credentialCheck.blockCode || undefined,
                  },
                )
              }
              
              // Restart the engine
              await coordinator.startEngine(connId, {
                connectionId: connId,
                connection_name: conn.name,
                exchange: conn.exchange,
                engine_type: "main",
                allowInProcessStart: true,
                indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
                strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
                realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
              }, { markAssigned: true, forceLocalTakeover: true })
              
              if (liveTradeRequested && credentialCheck.valid) {
                liveTradeEnabledConnections.push(connId)
              } else if (liveTradeRequested) {
                liveTradeRequestedConnections.push(connId)
              }
              resumedConnections.push(connId)
              console.log(
                `[v0] [Trade Engine] Resumed paused connection: ${connId} ${conn.name} ` +
                `(live_trade_${!liveTradeRequested ? "disabled" : credentialCheck.valid ? "enabled" : "requested_only"}${credentialCheck.reason ? `: ${credentialCheck.reason}` : ""})`,
              )
            }
          } catch (resumeErr) {
            console.warn("[v0] [Trade Engine] Failed to resume connection:", connId, resumeErr)
          }
        }
        
        // Clear the paused main list
        await client.del("trade_engine:paused_connections")
      }
      
      // ALSO: Explicitly start ALL assigned main connections that are enabled (quickstart fixes)
      const allConnections = await getAllConnections()
      for (const conn of allConnections) {
        // Only handle assigned main connections that are enabled
        if (conn.is_assigned === "1" && conn.is_enabled_dashboard === "1" &&
            !resumedConnections.includes(conn.id)) {
          try {
            const liveTradeRequested = isLiveTradeRequested(conn)
            const staleLiveTradeBlockReason = String((conn as any).live_trade_blocked_reason || "").trim()
            const credentialCheck = liveTradeRequested
              ? validateLiveTradeRequirements(conn)
              : { valid: false, reason: "", blockCode: null }
            if (liveTradeRequested) {
              const stateSwitchVersion = await allocateStateSwitchVersion(conn.id, conn)
              const updatedConn = {
                is_live_trade: credentialCheck.valid ? "1" : "0",
                live_trade_blocked_reason: credentialCheck.valid ? "" : credentialCheck.reason,
                live_trade_requested: "1",
                state_switch_version: stateSwitchVersion,
                state_switch_action: "global_start",
                updated_at: new Date().toISOString(),
              }
              const transition = await updateConnectionState(conn.id, updatedConn, stateSwitchVersion)
              if (!transition.applied) continue
              if (staleLiveTradeBlockReason) {
                await logProgressionEvent(
                  conn.id,
                  "live_trading",
                  credentialCheck.valid ? "info" : "warning",
                  credentialCheck.valid
                    ? "Global start enabled live trading and cleared the stale block."
                    : `Global start kept live trading blocked after revalidation: ${credentialCheck.reason}`,
                  {
                    previous_block_reason: staleLiveTradeBlockReason,
                    live_trade_blocked_reason: credentialCheck.reason || undefined,
                  },
                )
              }
              await logProgressionEvent(
                conn.id,
                credentialCheck.valid ? "global_start_live_trade_enabled" : "global_start_live_trade_requested",
                credentialCheck.valid ? "info" : "warning",
                credentialCheck.valid
                  ? "Live trading enabled by global start"
                  : "Live trading requested by global start, but exchange order placement remains blocked",
                {
                  connectionId: conn.id,
                  connectionName: conn.name,
                  liveTradeRequested: true,
                  liveTradeEnabled: credentialCheck.valid,
                  liveTradeBlockedReason: credentialCheck.reason || undefined,
                  liveTradeBlockCode: credentialCheck.blockCode || undefined,
                },
              )
            }
            
            // Start the engine for this connection
            await coordinator.startEngine(conn.id, {
              connectionId: conn.id,
              connection_name: conn.name,
              exchange: conn.exchange,
              engine_type: "main",
              allowInProcessStart: true,
              indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
              strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
              realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
            }, { markAssigned: true, forceLocalTakeover: true })
            
            if (liveTradeRequested && credentialCheck.valid) {
              liveTradeEnabledConnections.push(conn.id)
            } else if (liveTradeRequested) {
              liveTradeRequestedConnections.push(conn.id)
            }
            startedConnections.push(conn.id)
            console.log(
              `[v0] [Trade Engine] Started assigned connection: ${conn.id} ${conn.name} ` +
              `(live_trade_${!liveTradeRequested ? "disabled" : credentialCheck.valid ? "enabled" : "requested_only"}${credentialCheck.reason ? `: ${credentialCheck.reason}` : ""})`,
            )
          } catch (startErr) {
            console.warn("[v0] [Trade Engine] Failed to start assigned connection:", conn.id, startErr)
          }
        }
      }
      
      // Also resume preset engines that were paused
      const pausedPresetRaw = await client.get("trade_engine:paused_preset_connections")
      if (pausedPresetRaw) {
        const pausedPresetIds: string[] = JSON.parse(String(pausedPresetRaw))
        const { getConnection: getConn2, updateConnectionState: updateConnState2 } = await import("@/lib/redis-db")
        
        for (const connId of pausedPresetIds) {
          try {
            const conn = await getConn2(connId)
            if (conn && conn.paused_preset_by_global === "1") {
              const stateSwitchVersion = await allocateStateSwitchVersion(connId, conn)
              const transition = await updateConnState2(connId, {
                is_preset_trade: "1",
                paused_preset_by_global: "0",
                state_switch_version: stateSwitchVersion,
                state_switch_action: "global_start_preset",
                updated_at: new Date().toISOString(),
              }, stateSwitchVersion)
              if (!transition.applied) continue
              
              // Update preset engine state in Redis
              if (conn.preset_type_id) {
                await client.hset(`preset_engine:${connId}:${conn.preset_type_id}`, {
                  status: "running",
                  updated_at: new Date().toISOString(),
                })
              }
              
              resumedConnections.push(connId + " (preset)")
              console.log("[v0] [Trade Engine] Resumed paused preset connection:", connId, conn.name)
            }
          } catch (resumeErr) {
            console.warn("[v0] [Trade Engine] Failed to resume preset connection:", connId, resumeErr)
          }
        }
        
        await client.del("trade_engine:paused_preset_connections")
      }
    } catch (resumeError) {
      console.warn("[v0] [Trade Engine] Failed to check paused connections:", resumeError)
    }

    // Start/refresh the remaining coordinator workers only after every assigned
    // connection's requested/effective live state has been revalidated and
    // durably written. Starting first creates a race where an engine can consume
    // a stale live flag and route an early cycle through the wrong execution mode.
    try {
      await coordinator.startAll()
      await coordinator.refreshEngines()
      patchIndicationProcessorCaches(coordinator)
      console.log("[v0] [Trade Engine] Coordinator workers started and refreshed with cache fix applied")
    } catch (engineStartError) {
      console.warn("[v0] [Trade Engine] Coordinator worker startup warning:", engineStartError)
    }

    const resumeMsg = resumedConnections.length > 0
      ? ` Resumed ${resumedConnections.length} previously paused connection(s).`
      : ""
    const startedMsg = startedConnections.length > 0
      ? ` Started ${startedConnections.length} assigned connection(s).`
      : ""
    const liveTradeMsg = liveTradeEnabledConnections.length > 0 || liveTradeRequestedConnections.length > 0
      ? ` Live trading enabled for ${liveTradeEnabledConnections.length} connection(s); requested-only for ${liveTradeRequestedConnections.length} connection(s).`
      : ""
    
    console.log("[v0] [Trade Engine] Global Coordinator is running and ready." + resumeMsg + startedMsg + liveTradeMsg)
    await SystemLogger.logTradeEngine(
      `Global Coordinator started.${resumeMsg}${startedMsg}${liveTradeMsg}`,
      "info",
      { resumedConnections, startedConnections, liveTradeEnabledConnections, liveTradeRequestedConnections }
    )

    return NextResponse.json({
      success: true,
      message: `Global Trade Engine Coordinator started and ready.${resumeMsg}${startedMsg}${liveTradeMsg}`,
      coordinator_status: "running",
      alreadyRunning: wasAlreadyRunning,
      resumedConnections,
      startedConnections,
      liveTradeEnabledConnections,
      liveTradeRequestedConnections,
    })

  } catch (error) {
    console.error("[v0] Failed to start Global Coordinator:", error)
    await SystemLogger.logError(error, "trade-engine", "POST /api/trade-engine/start")

    return NextResponse.json(
      {
        error: "Failed to start Global Coordinator",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
