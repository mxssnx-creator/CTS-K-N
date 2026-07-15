import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MONITORING_KEY_SAMPLE_LIMIT = 20_000
const MONITORING_KEY_SAMPLE_TTL_MS = 5_000
let keyInventoryCache: { at: number; keys: string[] } | null = null

async function readRedisDbSize(client: ReturnType<typeof getRedisClient>): Promise<number> {
  try {
    const result = typeof (client as any).dbSize === "function"
      ? await (client as any).dbSize()
      : await (client as any).dbsize?.()
    const size = Number(result)
    return Number.isFinite(size) && size >= 0 ? size : 0
  } catch {
    return 0
  }
}

async function collectRedisKeys(client: ReturnType<typeof getRedisClient>): Promise<{ keys: string[]; keyCount: number }> {
  const exactKeyCount = await readRedisDbSize(client)
  const now = Date.now()
  if (keyInventoryCache && now - keyInventoryCache.at < MONITORING_KEY_SAMPLE_TTL_MS) {
    return {
      keys: keyInventoryCache.keys,
      keyCount: Math.max(exactKeyCount, keyInventoryCache.keys.length),
    }
  }

  const remember = (keys: string[], keyCount: number) => {
    keyInventoryCache = { at: now, keys }
    return { keys, keyCount }
  }

  // InlineLocalRedis implements SCAN by rebuilding the complete matching-key
  // array for every cursor page. One KEYS pass is therefore both faster and
  // lower-allocation locally. Network Redis providers use incremental SCAN so
  // their event loop is never blocked by KEYS on a large production database.
  const isInlineLocal = client?.constructor?.name === "InlineLocalRedis"
  if (isInlineLocal) {
    try {
      const keysResult = await client.keys("*")
      if (Array.isArray(keysResult)) {
        const keys = keysResult.slice(0, MONITORING_KEY_SAMPLE_LIMIT)
        return remember(keys, Math.max(exactKeyCount, keysResult.length))
      }
    } catch { /* fall through to the bounded scanner */ }
  }

  const scannedKeys = new Set<string>()
  try {
    let cursor: string | number = "0"
    for (let i = 0; i < 200 && scannedKeys.size < MONITORING_KEY_SAMPLE_LIMIT; i++) {
      if (typeof client.scan !== "function") break
      const result = await client.scan(cursor, "MATCH", "*", "COUNT", 500)
      const nextCursor = Array.isArray(result) ? result[0] : "0"
      const batch = Array.isArray(result) ? result[1] : []
      if (Array.isArray(batch)) {
        for (const key of batch) {
          scannedKeys.add(String(key))
          if (scannedKeys.size >= MONITORING_KEY_SAMPLE_LIMIT) break
        }
      }
      cursor = nextCursor
      if (String(cursor) === "0") break
    }
  } catch {
    // Keep going: the exact DBSIZE value can still provide a useful result.
  }

  if (scannedKeys.size > 0) {
    const keys = Array.from(scannedKeys)
    return remember(keys, Math.max(exactKeyCount, scannedKeys.size))
  }

  // Last-resort compatibility for adapters that expose neither SCAN nor
  // DBSIZE. This path is intentionally skipped for normal hosted providers.
  if (exactKeyCount === 0) {
    try {
      const keysResult = await client.keys("*")
      if (Array.isArray(keysResult)) {
        const keys = keysResult.slice(0, MONITORING_KEY_SAMPLE_LIMIT)
        return remember(keys, keysResult.length)
      }
    } catch { /* no inventory available */ }
  }

  return { keys: [], keyCount: exactKeyCount }
}

async function collectConnectionIds(
  client: ReturnType<typeof getRedisClient>,
  sampledKeys: string[],
): Promise<string[]> {
  const ids = new Set<string>()
  const [allConnections, enabledConnections, activeConnections] = await Promise.all(
    ["connections", "connections:main:enabled", "connections:active"]
      .map((key) => client.smembers(key).catch(() => [] as string[])),
  )
  const runtimeIndexed = [...enabledConnections, ...activeConnections]
  for (const id of runtimeIndexed.length > 0 ? runtimeIndexed : allConnections) {
    if (id) ids.add(String(id))
  }

  // Compatibility for snapshots from before the connection indexes existed.
  if (ids.size === 0) {
    for (const key of sampledKeys) {
      const progressionMatch = /^progression:([^:]+)(?::[^:]+)?$/.exec(key)
      const connectionMatch = /^(?:settings:)?connection:([^:]+)$/.exec(key)
      const id = progressionMatch?.[1] || connectionMatch?.[1]
      if (id) ids.add(id)
    }
  }
  return Array.from(ids)
}

