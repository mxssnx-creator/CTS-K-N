import { NextResponse } from "next/server"
import { getActiveConnectionsForEngine, getConnectionTrades, getConnectionPositions, initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"
import { buildProgressionScope } from "@/lib/progression-scope"

export const dynamic = "force-dynamic"

// In-memory cache for progression data (3 second TTL for high-frequency access)
const progressionCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 3000 // 3 seconds for high-frequency updates
const MAX_CACHE_SIZE = 50 // Max entries to prevent memory bloat

function cleanCache(cache: Map<string, any>) {
  // Remove expired entries
  const now = Date.now()
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key)
    }
  }
  
  // If still too large, clear oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const sortedEntries = Array.from(cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
    
    const toDelete = sortedEntries.slice(0, cache.size - MAX_CACHE_SIZE)
    toDelete.forEach(([key]) => cache.delete(key))
  }
}

export async function GET() {
  try {
    // Clean cache to prevent memory bloat
    cleanCache(progressionCache)
    
    // Check cache first for ultra-fast responses
    const cacheKey = "progression_all"
    const cached = progressionCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.data)
    }

    try {
      await initRedis()
    } catch (redisInitError) {
      console.error("[ProgressionEngine] Failed to initialize Redis:", redisInitError)
      return NextResponse.json({
        success: false,
        error: "Redis initialization failed",
        connections: [],
        totalConnections: 0,
        runningEngines: 0,
        timestamp: new Date().toISOString(),
      }, { status: 503 })
    }
    
    const activeConnections = await getActiveConnectionsForEngine()
    
    // Import the global coordinator for engine status
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    
    if (!coordinator) {
      const response = {
        success: true,
        connections: [],
        totalConnections: 0,
        runningEngines: 0,
        timestamp: new Date().toISOString(),
      }
      progressionCache.set(cacheKey, { data: response, timestamp: Date.now() })
      return NextResponse.json(response)
    }
    
    // OPTIMIZATION: Use Promise.allSettled for high-frequency non-blocking parallel execution
    const redis = getRedisClient()
    const globalEngineState: Record<string, string> =
      (await redis.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>))) || {}
    const globalIntent =
      globalEngineState.operator_intent ||
      globalEngineState.desired_status ||
      globalEngineState.status ||
      "stopped"
    const globalRunning = globalIntent === "running"
    const globalPaused = globalIntent === "paused"
    const progressionData = await Promise.allSettled(
      activeConnections.map(async (conn) => {
        try {
          const engineType = String((conn as any).engine_type || (conn as any).engineType || "main").trim() || "main"
          const scope = buildProgressionScope(conn.id, engineType)
          // OPTIMIZATION: Batch load all data in parallel per connection
          const [
            trades,
            positions,
            progressionState,
            runtimeState,
            settingsRuntimeState,
            scopedRuntimeState,
            scopedSettingsRuntimeState,
            storedProgression,
          ] = await Promise.all([
            getConnectionTrades(conn.id).catch(() => []),
            getConnectionPositions(conn.id).catch(() => []),
            ProgressionStateManager.getProgressionState(conn.id, engineType).catch(() => ProgressionStateManager.getDefaultState(conn.id)),
            redis.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)),
            redis.hgetall(`settings:trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)),
            redis.hgetall(`trade_engine_state:${conn.id}:${engineType}`).catch(() => ({} as Record<string, string>)),
            redis.hgetall(scope.tradeEngineStateKey).catch(() => ({} as Record<string, string>)),
            Promise.all([
              getSettings(`engine_progression:${conn.id}`).catch(() => ({})),
              getSettings(scope.engineProgressionKey).catch(() => ({})),
            ]).then(([legacy, scoped]) => ({ ...(legacy || {}), ...(scoped || {}) })),
          ])

          const tradeCount = trades?.length || 0
          const pseudoCount = positions?.length || 0
          const localManagerRunning = coordinator.isEngineRunning(conn.id)
          const enabledForProcessing = conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "1"
          const distributedRuntime = resolveDistributedEngineRuntime({
            runningHint: localManagerRunning ? true : null,
            states: [
              runtimeState,
              settingsRuntimeState,
              scopedRuntimeState,
              scopedSettingsRuntimeState,
            ],
            globalState: globalEngineState,
            connectionEnabled: enabledForProcessing,
          })
          // A manager object can outlive a stopped engine. `getEngineStatus()`
          // returning any object is therefore not liveness proof; require this
          // connection's running manager or a fresh distributed heartbeat.
          const isEngineRunning =
            globalRunning && !globalPaused &&
            (localManagerRunning || distributedRuntime.running)
          const engineState = isEngineRunning
            ? "running"
            : globalPaused
              ? "paused"
              : globalRunning && enabledForProcessing
                ? "initializing"
                : "idle"
          const updatedAt = progressionState.lastUpdate?.toISOString?.() || null
          // prehistoricDataLoaded: true when at least one prehistoric pass has
          // completed (cyclesCompleted > 0) OR the engine has already processed
          // the historic candle set (symbolsProcessedCount > 0).
          const prehistoricLoaded =
            (progressionState.prehistoricCyclesCompleted || 0) > 0 ||
            (progressionState.prehistoricSymbolsProcessedCount || 0) > 0

          // Compute trade success rate from authoritative merged counters rather
          // than trusting the stored scalar which may come from a stale key.
          const totalTrades = progressionState.totalTrades || 0
          const successfulTrades = progressionState.successfulTrades || 0
          const computedTradeSuccessRate =
            totalTrades > 0 ? Math.round((successfulTrades / totalTrades) * 10000) / 100 : 0
          const cyclesCompleted = progressionState.cyclesCompleted || 0
          const successfulCycles = progressionState.successfulCycles || 0
          const computedCycleSuccessRate =
            cyclesCompleted > 0 ? Math.round((successfulCycles / cyclesCompleted) * 10000) / 100 : 0
          const engineProgression =
            isEngineRunning &&
            String((storedProgression as any)?.phase || "") === "live_trading" &&
            Number((storedProgression as any)?.progress || 0) >= 100
              ? {
                  ...(storedProgression || {}),
                  status: "running",
                  needs_reconcile: false,
                  orphan_cleanup_pending: false,
                  orphan_cleanup_reason: "",
                }
              : storedProgression || {}

          return {
            connectionId: conn.id,
            engineType,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning,
            engineState,
            runtimeReason: distributedRuntime.reason,
            heartbeatFresh: distributedRuntime.heartbeatFresh,
            heartbeatAgeMs: distributedRuntime.heartbeatAgeMs,
            engineProgression,
            tradeCount,
            pseudoPositionCount: pseudoCount,
            prehistoricDataLoaded: prehistoricLoaded,
            lastUpdate: updatedAt,
            progression: {
              cyclesCompleted,
              successfulCycles,
              failedCycles: progressionState.failedCycles,
              cycleSuccessRate: computedCycleSuccessRate,
              totalTrades,
              successfulTrades,
              totalProfit: progressionState.totalProfit,
              tradeSuccessRate: computedTradeSuccessRate,
              indicationsDirectionCount: progressionState.indicationsDirectionCount || 0,
              indicationsMoveCount: progressionState.indicationsMoveCount || 0,
              indicationsActiveCount: progressionState.indicationsActiveCount || 0,
              indicationsActiveAdvancedCount: progressionState.indicationsActiveAdvancedCount || 0,
              indicationsOptimalCount: progressionState.indicationsOptimalCount || 0,
              indicationsAutoCount: progressionState.indicationsAutoCount || 0,
              indicationsSignalCount: progressionState.indicationsSignalCount || 0,
              indicationsTrendCount: progressionState.indicationsTrendCount || 0,
              strategiesBaseTotal: progressionState.strategiesBaseTotal || 0,
              strategiesMainTotal: progressionState.strategiesMainTotal || 0,
              strategiesRealTotal: progressionState.strategiesRealTotal || 0,
              strategyEvaluatedBase: progressionState.strategyEvaluatedBase || 0,
              strategyEvaluatedMain: progressionState.strategyEvaluatedMain || 0,
              strategyEvaluatedReal: progressionState.strategyEvaluatedReal || 0,
              indicationCycleCount: progressionState.indicationCycleCount || 0,
              strategyCycleCount: progressionState.strategyCycleCount || 0,
              realtimeCycleCount: progressionState.realtimeCycleCount || 0,
              indicationsCount: progressionState.indicationsCount || 0,
              strategiesCount: progressionState.strategiesCount || 0,
            },
          }
        } catch (err) {
          console.warn(`[ProgressionEngine] Error processing ${conn.id}:`, err instanceof Error ? err.message : String(err))
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEngineRunning: false,
            engineState: 'error',
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })
    )

    // Extract successful results, skip failed ones gracefully
    const results = progressionData.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value)
    
    const response = {
      success: true,
      connections: results,
      totalConnections: results.length,
      runningEngines: results.filter(c => c.isEngineRunning).length,
      timestamp: new Date().toISOString(),
    }
    
     // Cache the response for 5 seconds
    progressionCache.set(cacheKey, { data: response, timestamp: Date.now() })
    
    return NextResponse.json(response)
  } catch (error) {
    console.error("[ProgressionEngine] Critical error:", error)
    await SystemLogger.logError(error, "api", "GET /api/trade-engine/progression").catch(() => {})
    return NextResponse.json({ 
      success: false,
      error: "Failed to fetch progression",
      details: error instanceof Error ? error.message : String(error),
      connections: [],
      totalConnections: 0,
      runningEngines: 0,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}
