/**
 * Market Data Cache Module
 * Standalone module-level caching for market data to avoid class context issues
 * Optimized for high-frequency, high-performance processing:
 *   - 200ms TTL per symbol (covers 1s indication cycle with headroom)
 *   - Batch prefetch for multiple symbols in one Redis pipeline call
 *   - In-flight deduplication to prevent concurrent fetches for the same symbol
 * @version 2.0.0
 */

import { initRedis, getMarketData, getRedisClient } from "@/lib/redis-db"

// Module-level cache - guaranteed to exist, no class context issues
const CACHE = new Map<string, { data: any; timestamp: number }>()
// High-frequency TTL: 200ms ensures fresh data each indication cycle (1000ms interval)
// but avoids redundant Redis round-trips within the same cycle across parallel symbol processing
const CACHE_TTL = 200 // ms

// In-flight deduplication: if a fetch is already in-progress for a symbol, await the same promise
const IN_FLIGHT = new Map<string, Promise<any>>()

/**
 * Get market data with caching - module-level function
 * No class context needed - works reliably across webpack bundle reloads
 */
export async function getMarketDataCached(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = CACHE.get(symbol)

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  // Deduplicate concurrent fetches for the same symbol
  const inFlight = IN_FLIGHT.get(symbol)
  if (inFlight) return inFlight

  const fetchPromise = (async () => {
    try {
      await initRedis()
      const rawData = await getMarketData(symbol, "1m")

      if (!rawData) {
        return null
      }

      const latest = Array.isArray(rawData) ? rawData[0] : rawData

      if (latest) {
        CACHE.set(symbol, { data: latest, timestamp: Date.now() })
        return latest
      }
      return null
    } catch (error) {
      // Return stale cache entry rather than null on transient Redis errors
      return CACHE.get(symbol)?.data ?? null
    } finally {
      IN_FLIGHT.delete(symbol)
    }
  })()

  IN_FLIGHT.set(symbol, fetchPromise)
  return fetchPromise
}

/**
 * Batch prefetch market data for multiple symbols in a single Redis pipeline
 * Call this at the start of each indication cycle to warm the cache for all symbols
 * so individual processIndication calls hit cache (zero Redis round-trips).
 */
export async function prefetchMarketDataBatch(symbols: string[]): Promise<void> {
  if (!symbols || symbols.length === 0) return
  try {
    await initRedis()
    const client = getRedisClient()
    const now = Date.now()

    // Filter to only symbols whose cache is stale
    const stale = symbols.filter((s) => {
      const c = CACHE.get(s)
      return !c || now - c.timestamp >= CACHE_TTL
    })
    if (stale.length === 0) return

    // Use Redis pipeline for minimal round-trips
    const pipeline = client.multi()
    for (const symbol of stale) {
      pipeline.hgetall(`market_data:${symbol}`)
    }
    const results = await pipeline.exec()

    if (Array.isArray(results)) {
      for (let i = 0; i < stale.length; i++) {
        const data = results[i]
        if (data && typeof data === "object" && Object.keys(data).length > 0) {
          CACHE.set(stale[i], { data, timestamp: Date.now() })
        }
      }
    }
    } catch (e) {
      // Log the failure so operators can see when prefetch is broken —
      // individual getMarketDataCached calls downstream each pay a full
      // Redis round-trip when prefetch silently fails.
      console.warn(
        `[v0] [MarketDataCache] Prefetch batch failed for ${symbols.length} symbols:`,
        e instanceof Error ? e.message : String(e),
      )
    }
}

// Settings cache - 5s TTL (settings change rarely)
let SETTINGS_CACHE: { data: any; timestamp: number } | null = null
const SETTINGS_CACHE_TTL = 5000 // ms