export async function GET() {
  try {
    const resourceMetrics = getSystemResourceMetrics()
    let client: ReturnType<typeof getRedisClient> | null = null

    let allKeys: string[] = []
    let keyCount = 0
    let redisAvailable = false
    try {
      await initRedis()
      client = getRedisClient()
      const collected = await collectRedisKeys(client)
      allKeys = collected.keys
      keyCount = collected.keyCount
      redisAvailable = true
    } catch (redisError) {
      console.warn("[Monitoring] Redis unavailable while collecting system metrics:", redisError instanceof Error ? redisError.message : String(redisError))
      allKeys = []
      keyCount = 0
      redisAvailable = false
    }
    
    const keys = Math.max(keyCount, allKeys.length)
    const sets = allKeys.filter((k: string) => k.includes(":set") || k.includes("_set")).length
    const positionKeys = allKeys.filter((k: string) => k.includes("position")).length
    const indicationKeys = allKeys.filter((k: string) => 
      k.includes("indication") || k.includes("indications:") || k.includes(":rsi") || k.includes(":macd")
    ).length
    const strategyKeys = allKeys.filter((k: string) => 
      k.includes("strategy") || k.includes("strategies:") || k.includes("entry:") || k.includes("signal:")
    ).length

    let estimatedDbBytes = 0
    try {
      const sampleKeys = allKeys.slice(0, 12)
      const sampleSizes = await Promise.all(sampleKeys.map(async (key) => {
        let bytes = key.length
        const strValue = client ? await client.get(key).catch(() => null) : null
        if (typeof strValue === "string" && strValue.length > 0) return bytes + strValue.length
        const hashValue = client ? await client.hgetall(key).catch(() => null) : null
        if (hashValue && typeof hashValue === "object") {
          for (const [field, value] of Object.entries(hashValue)) {
            bytes += String(field).length + String(value).length
          }
        }
        return bytes
      }))
      const sampledBytes = sampleSizes.reduce((sum, bytes) => sum + bytes, 0)
      estimatedDbBytes = sampleKeys.length > 0
        ? Math.max(0, Math.round((sampledBytes / sampleKeys.length) * Math.max(keys, 1)))
        : 0
    } catch {
      estimatedDbBytes = 0
    }

    let coordinatorEngineCount = 0
    try {
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      coordinatorEngineCount = coordinator?.getActiveEngineCount?.() ?? 0
    } catch {
      coordinatorEngineCount = 0
    }
    
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let indicationsRunning = false
    let strategiesRunning = false
    let redisActiveEngineCount = 0
    
    // PRIMARY: read live progression hashes through connection indexes. Cycle
    // observability must not depend on a bounded key-inventory sample happening
    // to contain every progression key.
    try {
      const connectionIds = client ? await collectConnectionIds(client, allKeys) : []
      for (const connectionId of connectionIds) {
        try {
          if (!client) continue
          const connectionHash = await client.hgetall(`connection:${connectionId}`).catch(() => ({}))
          const configuredEngineType = String(
            (connectionHash as any)?.engine_type || (connectionHash as any)?.engineType || "main",
          ).replace(/[^A-Za-z0-9._-]/g, "_") || "main"
          const engineTypes = Array.from(new Set([configuredEngineType, "main", "preset"]))
          const [legacyProgression, legacyEngineState, realtimeState, scopedProgressions, scopedEngineStates] = await Promise.all([
            client.hgetall(`progression:${connectionId}`).catch(() => ({})),
            client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({})),
            client.hgetall(`realtime:${connectionId}`).catch(() => ({})),
            Promise.all(engineTypes.map((type) => client.hgetall(`progression:${connectionId}:${type}`).catch(() => ({})))),
            Promise.all(engineTypes.map((type) => client.hgetall(`settings:trade_engine_state:${connectionId}:${type}`).catch(() => ({})))),
          ])
          const progressionHashes = [legacyProgression, ...scopedProgressions] as Array<Record<string, any>>
          const engineStateHashes = [legacyEngineState, ...scopedEngineStates] as Array<Record<string, any>>
          const maxField = (hashes: Array<Record<string, any>>, field: string): number =>
            hashes.reduce((max, hash) => Math.max(max, Number(hash?.[field]) || 0), 0)
          const hasCycleSource = [...progressionHashes, ...engineStateHashes, realtimeState]
            .some((hash) => hash && Object.keys(hash).length > 0)
          if (hasCycleSource) {
            const realtimeCycles = Math.max(
              maxField(progressionHashes, "realtime_cycle_count"),
              maxField(engineStateHashes, "realtime_cycle_count"),
              Number((realtimeState as any)?.cycle_count) || 0,
            )
            const indCycles = Math.max(
              maxField(progressionHashes, "indication_cycle_count"),
              maxField(progressionHashes, "indication_live_cycle_count"),
              maxField(engineStateHashes, "indication_cycle_count"),
              realtimeCycles,
            )
            const stratCycles = Math.max(
              maxField(progressionHashes, "strategy_cycle_count"),
              maxField(progressionHashes, "strategy_live_cycle_count"),
              maxField(engineStateHashes, "strategy_cycle_count"),
              realtimeCycles,
            )
            const stateRunning = engineStateHashes.some((state) => state?.status === "running")
            if (indCycles > 0 || stratCycles > 0 || stateRunning) {
              totalIndicationCycles += indCycles
              totalStrategyCycles   += stratCycles
              indicationsRunning     = indCycles > 0 || stateRunning
              strategiesRunning      = stratCycles > 0 || stateRunning
              redisActiveEngineCount++
            }
          }
        } catch {}
      }
    } catch {}

    // FALLBACK for unindexed legacy snapshots: sampled state keys. New
    // installations are covered by the indexed loop above.
    if (totalIndicationCycles === 0) {
      try {
        const connectionStateKeys = allKeys.filter((k: string) => k.startsWith("settings:trade_engine_state:"))
        for (const stateKey of connectionStateKeys) {
          try {
            if (!client) continue
            const stateStr = await client.get(stateKey)
            if (stateStr) {
              const state = JSON.parse(stateStr)
              totalIndicationCycles += Number(state.indication_cycle_count) || 0
              totalStrategyCycles   += Number(state.strategy_cycle_count)   || 0
              if (state.status === "running") {
                indicationsRunning     = true
                strategiesRunning      = true
                redisActiveEngineCount++
              }
            }
          } catch {}
        }
      } catch {}
    }
    
    let redisEngineRunning = false
    try {
      const globalEngine = client ? await client.hgetall("trade_engine:global") : null
      if (globalEngine && Object.keys(globalEngine).length > 0) {
        redisEngineRunning = globalEngine.status === "running"
      }
    } catch {}
    
    const engineRunning = redisEngineRunning || indicationsRunning || strategiesRunning || coordinatorEngineCount > 0
    const activeEngineCount = Math.max(coordinatorEngineCount, redisActiveEngineCount)
    const indicationsEngineRunning = indicationsRunning || (engineRunning && activeEngineCount > 0)
    const strategiesEngineRunning = strategiesRunning || (engineRunning && activeEngineCount > 0)

    let requestsPerSecond = 0
    try {
      const { getRedisRequestsPerSecond } = await import("@/lib/redis-db")
      requestsPerSecond = getRedisRequestsPerSecond()
    } catch {
      requestsPerSecond = 0
    }

    return NextResponse.json({
      cpu: resourceMetrics.cpuPercent,
      memory: resourceMetrics.memoryPercent,
      memoryUsed: Math.round(resourceMetrics.memoryUsedBytes / 1024),
      memoryTotal: Math.round(resourceMetrics.memoryTotalBytes / 1024),
      heapUsed: Math.round(resourceMetrics.heapUsedBytes / 1024),
      heapTotal: Math.round(resourceMetrics.heapTotalBytes / 1024),
      rss: Math.round(resourceMetrics.rssBytes / 1024),
      database: {
        size: estimatedDbBytes,
        keys,
        sets,
        positions1h: positionKeys,
        entries1h: indicationKeys + strategyKeys,
        requestsPerSecond: Math.max(0, requestsPerSecond),
      },
      services: {
        tradeEngine: engineRunning,
        indicationsEngine: indicationsEngineRunning,
        strategiesEngine: strategiesEngineRunning,
        websocket: redisAvailable,
      },
      modules: {
        redis: redisAvailable,
        persistence: keys > 0,
        coordinator: engineRunning || coordinatorEngineCount > 0,
        logger: true,
      },
      engines: {
        indications: {
          running: indicationsEngineRunning,
          cycleCount: totalIndicationCycles,
          resultsCount: indicationKeys,
        },
        strategies: {
          running: strategiesEngineRunning,
          cycleCount: totalStrategyCycles,
          resultsCount: strategyKeys,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[Monitoring] Error:", error)
    const resourceMetrics = getSystemResourceMetrics()
    return NextResponse.json(
      { 
        cpu: resourceMetrics.cpuPercent, 
        memory: resourceMetrics.memoryPercent, 
        memoryUsed: Math.round(resourceMetrics.memoryUsedBytes / 1024), 
        memoryTotal: Math.round(resourceMetrics.memoryTotalBytes / 1024),
        heapUsed: Math.round(resourceMetrics.heapUsedBytes / 1024),
        heapTotal: Math.round(resourceMetrics.heapTotalBytes / 1024),
        rss: Math.round(resourceMetrics.rssBytes / 1024),
        database: { size: 0, keys: 0, sets: 0, positions1h: 0, entries1h: 0, requestsPerSecond: 0 },
        services: { tradeEngine: false, indicationsEngine: false, strategiesEngine: false, websocket: false },
        modules: { redis: false, persistence: false, coordinator: false, logger: true },
        engines: {
          indications: { running: false, cycleCount: 0, resultsCount: 0 },
          strategies: { running: false, cycleCount: 0, resultsCount: 0 },
        },
        error: "Failed to fetch metrics", 
        details: error instanceof Error ? error.message : "Unknown" 
      },
      { status: 200 }
    )
  }
}
