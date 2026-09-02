import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"
import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"
import { scanRedisKeys } from "@/lib/redis-scan"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MONITORING_KEY_SAMPLE_LIMIT = 20_000
const MONITORING_KEY_SAMPLE_TTL_MS = 5_000
let keyInventoryCache: { at: number; keys: string[] } | null = null
const MONITORING_RESPONSE_TTL_MS = 3_000
const MONITORING_RESPONSE_MAX_STALE_MS = 30_000
type MonitoringResponseSnapshot = {
  body: string
  headers: Array<[string, string]>
  status: number
  statusText: string
}
let monitoringResponseCache: {
  expiresAt: number
  staleUntil: number
  snapshot: MonitoringResponseSnapshot
} | null = null
let monitoringResponseInFlight: Promise<MonitoringResponseSnapshot> | null = null

function responseFromMonitoringSnapshot(snapshot: MonitoringResponseSnapshot): Response {
  return new Response(snapshot.body, {
    headers: snapshot.headers,
    status: snapshot.status,
    statusText: snapshot.statusText,
  })
}

async function snapshotMonitoringResponse(response: Response): Promise<MonitoringResponseSnapshot> {
  return {
    body: await response.text(),
    headers: Array.from(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
  }
}

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
  // array for every cursor page. Use its dedicated bounded inventory instead
  // of KEYS("*"): slicing a KEYS result after it is built still allocates the
  // complete keyspace and can starve a max-symbol engine. Network Redis
  // providers continue to use incremental SCAN below.
  const isInlineLocal = client?.constructor?.name === "InlineLocalRedis"
  if (isInlineLocal && typeof (client as any).sampleKeys === "function") {
    try {
      const keysResult = await (client as any).sampleKeys(MONITORING_KEY_SAMPLE_LIMIT)
      if (Array.isArray(keysResult)) {
        const keys = keysResult.slice(0, MONITORING_KEY_SAMPLE_LIMIT)
        return remember(keys, Math.max(exactKeyCount, keys.length))
      }
    } catch { /* fall through to the bounded scanner */ }
  }

  let scannedKeys: string[] = []
  try {
    scannedKeys = await scanRedisKeys(client, "*", {
      count: 500,
      limit: MONITORING_KEY_SAMPLE_LIMIT,
    })
  } catch {
    // Keep going: the exact DBSIZE value can still provide a useful result.
  }

  if (scannedKeys.length > 0) {
    return remember(scannedKeys, Math.max(exactKeyCount, scannedKeys.length))
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

async function buildMonitoringResponse() {
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

    // Indication Set identities are a bounded, lazily materialized inventory:
    // the opposite Long/Short side may first appear well after cold bootstrap.
    // Expose its exact indexed cardinality separately so long-run monitoring
    // can distinguish that finite topology growth from unrelated key leakage.
    let indexedConnectionIds: string[] = []
    let indicationSetInventoryKeys = 0
    let indicationOutcomeAuxiliaryKeys = 0
    let indicationSetInventoryConnections = 0
    try {
      indexedConnectionIds = client ? await collectConnectionIds(client, allKeys) : []
      if (client && indexedConnectionIds.length > 0) {
        const counts = await Promise.all(
          indexedConnectionIds.map(async (connectionId) => {
            const [sets, outcomeAuxiliaries] = await Promise.all([
              client!.scard(`indication_sets:index:${connectionId}`).catch(() => 0),
              client!.scard(`indication_sets:outcome_keys:index:${connectionId}`).catch(() => 0),
            ])
            return { sets, outcomeAuxiliaries }
          }),
        )
        indicationSetInventoryKeys = counts.reduce(
          (sum, value) => sum + Math.max(0, Number(value.sets) || 0),
          0,
        )
        indicationOutcomeAuxiliaryKeys = counts.reduce(
          (sum, value) => sum + Math.max(0, Number(value.outcomeAuxiliaries) || 0),
          0,
        )
        indicationSetInventoryConnections = counts.filter(
          (value) =>
            Math.max(0, Number(value.sets) || 0) > 0 ||
            Math.max(0, Number(value.outcomeAuxiliaries) || 0) > 0,
        ).length
      }
    } catch {
      indexedConnectionIds = []
      indicationSetInventoryKeys = 0
      indicationOutcomeAuxiliaryKeys = 0
      indicationSetInventoryConnections = 0
    }

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

    const globalEngineState = client
      ? await client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>))
      : {}
    
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let totalRealtimeCycles = 0
    let indicationsRunning = false
    let strategiesRunning = false
    let realtimeRunning = false
    let redisActiveEngineCount = 0
    
    // PRIMARY: read live progression hashes through connection indexes. Cycle
    // observability must not depend on a bounded key-inventory sample happening
    // to contain every progression key.
    try {
      for (const connectionId of indexedConnectionIds) {
        try {
          if (!client) continue
          const connectionHash = await client.hgetall(`connection:${connectionId}`).catch(() => ({}))
          const configuredEngineType = String(
            (connectionHash as any)?.engine_type || (connectionHash as any)?.engineType || "main",
          ).replace(/[^A-Za-z0-9._-]/g, "_") || "main"
          const engineTypes = Array.from(new Set([configuredEngineType, "main", "preset"]))
          const [legacyProgression, legacyRawEngineState, legacyEngineState, realtimeState, scopedProgressions, scopedRawEngineStates, scopedEngineStates, runningHint] = await Promise.all([
            client.hgetall(`progression:${connectionId}`).catch(() => ({})),
            client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({})),
            client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({})),
            client.hgetall(`realtime:${connectionId}`).catch(() => ({})),
            Promise.all(engineTypes.map((type) => client.hgetall(`progression:${connectionId}:${type}`).catch(() => ({})))),
            Promise.all(engineTypes.map((type) => client.hgetall(`trade_engine_state:${connectionId}:${type}`).catch(() => ({})))),
            Promise.all(engineTypes.map((type) => client.hgetall(`settings:trade_engine_state:${connectionId}:${type}`).catch(() => ({})))),
            client.get(`engine_is_running:${connectionId}`).catch(() => null),
          ])
          const progressionHashes = [legacyProgression, ...scopedProgressions] as Array<Record<string, any>>
          const engineStateHashes = [legacyRawEngineState, legacyEngineState, ...scopedRawEngineStates, ...scopedEngineStates] as Array<Record<string, any>>
          const maxField = (hashes: Array<Record<string, any>>, field: string): number =>
            hashes.reduce((max, hash) => Math.max(max, Number(hash?.[field]) || 0), 0)
          const hasCycleSource = [...progressionHashes, ...engineStateHashes, realtimeState]
            .some((hash) => hash && Object.keys(hash).length > 0)
          if (hasCycleSource) {
            const realtimeCycles = Math.max(
              maxField(progressionHashes, "realtime_cycle_count"),
              maxField(progressionHashes, "live_positions_cycle_count"),
              maxField(engineStateHashes, "realtime_cycle_count"),
              maxField(engineStateHashes, "live_positions_cycle_count"),
              Number((realtimeState as any)?.cycle_count) || 0,
            )
            const indCycles = Math.max(
              maxField(progressionHashes, "indication_cycle_count"),
              maxField(progressionHashes, "indication_live_cycle_count"),
              maxField(engineStateHashes, "indication_cycle_count"),
            )
            const stratCycles = Math.max(
              maxField(progressionHashes, "strategy_cycle_count"),
              maxField(progressionHashes, "strategy_live_cycle_count"),
              maxField(engineStateHashes, "strategy_cycle_count"),
            )
            const stateRunning = engineStateHashes.some((state) => state?.status === "running")
            const hasProcessingFlag = Object.prototype.hasOwnProperty.call(connectionHash || {}, "is_enabled_dashboard")
            const connectionEnabled = hasProcessingFlag
              ? [true, 1, "1", "true"].includes((connectionHash as any).is_enabled_dashboard)
              : undefined
            const runtime = resolveDistributedEngineRuntime({
              runningHint,
              states: engineStateHashes,
              globalState: globalEngineState,
              connectionEnabled,
            })
            if (indCycles > 0 || stratCycles > 0 || realtimeCycles > 0 || stateRunning) {
              totalIndicationCycles += indCycles
              totalStrategyCycles   += stratCycles
              totalRealtimeCycles   += realtimeCycles
            }
            if (runtime.running) {
              indicationsRunning ||= indCycles > 0 || stateRunning
              strategiesRunning ||= stratCycles > 0 || stateRunning
              realtimeRunning ||= realtimeCycles > 0 || stateRunning
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
              totalRealtimeCycles   += Math.max(
                Number(state.realtime_cycle_count) || 0,
                Number(state.live_positions_cycle_count) || 0,
              )
            }
          } catch {}
        }
      } catch {}
    }
    
    const activeEngineCount = redisActiveEngineCount
    const engineRunning = activeEngineCount > 0
    const indicationsEngineRunning = indicationsRunning || (engineRunning && activeEngineCount > 0)
    const strategiesEngineRunning = strategiesRunning || (engineRunning && activeEngineCount > 0)

    let requestsPerSecond = 0
    try {
      const { getObservedRedisRequestsPerSecond } = await import("@/lib/redis-db")
      requestsPerSecond = await getObservedRedisRequestsPerSecond()
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
        indicationSetInventoryKeys,
        indicationOutcomeAuxiliaryKeys,
        indicationSetInventoryConnections,
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
        coordinator: engineRunning,
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
        realtime: {
          running: realtimeRunning || (engineRunning && activeEngineCount > 0),
          cycleCount: totalRealtimeCycles,
          resultsCount: positionKeys,
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
        database: {
          size: 0,
          keys: 0,
          indicationSetInventoryKeys: 0,
          indicationOutcomeAuxiliaryKeys: 0,
          indicationSetInventoryConnections: 0,
          sets: 0,
          positions1h: 0,
          entries1h: 0,
          requestsPerSecond: 0,
        },
        services: { tradeEngine: false, indicationsEngine: false, strategiesEngine: false, websocket: false },
        modules: { redis: false, persistence: false, coordinator: false, logger: true },
        engines: {
          indications: { running: false, cycleCount: 0, resultsCount: 0 },
          strategies: { running: false, cycleCount: 0, resultsCount: 0 },
          realtime: { running: false, cycleCount: 0, resultsCount: 0 },
        },
        error: "Failed to fetch metrics", 
        details: error instanceof Error ? error.message : "Unknown" 
      },
      { status: 200 }
    )
  }
}

