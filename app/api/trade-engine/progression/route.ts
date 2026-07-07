import { NextResponse } from "next/server"
import { getActiveConnectionsForEngine, getConnectionTrades, getConnectionPositions, initRedis, getRedisClient } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

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

    console.log("[v0] [ProgressionEngine] Fetching real-time trade engine progression data")
    
    try {
      await initRedis()
    } catch (redisInitError) {
      console.error("[v0] Failed to initialize Redis:", redisInitError)
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
    console.log(`[v0] [ProgressionEngine] Processing ${activeConnections.length} active connections`)
    
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
    const progressionData = await Promise.allSettled(
      activeConnections.map(async (conn) => {
        try {
          // OPTIMIZATION: Batch load all data in parallel per connection
          const [trades, positions, progressionState, engineStatus] = await Promise.all([
            getConnectionTrades(conn.id).catch(() => []),
            getConnectionPositions(conn.id).catch(() => []),
            ProgressionStateManager.getProgressionState(conn.id).catch(() => ProgressionStateManager.getDefaultState(conn.id)),
            coordinator.getEngineStatus(conn.id).catch(() => null),
          ])

          const tradeCount = trades?.length || 0
          const pseudoCount = positions?.length || 0
          const isEngineRunning = engineStatus !== null
          const engineState = isEngineRunning ? "running" : "idle"
          const updatedAt = progressionState.lastUpdate?.toISOString?.() || null
          const prehistoricLoaded = (progressionState.prehistoricCyclesCompleted || 0) > 0
          
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning,
            engineState,
            tradeCount,
            pseudoPositionCount: pseudoCount,
            prehistoricDataLoaded: prehistoricLoaded,
            lastUpdate: updatedAt,
            progression: {
              cyclesCompleted: progressionState.cyclesCompleted,
              successfulCycles: progressionState.successfulCycles,
              failedCycles: progressionState.failedCycles,
              cycleSuccessRate: progressionState.cycleSuccessRate,
              totalTrades: progressionState.totalTrades,
              successfulTrades: progressionState.successfulTrades,
              totalProfit: progressionState.totalProfit,
              indicationsDirectionCount: progressionState.indicationsDirectionCount || 0,
              indicationsMoveCount: progressionState.indicationsMoveCount || 0,
              indicationsActiveCount: progressionState.indicationsActiveCount || 0,
              indicationsOptimalCount: progressionState.indicationsOptimalCount || 0,
              strategiesBaseTotal: progressionState.strategiesBaseTotal || 0,
              strategiesMainTotal: progressionState.strategiesMainTotal || 0,
              strategiesRealTotal: progressionState.strategiesRealTotal || 0,
            },
          }
        } catch (err) {
          console.warn(`[v0] Error processing ${conn.id}:`, err instanceof Error ? err.message : String(err))
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
    console.error("[v0] [ProgressionEngine] Critical error:", error)
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