// ── Parsed prehistoric-candles cache (OOM-protection) ─────────────────────
// The prehistoric replay loop (engine-manager) previously did
// `client.get(market_data:{sym}:candles)` + `JSON.parse` of the FULL ~86,400
// candle blob (~10 MB of JSON) PER SYMBOL on EVERY cycle (~1/sec), then
// `.filter().sort()` allocated several more copies. Across 5–15 symbols this
// transient garbage outpaced GC and OOM-killed next-server minutes after the
// engine became active (verified: FATAL "Ineffective mark-compacts near heap
// limit", RSS jumping ~1.5GB → ~5GB in a single 30s window).
//
// Prehistoric candles are STATIC for a session, so parse each blob at most
// once and reuse the parsed+sorted array across cycles. The cache key is the
// symbol; a cheap length signature (raw string length) invalidates the entry
// only when the underlying blob actually changes (e.g. a reload writes a
// different candle count). Bounded to a handful of symbols — the engine only
// ever replays its configured symbol set.
const PARSED_CANDLES_CACHE = new Map<
  string,
  { candles: any[]; sig: number; timestamp: number }
>()
const PARSED_CANDLES_TTL = 5 * 60_000 // 5 min — defensive eviction
const PARSED_CANDLES_MAX_ENTRIES = 64

interface HistoricChunkRange {
  start: number
  end: number
  count?: number
}

interface HistoricRangeOptions {
  startMs: number
  endMs: number
  /** Maximum number of Redis list elements fetched in one request. */
  batchChunks?: number
}

interface HistoricWindowOptions {
  afterMs: number
  beforeMs: number
  limit: number
  warmup?: number
  lookahead?: number
}

function candleTimestamp(candle: any): number {
  return Number(candle?.timestamp ?? candle?.time ?? candle?.openTime ?? 0)
}

function normalizeHistoricCandles(chunks: unknown[]): any[] {
  const byTimestamp = new Map<number, any>()
  for (const rawChunk of chunks) {
    try {
      const parsed = typeof rawChunk === "string" ? JSON.parse(rawChunk) : rawChunk
      if (!Array.isArray(parsed)) continue
      for (const candle of parsed) {
        const timestamp = candleTimestamp(candle)
        if (Number.isFinite(timestamp) && timestamp > 0) byTimestamp.set(timestamp, candle)
      }
    } catch {
      // A partially-written/corrupt chunk must not abort the complete replay.
    }
  }
  return [...byTimestamp.values()].sort((a, b) => candleTimestamp(a) - candleTimestamp(b))
}

async function loadHistoricChunkRanges(symbol: string): Promise<HistoricChunkRange[]> {
  await initRedis()
  const client = getRedisClient()
  const raw = await client.get(`market_data:${symbol}:history:meta`)
  if (!raw) return []
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed?.ranges)) return []
    return parsed.ranges
      .map((range: any) => ({
        start: Number(range?.start),
        end: Number(range?.end),
        count: Math.max(0, Number(range?.count) || 0),
      }))
      .filter((range: HistoricChunkRange) => Number.isFinite(range.start) && Number.isFinite(range.end))
  } catch {
    return []
  }
}

/**
 * Load only the history chunks intersecting a calculation range. This is the
 * memory-bounded replacement for parsing the complete prehistoric JSON blob on
 * every cycle. Chunks are released as soon as each bounded Redis batch has
 * been parsed and filtered.
 */
