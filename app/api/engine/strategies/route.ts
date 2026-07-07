import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// High-performance cache for strategy data (3 second TTL)
const strategiesCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 3000
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

export async function GET(req: NextRequest) {
  try {
    // Clean cache to prevent memory bloat
    cleanCache(strategiesCache)
    
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connectionId") || searchParams.get("id")
    
    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId or id parameter required" },
        { status: 400 }
      )
    }
    
    // Check high-performance cache first
    const cacheKey = `strategies:${connectionId}`
    const cached = strategiesCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.data)
    }
    
    await initRedis()
    const redis = getRedisClient()
    
    if (!redis) {
      return NextResponse.json(
        { error: "Redis not available" },
        { status: 503 }
      )
    }
    
    try {
      // OPTIMIZATION: Query only the aggregated strategy counts (no SCAN to avoid hangs)
      // Use specific Redis keys pattern instead of full SCAN
      let baseStrategyCount = 0
      let mainStrategyCount = 0
      let realStrategyCount = 0
      let evaluatedBase = 0
      let evaluatedMain = 0
      let evaluatedReal = 0
      
      // Query aggregated counts stored in Redis by the engine
      try {
        const aggregatedKey = `strategies:${connectionId}:aggregated`
        const aggregated = await redis.get(aggregatedKey)
        
        if (aggregated) {
          const data = JSON.parse(aggregated)
          baseStrategyCount = data.base?.count || 0
          mainStrategyCount = data.main?.count || 0
          realStrategyCount = data.real?.count || 0
          evaluatedBase = data.base?.evaluated || 0
          evaluatedMain = data.main?.evaluated || 0
          evaluatedReal = data.real?.evaluated || 0
        } else {
          // Fallback: Query only top-level keys without deep scanning
          try {
            const baseKey = `strategies:${connectionId}:base:aggregated`
            const mainKey = `strategies:${connectionId}:main:aggregated`
            const realKey = `strategies:${connectionId}:real:aggregated`
            
            const [baseData, mainData, realData] = await Promise.all([
              redis.get(baseKey).catch(() => null),
              redis.get(mainKey).catch(() => null),
              redis.get(realKey).catch(() => null),
            ])
            
            if (baseData) {
              const parsed = JSON.parse(baseData)
              baseStrategyCount = parsed.count || 0
              evaluatedBase = parsed.evaluated || 0
            }
            if (mainData) {
              const parsed = JSON.parse(mainData)
              mainStrategyCount = parsed.count || 0
              evaluatedMain = parsed.evaluated || 0
            }
            if (realData) {
              const parsed = JSON.parse(realData)
              realStrategyCount = parsed.count || 0
              evaluatedReal = parsed.evaluated || 0
            }
          } catch (parseErr) {
            // Continue with zeros
          }
        }
      } catch (queryErr) {
        console.warn(`[EngineStrategies] Error querying strategy counts:`, queryErr)
      }
      
      // ── Pipeline-aware totals ─────────────────────────────────────────
      // Base → Main → Real is a cascade filter. Each stage processes the
      // SAME logical strategies that survived the previous filter, so
      // summing them would triple-count. The canonical "total" at every
      // level is the Real-stage count only.
      const response = {
        connectionId,
        strategies: {
          base: baseStrategyCount,
          main: mainStrategyCount,
          real: realStrategyCount,
          total: realStrategyCount,
        },
        evaluated: {
          base: evaluatedBase,
          main: evaluatedMain,
          real: evaluatedReal,
          total: evaluatedReal,
        },
        timestamp: new Date().toISOString(),
      }
      
      // Cache for 3 seconds (ultra-fast)
      strategiesCache.set(cacheKey, { data: response, timestamp: Date.now() })
      
      return NextResponse.json(response)
    } catch (redisErr) {
      console.error(`[v0] [EngineStrategies] Redis error:`, redisErr)
      return NextResponse.json(
        { error: "Failed to fetch strategies from Redis" },
        { status: 503 }
      )
    }
  } catch (error) {
    console.error("[v0] [EngineStrategies] Fatal error:", error)
    return NextResponse.json(
      { error: "Failed to fetch strategies status" },
      { status: 500 }
    )
  }
}