export async function GET() {
  const now = Date.now()
  const cached = monitoringResponseCache
  if (cached && cached.expiresAt > now) {
    return responseFromMonitoringSnapshot(cached.snapshot)
  }
  const staleSnapshot = cached && cached.staleUntil > now ? cached.snapshot : null
  if (monitoringResponseInFlight) {
    return staleSnapshot
      ? responseFromMonitoringSnapshot(staleSnapshot)
      : responseFromMonitoringSnapshot(await monitoringResponseInFlight)
  }

  const refresh = buildMonitoringResponse().then(snapshotMonitoringResponse)
  monitoringResponseInFlight = refresh
  const finish = () => {
    if (monitoringResponseInFlight === refresh) monitoringResponseInFlight = null
  }
  const cacheSuccessful = (snapshot: MonitoringResponseSnapshot) => {
    if (snapshot.status >= 200 && snapshot.status < 300) {
      monitoringResponseCache = {
        expiresAt: Date.now() + MONITORING_RESPONSE_TTL_MS,
        staleUntil: Date.now() + MONITORING_RESPONSE_MAX_STALE_MS,
        snapshot,
      }
    }
    return snapshot
  }

  if (staleSnapshot) {
    void refresh.then(cacheSuccessful).catch(() => undefined).finally(finish)
    return responseFromMonitoringSnapshot(staleSnapshot)
  }
  try {
    return responseFromMonitoringSnapshot(cacheSuccessful(await refresh))
  } finally {
    finish()
  }
}