export async function getHistoricCandlesForRange(
  symbol: string,
  options: HistoricRangeOptions,
): Promise<any[]> {
  const startMs = Math.min(Number(options.startMs), Number(options.endMs))
  const endMs = Math.max(Number(options.startMs), Number(options.endMs))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return []

  const ranges = await loadHistoricChunkRanges(symbol)
  if (ranges.length === 0) {
    const legacy = await getParsedCandlesCached(symbol)
    return legacy.filter((candle) => {
      const timestamp = candleTimestamp(candle)
      return timestamp >= startMs && timestamp <= endMs
    })
  }

  const first = ranges.findIndex((range) => range.end >= startMs && range.start <= endMs)
  if (first < 0) return []
  let last = first
  while (last + 1 < ranges.length && ranges[last + 1].start <= endMs) last++

  const client = getRedisClient()
  const listKey = `market_data:${symbol}:history:chunks`
  const batchChunks = Math.max(1, Math.min(64, Math.floor(Number(options.batchChunks) || 8)))
  const selected: any[] = []
  for (let cursor = first; cursor <= last; cursor += batchChunks) {
    const batchEnd = Math.min(last, cursor + batchChunks - 1)
    const rawChunks = await client.lrange(listKey, cursor, batchEnd)
    for (const candle of normalizeHistoricCandles(Array.isArray(rawChunks) ? rawChunks : [])) {
      const timestamp = candleTimestamp(candle)
      if (timestamp >= startMs && timestamp <= endMs) selected.push(candle)
    }
  }
  return normalizeHistoricCandles([selected])
}

/**
 * Load a small replay window around the last processed timestamp. The single
 * contiguous LRANGE is intentionally wide enough for warmup and lookahead but
 * never includes unrelated prehistoric chunks.
 */
export async function getHistoricCandleWindow(
  symbol: string,
  options: HistoricWindowOptions,
): Promise<{ warmup: any[]; pending: any[]; lookahead: any[] }> {
  const afterMs = Number(options.afterMs)
  const beforeMs = Number(options.beforeMs)
  const limit = Math.max(0, Math.floor(Number(options.limit) || 0))
  const warmupCount = Math.max(0, Math.floor(Number(options.warmup) || 0))
  const lookaheadCount = Math.max(0, Math.floor(Number(options.lookahead) || 0))
  const empty = { warmup: [] as any[], pending: [] as any[], lookahead: [] as any[] }
  if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs < afterMs) return empty

  const ranges = await loadHistoricChunkRanges(symbol)
  let candles: any[]
  if (ranges.length === 0) {
    candles = await getParsedCandlesCached(symbol)
  } else {
    let first = ranges.findIndex((range) => range.end >= afterMs)
    if (first < 0) first = ranges.length - 1
    let warmupNeeded = warmupCount
    while (first > 0 && warmupNeeded > 0) {
      warmupNeeded -= Math.max(1, Number(ranges[first].count) || 0)
      first--
    }

    let last = ranges.findIndex((range, index) => index >= first && range.end >= beforeMs)
    if (last < 0) last = ranges.length - 1
    let lookaheadNeeded = lookaheadCount
    while (last + 1 < ranges.length && lookaheadNeeded > Math.max(0, Number(ranges[last].count) || 0)) {
      lookaheadNeeded -= Math.max(1, Number(ranges[last].count) || 0)
      last++
    }

    const rawChunks = await getRedisClient().lrange(`market_data:${symbol}:history:chunks`, first, last)
    candles = normalizeHistoricCandles(Array.isArray(rawChunks) ? rawChunks : [])
  }

  const warmup = candles.filter((candle) => candleTimestamp(candle) <= afterMs).slice(-warmupCount)
  const pending = candles
    .filter((candle) => candleTimestamp(candle) > afterMs && candleTimestamp(candle) < beforeMs)
    .slice(0, limit)
  const lookahead = candles.filter((candle) => candleTimestamp(candle) >= beforeMs).slice(0, lookaheadCount)
  return { warmup, pending, lookahead }
}

/**
 * Return the parsed candle array for a symbol, parsing the Redis JSON blob at
 * most once per data version instead of on every replay cycle. Candles are
 * returned ascending by timestamp. The returned array is SHARED — callers must
 * treat it as read-only (the replay loop only ever .filter()s a copy from it).
 */
export async function getParsedCandlesCached(symbol: string): Promise<any[]> {
  const now = Date.now()
  try {
    await initRedis()
    const client = getRedisClient()
    const raw = await client.get(`market_data:${symbol}:candles`)
    if (!raw) {
      // No prehistoric blob — fall back to the :1s envelope, also cached.
      const envelopeRaw = await client.get(`market_data:${symbol}:1s`)
      if (!envelopeRaw) return []
      const sig = typeof envelopeRaw === "string" ? envelopeRaw.length : 0
      const cached = PARSED_CANDLES_CACHE.get(symbol)
      if (cached && cached.sig === sig) {
        cached.timestamp = now
        return cached.candles
      }
      // Redis returns strings; parse directly without re-stringify
      const obj = JSON.parse(typeof envelopeRaw === "string" ? envelopeRaw : JSON.stringify(envelopeRaw))
      const arr: any[] = Array.isArray(obj?.candles) ? obj.candles : []
      arr.sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
      _storeParsedCandles(symbol, arr, sig, now)
      return arr
    }

    const sig = typeof raw === "string" ? raw.length : 0
    const cached = PARSED_CANDLES_CACHE.get(symbol)
    if (cached && cached.sig === sig) {
      // Hit — refresh recency and reuse the already-parsed+sorted array.
      cached.timestamp = now
      return cached.candles
    }

    // Redis returns strings; parse directly without re-stringify
    const parsed: any[] = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw))
    const arr = Array.isArray(parsed) ? parsed : []
    // Sort once at parse time so the replay loop never re-sorts the full set.
    arr.sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
    _storeParsedCandles(symbol, arr, sig, now)
    return arr
  } catch (e) {
    // On transient Redis/parse errors, return the last good parse if present.
    return PARSED_CANDLES_CACHE.get(symbol)?.candles ?? []
  }
}

function _storeParsedCandles(symbol: string, candles: any[], sig: number, now: number) {
  PARSED_CANDLES_CACHE.set(symbol, { candles, sig, timestamp: now })
  // Evict stale / overflow entries so the Map can never grow unbounded.
  if (PARSED_CANDLES_CACHE.size > PARSED_CANDLES_MAX_ENTRIES) {
    for (const [k, v] of PARSED_CANDLES_CACHE) {
      if (now - v.timestamp > PARSED_CANDLES_TTL) PARSED_CANDLES_CACHE.delete(k)
    }
    // If still over capacity, drop the oldest entries.
    if (PARSED_CANDLES_CACHE.size > PARSED_CANDLES_MAX_ENTRIES) {
      const sorted = [...PARSED_CANDLES_CACHE.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )
      const drop = sorted.slice(0, PARSED_CANDLES_CACHE.size - PARSED_CANDLES_MAX_ENTRIES)
      for (const [k] of drop) PARSED_CANDLES_CACHE.delete(k)
    }
  }
}

/** Drop a symbol's parsed-candle cache (call after a forced reload). */
export function invalidateParsedCandles(symbol?: string) {
  if (symbol) PARSED_CANDLES_CACHE.delete(symbol)
  else PARSED_CANDLES_CACHE.clear()
}


/**
 * Get settings with caching - module-level function
 */
export async function getSettingsCached(): Promise<any> {
  const now = Date.now()

  if (SETTINGS_CACHE && now - SETTINGS_CACHE.timestamp < SETTINGS_CACHE_TTL) {
    return SETTINGS_CACHE.data
  }

  try {
    const { getAppSettings } = await import("@/lib/redis-db")
    await initRedis()
    // Mirror-aware read — covers both `app_settings` and `all_settings`.
    const settings = (await getAppSettings()) || {}

    const indicationSettings = {
      minProfitFactor: settings.minProfitFactor || 1.2,
      minConfidence: settings.minConfidence || 0.6,
      timeframes: settings.timeframes || ["1h", "4h", "1d"],
    }

    SETTINGS_CACHE = { data: indicationSettings, timestamp: now }
    return indicationSettings
  } catch {
    return {
      minProfitFactor: 1.2,
      minConfidence: 0.6,
      timeframes: ["1h", "4h", "1d"],
    }
  }
}
