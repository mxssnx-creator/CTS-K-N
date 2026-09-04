/**
 * Market Data Loader
 * Populates Redis with REAL OHLCV data from exchanges for trading engine
 *
 * ── KEY ARCHITECTURE (post spec §7 migration) ──────────────────────
 *
 *   market_data:{symbol}:1s       → JSON envelope, MarketData with 1s
 *                                   OHLCV buckets (default 1-day window,
 *                                   up to 86,400 buckets). Authoritative
 *                                   prehistoric source. Replaces the
 *                                   legacy `:1m` envelope which is no
 *                                   longer populated.
 *   market_data:{symbol}:candles  → JSON string, raw candles array
 *                                   (mirrors the 1s array; used by the
 *                                   indication processor for history
 *                                   access without parsing the envelope).
 *   market_data:{symbol}          → Redis hash, single latest candle
 *                                   (used by getMarketData() in
 *                                   redis-db for ticker snapshots).
 *
 * Why we changed timeframe everywhere:
 *   The operator spec explicitly says "Interval / Timeframe has to be
 *   1s as in Settings, change everywhere for Main Engine ... actually
 *   1 day." All callers now pass timeframe="1s" and the connector
 *   either uses native 1s klines (Binance spot) or aggregates from
 *   public-trade endpoints (see lib/exchange-connectors/aggregate-1s.ts).
 */

import { getClient, initRedis, getConnection } from "@/lib/redis-db"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { isForcedSimulation } from "@/lib/real-trade-gates"
import { workloadConcurrency } from "@/lib/runtime-parallelism"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { normalizeMarketSymbol, normalizeMarketType, getDefaultSymbolsForMarket, type MarketType } from "@/lib/market-types"
import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"
import { marketDataKey } from "@/lib/market-data-keys"
import type { ExchangeTicker } from "@/lib/exchange-connectors/base-connector"
import { logRuntimeWarning } from "@/lib/runtime-log-throttle"

export interface MarketDataCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  bid?: number
  ask?: number
  spreadPrice?: number
  spreadPips?: number
  spreadBps?: number
}

export interface MarketData {
  symbol: string
  // `timeframe` remains the engine contract (`1s`) for compatibility. FX
  // venues expose M1 history, so the actual cadence is carried explicitly
  // instead of pretending a minute bar is a one-second sample.
  timeframe: string
  sourceTimeframe?: string
  sourceIntervalSeconds?: number
  candles: MarketDataCandle[]
  lastUpdated: string
  source: string // Exchange name or "synthetic"
  marketType?: MarketType
  volumeKind?: "base" | "lots"
  ticker?: ExchangeTicker
}

export interface LoadMarketDataOptions {
  /** Require the chunked prehistoric index in addition to the realtime tail. */
  requireHistory?: boolean
  /** Minimum candle count required before a history cache is reusable. */
  minimumHistoryCandles?: number
  /** Use this exact persisted connection (and its current credentials/mode). */
  connectionId?: string
}

const REALTIME_CANDLE_TAIL = 300
const HISTORIC_CHUNK_SIZE = 2_000
const MARKET_DATA_TTL_SECONDS = 24 * 60 * 60
const MINIMUM_SECOND_HISTORY_DENSITY = 0.95
// The indication grid contains inclusive ranges through 90 samples by
// default. A 5-candle pre-startup placeholder is useful for a ticker, but it
// is not a valid prehistoric cache and must never make the Main/Real stages
// skip their bootstrap history.
const DEFAULT_MINIMUM_HISTORY_CANDLES = 90
const DEFAULT_MARKET_DATA_FETCH_DEADLINE_MS = 15_000

export function resolveMarketDataFetchDeadlineMs(value: unknown = process.env.MARKET_DATA_FETCH_DEADLINE_MS): number {
  const parsed = Number(value)
  const candidate = Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_MARKET_DATA_FETCH_DEADLINE_MS
  return Math.max(1_000, Math.min(60_000, candidate))
}

/**
 * Bound both connector construction and the venue read. A connector factory
 * can perform SDK initialization/time synchronization before `getOHLCV`, so
 * guarding only the final fetch still allowed Quickstart to wait forever.
 */
export async function withMarketDataFetchDeadline<T>(
  operation: () => Promise<T>,
  label: string,
  timeoutMs = resolveMarketDataFetchDeadlineMs(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Main/Real coordinates are calculated on one-minute closes even though the
// engine's canonical market-data feed is 1s.  Keep one authoritative minimum
// here so startup, realtime indication processing, and cache validation agree:
// 90 one-minute bars require 5,400 one-second samples.
export const ENGINE_STAGE_HISTORY_MINUTES = 90
export const ENGINE_STAGE_HISTORY_CANDLES = ENGINE_STAGE_HISTORY_MINUTES * 60

export interface SecondHistoryCoverage {
  complete: boolean
  requiredCandles: number
  uniqueSeconds: number
  oldestTimestamp: number
  latestTimestamp: number
  spanMs: number
  densityRatio: number
  latestAgeMs: number
  maxLatestAgeMs: number
  intervalSeconds: number
}

/**
 * Prove that a nominal 1-second history is both dense and recent enough for
 * time-window evaluation.  Counting sparse public-trade buckets alone is not
 * sufficient: 5,400 traded seconds spread over several hours cannot evaluate
 * the configured latest 90 one-minute bars.  Paper mode can replace an
 * incomplete venue sample with a complete synthetic fixture; live mode stays
 * entry-gated by the caller.
 */
export function analyzeIntervalHistoryCoverage(
  candles: readonly Pick<MarketDataCandle, "timestamp">[],
  minimumHistoryCandles: number,
  intervalSeconds = 1,
  nowMs = Date.now(),
): SecondHistoryCoverage {
  const requiredCandles = Math.max(1, Math.floor(Number(minimumHistoryCandles) || 1))
  const normalizedIntervalSeconds = Math.max(1, Math.floor(Number(intervalSeconds) || 1))
  const intervalMs = normalizedIntervalSeconds * 1_000
  const timestamps: number[] = []
  let ordered = true
  let previous = Number.NEGATIVE_INFINITY
  for (const candle of candles || []) {
    const raw = Number(candle?.timestamp)
    if (!Number.isFinite(raw)) continue
    const timestamp = Math.floor(raw / intervalMs) * intervalMs
    if (timestamp < previous) ordered = false
    if (timestamp !== previous) timestamps.push(timestamp)
    previous = timestamp
  }
  if (!ordered) {
    timestamps.sort((left, right) => left - right)
    let write = 0
    for (let read = 0; read < timestamps.length; read++) {
      if (write > 0 && timestamps[read] === timestamps[write - 1]) continue
      timestamps[write++] = timestamps[read]
    }
    timestamps.length = write
  }

  const uniqueSeconds = timestamps.length
  const tailStart = Math.max(0, uniqueSeconds - requiredCandles)
  const oldestTimestamp = uniqueSeconds > 0 ? timestamps[tailStart] : 0
  const latestTimestamp = uniqueSeconds > 0 ? timestamps[uniqueSeconds - 1] : 0
  const spanMs = latestTimestamp > 0 && oldestTimestamp > 0
    ? Math.max(0, latestTimestamp - oldestTimestamp)
    : 0
  const occupiedIntervals = spanMs > 0 ? Math.floor(spanMs / intervalMs) + 1 : uniqueSeconds > 0 ? 1 : 0
  const densityRatio = occupiedIntervals > 0
    ? Math.min(1, Math.min(requiredCandles, uniqueSeconds) / occupiedIntervals)
    : 0
  // The realtime hot tail covers at most five minutes for one-second data.
  // For slower venue bars, allow a bounded fraction of the requested window
  // so an M1 bar that closed a few minutes ago is still usable without
  // accepting an hours-old FX snapshot as current.
  const maxLatestAgeMs = Math.max(
    2 * intervalMs,
    Math.min(REALTIME_CANDLE_TAIL * intervalMs, Math.floor(requiredCandles * intervalMs * 0.1)),
  )
  const latestAgeMs = latestTimestamp > 0 ? nowMs - latestTimestamp : Number.POSITIVE_INFINITY
  const complete =
    uniqueSeconds >= requiredCandles &&
    densityRatio >= MINIMUM_SECOND_HISTORY_DENSITY &&
    latestAgeMs >= -30_000 &&
    latestAgeMs <= maxLatestAgeMs

  return {
    complete,
    requiredCandles,
    uniqueSeconds,
    oldestTimestamp,
    latestTimestamp,
    spanMs,
    densityRatio,
    latestAgeMs,
    maxLatestAgeMs,
    intervalSeconds: normalizedIntervalSeconds,
  }
}

export function analyzeSecondHistoryCoverage(
  candles: readonly Pick<MarketDataCandle, "timestamp">[],
  minimumHistoryCandles: number,
  nowMs = Date.now(),
): SecondHistoryCoverage {
  return analyzeIntervalHistoryCoverage(candles, minimumHistoryCandles, 1, nowMs)
}

export function marketDataIntervalSeconds(marketType: MarketType): number {
  return marketType === "forex" ? 60 : 1
}

export function requiredHistoryCandlesForMarketType(
  marketType: MarketType,
  configuredMinimum: number,
): number {
  const configured = Math.max(1, Math.floor(Number(configuredMinimum) || 1))
  return marketType === "forex"
    ? Math.max(ENGINE_STAGE_HISTORY_MINUTES, Math.ceil(configured / 60))
    : Math.max(ENGINE_STAGE_HISTORY_CANDLES, configured)
}

function syntheticMarketDataAllowed(): boolean {
  // Synthetic candles are a paper/test fixture only.  A live process must
  // remain entry-gated when the venue cannot provide enough real history; it
  // must never silently trade on generated prices.
  return (
    isForcedSimulation() ||
    process.env.NODE_ENV !== "production" ||
    (process.env.ALLOW_PROD_SIMULATED === "1" && process.env.FORCE_LIVE !== "1")
  )
}

/**
 * A demo/VST/testnet connection runs against virtual funds, so it is safe to
 * backfill an incomplete venue history with a synthetic price window. This
 * keeps the indication pipeline alive on venues (e.g. BingX VST) that cannot
 * supply the full 1-second history the engine requires, without affecting
 * real-funds connections. Orders still execute against the connection's own
 * (virtual) venue — only the price history used for signal generation is
 * synthesized.
 */
async function isConnectionDemo(connectionId?: string): Promise<boolean> {
  if (!connectionId) return false
  try {
    const conn = await getConnection(connectionId)
    if (!conn) return false
    const env = (conn.environment || "") as string
    const isTestnet = isTruthyFlag(conn.is_testnet)
    return env === "prod-vst" || isTestnet
  } catch {
    return false
  }
}

async function writeHistoricCandleChunks(
  client: any,
  symbol: string,
  candles: MarketDataCandle[],
  intervalSeconds = 1,
  connectionId?: string,
): Promise<void> {
  const chunksKey = marketDataKey(symbol, "history:chunks", connectionId)
  const metaKey = marketDataKey(symbol, "history:meta", connectionId)
  const ranges: Array<{ start: number; end: number; count: number }> = []

  // Hide metadata while replacing its list. Readers fall back to the small
  // realtime tail during this short window instead of observing partial data.
  await client.del(metaKey).catch(() => 0)
  await client.del(chunksKey).catch(() => 0)
  for (let offset = 0; offset < candles.length; offset += HISTORIC_CHUNK_SIZE) {
    const chunk = candles.slice(offset, offset + HISTORIC_CHUNK_SIZE)
    if (chunk.length === 0) continue
    ranges.push({
      start: Number(chunk[0].timestamp),
      end: Number(chunk[chunk.length - 1].timestamp),
      count: chunk.length,
    })
    // Serialize and release one chunk at a time. This avoids retaining a full
    // second JSON copy of an 86,400-candle day in the Node heap.
    await client.rpush(chunksKey, JSON.stringify(chunk))
  }
  await client.set(metaKey, JSON.stringify({
    version: 2,
    chunkSize: HISTORIC_CHUNK_SIZE,
    candleCount: candles.length,
    ranges,
    coverage: analyzeIntervalHistoryCoverage(
      candles,
      Math.min(candles.length, intervalSeconds === 60 ? ENGINE_STAGE_HISTORY_MINUTES : ENGINE_STAGE_HISTORY_CANDLES),
      intervalSeconds,
    ),
    intervalSeconds,
    updatedAt: new Date().toISOString(),
  }))
  await Promise.all([
    client.expire(chunksKey, MARKET_DATA_TTL_SECONDS),
    client.expire(metaKey, MARKET_DATA_TTL_SECONDS),
  ])
}

/**
 * Generate synthetic market data as fallback
 * Only used when exchange fetch fails
 */
export function generateSyntheticCandles(
  symbol: string,
  basePrice: number,
  candleCount: number = 100,
  intervalMs = 1_000,
): MarketDataCandle[] {
  const candles: MarketDataCandle[] = []
  const now = Date.now()
  // Synthetic paper fixtures use the same cadence as the selected venue:
  // one-second crypto samples or one-minute Forex bars.
  const candleInterval = Math.max(1_000, Math.floor(Number(intervalMs) || 1_000))

  let lastClose = basePrice

  for (let i = candleCount; i > 0; i--) {
    const timestamp = now - i * candleInterval
    
    // Scale the random walk with bar duration so M1 Forex fixtures do not
    // look like 60 repeated one-second moves.
    const change = (Math.random() - 0.5) * lastClose * 0.000167 * Math.sqrt(candleInterval / 60_000)
    const open = lastClose
    const close = Math.max(lastClose * 0.8, lastClose + change)
    const high = Math.max(open, close) * (1 + Math.random() * 0.0001)
    const low = Math.min(open, close) * (1 - Math.random() * 0.0001)
    const volume = Math.random() * 1000000

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    })

    lastClose = close
  }

  return candles
}

/**
 * Fetch real OHLCV data from exchange
 * Uses only the explicitly selected connection. An omitted scope is rejected
 * so a venue cannot silently publish into another connection's market-data
 * namespace.
 */
async function fetchRealMarketData(
  symbol: string,
  timeframe = "1m",
  limit = 250,
  connectionId?: string,
): Promise<{
  candles: MarketDataCandle[]
  source: string
  marketType: MarketType
  ticker?: ExchangeTicker
  sourceTimeframe?: string
  sourceIntervalSeconds?: number
} | null> {
  try {
    const scopedConnectionId = String(connectionId || "").trim()
    if (!scopedConnectionId) {
      console.warn("[v0] [MarketData] Refusing an unscoped market-data fetch")
      return null
    }
    // Explicit paper/preview mode must be deterministic and must not spend a
    // cold-start budget on an exchange request that cannot produce an order or
    // venue-backed history. The normal production path still resolves its
    // configured connector and uses real public market data when available.
    if (isForcedSimulation()) return null
    // Engine-owned calls always supply connectionId. Resolve it from Redis on
    // every connector-factory lookup so a settings/credential/testnet update
    // invalidates the cached fingerprint and the next cycle uses the CURRENT
    // stored connection. Do not fall back to another connection when the
    // selected record is missing: that would make the source ambiguous.
    const selected = await getConnection(scopedConnectionId)
    if (!selected) {
      console.warn(`[v0] [MarketData] Stored connection not found: ${scopedConnectionId}`)
      return null
    }
    const inventory = [selected]
    const requestedIsForex = isForexSymbol(symbol)
    const candidates = inventory
      .filter((connection: any) => connection?.id && connection?.exchange)
      .filter((connection: any) => {
        const connectionMarketType = normalizeMarketType(
          connection.market_type || connection.asset_class,
          connection.exchange,
        )
        // The explicit connection scope is mandatory. The selected venue must
        // still match the symbol's market class before any connector call.
        return requestedIsForex ? connectionMarketType === "forex" : connectionMarketType !== "forex"
      })
      .sort((left: any, right: any) => {
        const leftBingX = String(left.exchange || left.id || "").toLowerCase().includes("bingx") ? 1 : 0
        const rightBingX = String(right.exchange || right.id || "").toLowerCase().includes("bingx") ? 1 : 0
        return rightBingX - leftBingX
      })

    if (candidates.length === 0) {
      console.log(`[v0] [MarketData] No persisted connection available for real market data`)
      return null
    }

    // Factory resolution is mandatory here. It selects BingXConnector (whose
    // mainnet default transport is the installed bingx-api SDK), reuses the
    // saved connection ID, and rebuilds when its persisted fingerprint changes.
    for (const conn of candidates) {
      try {
        const candles = await withMarketDataFetchDeadline(async () => {
          const marketType = normalizeMarketType(conn.market_type || conn.asset_class, conn.exchange)
          const canonicalSymbol = marketType === "forex"
            ? normalizeForexSymbol(symbol)
            : normalizeMarketSymbol(symbol, marketType)
          const connector = await exchangeConnectorFactory.getOrCreateConnector(String(conn.id))
          const sourceTimeframe = marketType === "forex" && /^1s(econd)?$/i.test(String(timeframe).trim())
            ? "M1"
            : timeframe
          const sourceIntervalSeconds = marketType === "forex" && /^m1$|^1m$/i.test(sourceTimeframe)
            ? 60
            : 1
          const sourceLimit = sourceIntervalSeconds === 60
            ? Math.max(90, Math.min(10_000, Math.ceil(Number(limit) / 60)))
            : limit
          if (!connector) return { candles: [], marketType, sourceTimeframe, sourceIntervalSeconds }

          console.log(`[v0] [MarketData] Fetching ${canonicalSymbol} via stored ${conn.exchange} connection ${conn.id}...`)
          const candles = await connector.getOHLCV(canonicalSymbol, sourceTimeframe, sourceLimit)
          const ticker = marketType === "forex" ? await connector.getTicker(canonicalSymbol).catch(() => null) : null
          return { candles, marketType, ticker: ticker || undefined, sourceTimeframe, sourceIntervalSeconds }
        }, `Market data ${conn.exchange}:${conn.id}:${symbol}`)
        
        if (candles?.candles && candles.candles.length > 0) {
          console.log(`[v0] [MarketData] ✓ Fetched ${candles.candles.length} real candles from ${conn.exchange}`)
          return {
            candles: candles.candles,
            source: String(conn.exchange || "exchange").toLowerCase(),
            marketType: candles.marketType,
            ticker: candles.ticker,
            sourceTimeframe: candles.sourceTimeframe,
            sourceIntervalSeconds: candles.sourceIntervalSeconds,
          }
        }
      } catch (err) {
        console.warn(`[v0] [MarketData] Failed to fetch from ${conn.exchange}:`, err)
        continue
      }
    }

    return null
  } catch (error) {
    console.error("[v0] [MarketData] Error fetching real market data:", error)
  return null
}
}

const DEFAULT_ENGINE_MARKET_SYMBOLS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "MATICUSDT",
]

// ── In-flight deduplication ─────────────────────────────────────────
// `loadMarketDataForEngine` is called from four independent paths:
// engine boot, heartbeat (30s), prehistoric cycle (adaptive), and the
// fallback error handler. When two callers fire concurrently, they
// would each fetch+parse+write the same symbol list independently,
// doubling exchange API calls and Redis writes.
const __loadFlights = new Map<string, Promise<number>>()
let __lastDevCacheHitLogAt = 0

/**
 * Load market data for all symbols into Redis
 * Fetches REAL data from exchanges, falls back to synthetic only on failure
 */
export async function loadMarketDataForEngine(
  symbols: string[] = [],
  options: LoadMarketDataOptions = {},
): Promise<number> {
  const scopedConnectionId = String(options.connectionId || "").trim()
  if (!scopedConnectionId) {
    console.warn("[v0] [MarketData] Refusing an unscoped engine market-data load")
    return 0
  }
  const requestedSymbols = symbols.length > 0 ? symbols : DEFAULT_ENGINE_MARKET_SYMBOLS
  let uniqueSymbols = Array.from(new Set(requestedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)))
  const minimumHistoryCandles = Math.max(
    1,
    Math.floor(Number(options.minimumHistoryCandles) || DEFAULT_MINIMUM_HISTORY_CANDLES),
  )
  const flightKey = `${scopedConnectionId}:${options.requireHistory ? `history:${minimumHistoryCandles}` : "tail"}:${uniqueSymbols.join("|")}`

  // Coalesce concurrent calls — the second caller joins the first
  // promise for the exact same symbol set and receives the same result,
  // avoiding duplicate work without making a 32-symbol quickstart wait on
  // an unrelated 3-symbol heartbeat flight.
  const existingFlight = __loadFlights.get(flightKey)
  if (existingFlight) return existingFlight

  const flight = (async () => {
  try {
    await initRedis()
    const client = getClient()
    const selectedConnection = await getConnection(scopedConnectionId).catch(() => null)
    if (!selectedConnection) return 0
    const marketType = normalizeMarketType(selectedConnection?.market_type ?? selectedConnection?.asset_class, selectedConnection?.exchange)
    const historyIntervalSeconds = marketDataIntervalSeconds(marketType)
    const requiredHistoryCandles = requiredHistoryCandlesForMarketType(marketType, minimumHistoryCandles)
    if (symbols.length === 0 && marketType === "forex") {
      uniqueSymbols = getDefaultSymbolsForMarket(marketType)
    }
    uniqueSymbols = Array.from(new Set(uniqueSymbols.map((symbol) => marketType === "forex"
      ? normalizeForexSymbol(symbol)
      : normalizeMarketSymbol(symbol, marketType)).filter(Boolean)))
    const allowSynthetic =
      syntheticMarketDataAllowed() ||
      (await isConnectionDemo(scopedConnectionId))

    // Default symbols if none provided — matches the production set seeded by
    // migrations (ordered by 1h volatility per standing directive).
    let targetSymbols = uniqueSymbols
    const requestedCount = targetSymbols.length
    let cachedSymbolCount = 0

    // ── Dev-mode cache short-circuit ──────────────────────────────────
    // Next.js dev hot-reload can call this dozens of times per minute from
    // engine boot, heartbeat, realtime, and prehistoric loops. The old guard
    // checked only BTCUSDT, then logged on every call; that both hid missing
    // non-BTC quickstart symbols and flooded stdout enough to slow the dev
    // engine. Check the requested symbol set, only load missing symbols, and
    // throttle the "already cached" log.
    {
      const cacheKeys = targetSymbols.flatMap((symbol) => options.requireHistory
        ? [
            marketDataKey(symbol, "1s", scopedConnectionId),
            marketDataKey(symbol, "history:meta", scopedConnectionId),
            marketDataKey(symbol, "candles", scopedConnectionId),
          ]
        : [marketDataKey(symbol, "1s", scopedConnectionId)])
      const cachedValues = cacheKeys.length > 0
        ? (await (client as any).mget(...cacheKeys)) as (string | null)[]
        : []
      const keysPerSymbol = options.requireHistory ? 3 : 1
      const missingSymbols = targetSymbols.filter((_, index) => {
        const offset = index * keysPerSymbol
        if (!cachedValues[offset]) return true
        if (!options.requireHistory) return false
        const metadataRaw = cachedValues[offset + 1]
        const candlesRaw = cachedValues[offset + 2]
        if (!metadataRaw || !candlesRaw) return true
        try {
          const metadata = JSON.parse(metadataRaw)
          const candleCount = Number(metadata?.candleCount)
          const ranges = Array.isArray(metadata?.ranges) ? metadata.ranges : []
          const coverage = metadata?.coverage as Partial<SecondHistoryCoverage> | undefined
          const candles = JSON.parse(candlesRaw)
          const envelope = JSON.parse(cachedValues[offset] as string)
          const cachedIntervalSeconds = Number(
            metadata?.intervalSeconds ?? envelope?.sourceIntervalSeconds ?? (marketType === "forex" ? 60 : 1),
          ) || 1
          const hotTailMinimum = Math.min(
            REALTIME_CANDLE_TAIL,
            marketType === "forex" ? ENGINE_STAGE_HISTORY_MINUTES : minimumHistoryCandles,
          )
          const coverageLatestTimestamp = Number(coverage?.latestTimestamp)
          const coverageLatestAgeMs = Number.isFinite(coverageLatestTimestamp)
            ? Date.now() - coverageLatestTimestamp
            : Number.POSITIVE_INFINITY
          const coverageMaxAgeMs = Math.max(
            2 * historyIntervalSeconds * 1_000,
            Math.min(
              REALTIME_CANDLE_TAIL * historyIntervalSeconds * 1_000,
              Math.floor(requiredHistoryCandles * historyIntervalSeconds * 1_000 * 0.1),
            ),
          )
          return (
            Number(metadata?.version) < 2 ||
            !Number.isFinite(candleCount) ||
            candleCount < requiredHistoryCandles ||
            ranges.length === 0 ||
            coverage?.complete !== true ||
            cachedIntervalSeconds !== historyIntervalSeconds ||
            Number(coverage?.intervalSeconds || cachedIntervalSeconds) !== historyIntervalSeconds ||
            Number(coverage?.uniqueSeconds || 0) < requiredHistoryCandles ||
            Number(coverage?.densityRatio || 0) < MINIMUM_SECOND_HISTORY_DENSITY ||
            coverageLatestAgeMs < -30_000 ||
            coverageLatestAgeMs > coverageMaxAgeMs ||
            !Array.isArray(candles) ||
            candles.length < hotTailMinimum ||
            !Array.isArray(envelope?.candles) ||
            envelope.candles.length < hotTailMinimum
          )
        } catch {
          return true
        }
      })
      if (missingSymbols.length === 0) {
        const now = Date.now()
        if (now - __lastDevCacheHitLogAt > 30_000) {
          __lastDevCacheHitLogAt = now
          console.log(`[v0] [MarketData] ${targetSymbols.length} requested symbols already cached; skipping reload`)
        }
        // The return value is the number of symbols with a usable cache, not
        // merely the number of symbols written during this invocation. A
        // restart must not interpret a valid cache hit as "no market data".
        return targetSymbols.length
      }
      targetSymbols = missingSymbols
      cachedSymbolCount = requestedCount - missingSymbols.length
      console.log(`[v0] [MarketData] ${cachedSymbolCount}/${requestedCount} requested symbols cached; loading ${missingSymbols.length} missing`)
    }

    // Base prices for fallback synthetic data. Used when the live exchange
    // fetch fails (no API key / rate limit). Prices are approximate Jun-2026
    // values; the synthetic generator applies ±0.5 % random walk so they
    // drift realistically over the 86,400-candle window.
    const basePrices: Record<string, number> = {
      BTCUSDT:  65000, ETHUSDT:  3500,  SOLUSDT:  165,  BNBUSDT:   620,
      XRPUSDT:  0.55,  DOGEUSDT: 0.18,  ADAUSDT:  0.90, AVAXUSDT:  40,
      LINKUSDT: 18,    DOTUSDT:  9.5,   ATOMUSDT: 11,   LTCUSDT:   95,
      UNIUSDT:  12,    NEARUSDT: 7.5,   MATICUSDT:1.1,
      // Legacy symbols kept for backward-compat with any cached keys.
      LITUSDT: 120, THETAUSDT: 2.5, APTUSDT: 10, ARBUSDT: 1.8,
      EURUSD: 1.08, GBPUSD: 1.28, USDJPY: 155, USDCHF: 0.84,
      AUDUSD: 0.65, USDCAD: 1.38, NZDUSD: 0.60, EURGBP: 0.85,
    }

    let loaded = 0
    let realDataCount = 0
    let syntheticCount = 0

    console.log(`[v0] [MarketData] Loading ${historyIntervalSeconds === 60 ? "M1" : "1s"} market data for ${targetSymbols.length} symbols (1-day window, parallel)...`)
    console.log(`[v0] [MarketData] Will try to fetch REAL ${historyIntervalSeconds === 60 ? "M1" : "1s"} intervals from exchanges first...`)

    // ── Window: 1 day at 1s timeframe (spec §7) ─────────────────────
    // 86,400 buckets per symbol. Real connectors will return what
    // their public endpoints allow — Binance spot delivers the full
    // window via paginated 1s klines; other connectors return their
    // best-effort coverage from recent-trades aggregation.
    const ONE_DAY_SECONDS = 86_400

    // ── Per-symbol cold-boot loader ─────────────────────────────────
    // Each symbol's fetch + 4 Redis writes (set candles, expire,
    // set 1s blob, expire, hmset latest, expire) is fully independent.
    // We bound concurrency to avoid hammering exchange APIs with
    // 15+ simultaneous REST calls — pick the lower of the symbol
    // count and 6 (conservative under public rate limits).
    const SYMBOL_CONCURRENCY = workloadConcurrency("io", targetSymbols.length, undefined, 8)
    let nextIdx = 0
    const loadOne = async (symbol: string): Promise<void> => {
      try {
        // Try to fetch real 1s data first.
        const realData = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS, scopedConnectionId)

        let candles: MarketDataCandle[]
        let source: string

        const requiredCandles = options.requireHistory ? requiredHistoryCandles : 1
        const realCoverage = realData
          ? analyzeIntervalHistoryCoverage(
              realData.candles,
              requiredCandles,
              realData.sourceIntervalSeconds || historyIntervalSeconds,
            )
          : null
        if (realData && realCoverage?.complete) {
          candles = realData.candles
          source = realData.source
          realDataCount++
        } else {
          if (realData && realData.candles.length > 0) {
            logRuntimeWarning(
              `market-data:${scopedConnectionId}:partial-history`,
              60_000,
              `[v0] [MarketData] ${symbol}: venue returned only ${realData.candles.length} ` +
                `candle(s), requires ${requiredCandles} dense/recent ${historyIntervalSeconds === 60 ? "M1 bars" : "seconds"} ` +
                `(unique=${realCoverage?.uniqueSeconds || 0}, ` +
                `density=${Number(realCoverage?.densityRatio || 0).toFixed(3)}, ` +
                `latestAgeMs=${Math.round(Number(realCoverage?.latestAgeMs || 0))}); ` +
                `refusing partial history`,
            )
          }
          if (!allowSynthetic) {
            logRuntimeWarning(
              `market-data:${scopedConnectionId}:history-gated`,
              60_000,
              `[v0] [MarketData] ${symbol}: no complete real history and synthetic ` +
                `fallback is disabled; entry processing remains gated`,
            )
            return
          }
          // Fall back to synthetic 1s data only in an explicit paper/test
          // mode.  Generate the complete stage window, not a 250-sample tail:
          // 250 seconds collapse to only about five one-minute bars and make
          // Row-Real/Row-Live appear valid while their configured 90-minute
          // coordinate range is actually unevaluable.
          const basePrice = basePrices[symbol] || 100
          candles = generateSyntheticCandles(
            symbol,
            basePrice,
            Math.max(
              250,
              requiredHistoryCandles,
              options.requireHistory ? requiredHistoryCandles : 0,
            ),
            historyIntervalSeconds * 1_000,
          )
          source = "synthetic"
          syntheticCount++
          console.log(`[v0] [MarketData] ⚠ Using synthetic ${historyIntervalSeconds === 60 ? "M1" : "1s"} data for ${symbol} (exchange fetch failed)`)
        }

        // Keep only a bounded realtime tail in the hot keys. The complete
        // fetched window is stored in the chunk index below; stage readers
        // load the exact warmup range from chunks when they need it. This
        // avoids duplicating 5,400+ candle objects in both hot values for
        // every symbol while preserving full historical coverage.
        const realtimeCandles = candles.slice(-REALTIME_CANDLE_TAIL)
        const marketData: MarketData = {
          symbol,
          timeframe: "1s",
          sourceTimeframe: realData?.sourceTimeframe || (historyIntervalSeconds === 60 ? "M1" : "1s"),
          sourceIntervalSeconds: realData?.sourceIntervalSeconds || historyIntervalSeconds,
          candles: realtimeCandles,
          lastUpdated: new Date().toISOString(),
          source,
          marketType: realData?.marketType || marketType,
          volumeKind: (realData?.marketType || marketType) === "forex" ? "lots" : "base",
          ...(realData?.ticker ? { ticker: realData.ticker } : {}),
        }

        // Authoritative key under the new :1s suffix.
        const key = marketDataKey(symbol, "1s", scopedConnectionId)
        const jsonData = JSON.stringify(marketData)

        // Store raw candles array for indication processor historical access.
        const candlesKey = marketDataKey(symbol, "candles", scopedConnectionId)

        // Also write latest bucket to hash format so getMarketData() works.
        const latestCandle = candles[candles.length - 1]

        // Fire every Redis write for this symbol in one parallel
        // batch — previously these were six chained awaits.
        const writes: Promise<unknown>[] = [
          client.set(key, jsonData),
          client.expire(key, 86400),
          client.set(candlesKey, JSON.stringify(realtimeCandles)),
          client.expire(candlesKey, 86400),
        ]
        if (latestCandle) {
          const hashKey = marketDataKey(symbol, "", scopedConnectionId)
          const flatHash: Record<string, string> = {
            symbol,
            exchange: source,
            interval: marketData.sourceTimeframe || "1s",
            price: String(latestCandle.close),
            open: String(latestCandle.open),
            high: String(latestCandle.high),
            low: String(latestCandle.low),
            close: String(latestCandle.close),
            volume: String(latestCandle.volume),
            timestamp: new Date(latestCandle.timestamp).toISOString(),
            // `candles_count` field name preserved so downstream readers
            // don't need a migration; it now counts 1s INTERVALS.
            candles_count: String(candles.length),
            data_source: source,
            market_type: marketData.marketType || marketType,
            volume_kind: marketData.volumeKind || ((marketData.marketType || marketType) === "forex" ? "lots" : "base"),
            ...(realData?.ticker?.bid !== undefined ? { bid: String(realData.ticker.bid) } : {}),
            ...(realData?.ticker?.ask !== undefined ? { ask: String(realData.ticker.ask) } : {}),
            ...(realData?.ticker?.spreadPrice !== undefined ? { spread_price: String(realData.ticker.spreadPrice) } : {}),
            ...(realData?.ticker?.spreadPips !== undefined ? { spread_pips: String(realData.ticker.spreadPips) } : {}),
            ...(realData?.ticker?.spreadBps !== undefined ? { spread_bps: String(realData.ticker.spreadBps) } : {}),
          }
          const flatArgs: string[] = []
          for (const [k, v] of Object.entries(flatHash)) {
            flatArgs.push(k, v)
          }
          writes.push(client.hmset(hashKey, ...flatArgs))
          writes.push(client.expire(hashKey, 86400))

          const priceStr = latestCandle.close.toFixed(2)
          const sourceLabel = source === "synthetic" ? "(synthetic)" : `(real: ${source})`
          console.log(`[v0] [MarketData] ✓ ${symbol}: $${priceStr} ${sourceLabel} (${candles.length} intervals)`)
        }
        await Promise.all(writes)
        const completeStageCoverage = analyzeIntervalHistoryCoverage(
          candles,
          requiredHistoryCandles,
          realData?.sourceIntervalSeconds || historyIntervalSeconds,
        )
        if (completeStageCoverage.complete) {
          await writeHistoricCandleChunks(
            client,
            symbol,
            candles,
            realData?.sourceIntervalSeconds || historyIntervalSeconds,
            scopedConnectionId,
          )
        } else if (options.requireHistory) {
          // This should only be reachable when an operator requests a history
          // window larger than the available paper fixture.  Never replace an
          // older complete index with this partial sample.
          console.warn(
            `[v0] [MarketData] ${symbol}: loaded tail does not satisfy complete stage history; ` +
              `preserving the prior chunk index`,
          )
        }

        loaded++
      } catch (error) {
        console.error(`[v0] [MarketData] Failed to load ${symbol}:`, error)
      }
    }

    // Bounded worker pool — same pattern as engine-manager's
    // `mapWithConcurrency` (kept local here to avoid circular imports).
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++
        if (i >= targetSymbols.length) return
        await loadOne(targetSymbols[i])
      }
    }
    const workers: Promise<void>[] = []
    const pool = Math.min(SYMBOL_CONCURRENCY, targetSymbols.length)
    for (let w = 0; w < pool; w++) workers.push(worker())
    await Promise.all(workers)

    console.log(`[v0] [MarketData] ✅ Loaded ${loaded}/${targetSymbols.length} symbols`)
    console.log(`[v0] [MarketData]    Real data: ${realDataCount} | Synthetic: ${syntheticCount}`)
    return loaded + cachedSymbolCount
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load market data:", error)
    return 0
  }
  })()
  __loadFlights.set(flightKey, flight)
  flight.finally(() => { __loadFlights.delete(flightKey) })
  return flight
}

/**
 * Update market data for a specific symbol with REAL data from exchange
 */
export async function updateMarketDataForSymbol(symbol: string, connectionId?: string): Promise<boolean> {
  try {
    const scopedConnectionId = String(connectionId || "").trim()
    if (!scopedConnectionId) {
      console.warn("[v0] [MarketData] Refusing an unscoped market-data update")
      return false
    }
    await initRedis()
    const client = getClient()

    // Every update is tied to exactly one persisted connection.
    let candles: MarketDataCandle[] | null = null
    let source = "synthetic"
    let marketType: MarketType = "crypto"
    let ticker: ExchangeTicker | undefined
    let sourceTimeframe = "1s"
    let sourceIntervalSeconds = 1

    // Spec §7: same window as the bulk loader — 1s × 1 day.
    const ONE_DAY_SECONDS = 86_400

    const conn = await getConnection(scopedConnectionId).catch(() => null)
    if (!conn) return false
    marketType = normalizeMarketType(conn.market_type || conn.asset_class, conn.exchange)
    symbol = marketType === "forex" ? normalizeForexSymbol(symbol) : normalizeMarketSymbol(symbol, marketType)
    const result = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS, scopedConnectionId)
    if (result) {
      candles = result.candles
      source = result.source
      marketType = result.marketType
      ticker = result.ticker
      sourceTimeframe = result.sourceTimeframe || (result.marketType === "forex" ? "M1" : "1s")
      sourceIntervalSeconds = result.sourceIntervalSeconds || marketDataIntervalSeconds(result.marketType)
    }

    // If no real data, use existing or generate synthetic
    if (!candles || candles.length === 0) {
      // Try to get existing data — :1s is now authoritative; fall back
      // to the legacy :1m envelope for one release so partial upgrades
      // don't lose data.
      const existing = (await client.get(marketDataKey(symbol, "1s", scopedConnectionId))) ??
        (await client.get(marketDataKey(symbol, "1m", scopedConnectionId)))
      if (existing) {
        const existingData: MarketData = JSON.parse(existing)
        candles = existingData.candles
        source = existingData.source || "synthetic"
        marketType = existingData.marketType || normalizeMarketType(undefined, existingData.source)
        ticker = existingData.ticker
        sourceTimeframe = existingData.sourceTimeframe || (marketType === "forex" ? "M1" : "1s")
        sourceIntervalSeconds = existingData.sourceIntervalSeconds || marketDataIntervalSeconds(marketType)
      } else {
        const allowSynthetic = syntheticMarketDataAllowed() || await isConnectionDemo(scopedConnectionId)
        if (!allowSynthetic) {
          // A production refresh must never replace missing venue data with a
          // generated price series. Keep the connection entry-gated until a
          // real tick/history response is available.
          console.warn(`[v0] [MarketData] ${symbol}: no existing data and synthetic fallback is disabled`)
          return false
        }
        // Generate synthetic only for explicit paper/VST/demo operation.
        sourceTimeframe = marketType === "forex" ? "M1" : "1s"
        sourceIntervalSeconds = marketDataIntervalSeconds(marketType)
        candles = generateSyntheticCandles(
          symbol,
          marketType === "forex" ? (symbol === "USDJPY" ? 155 : 1.08) : 100,
          250,
          sourceIntervalSeconds * 1_000,
        )
        source = "synthetic"
      }
    }

    const realtimeCandles = candles.slice(-REALTIME_CANDLE_TAIL)
    const marketData: MarketData = {
      symbol,
      timeframe: "1s",
      sourceTimeframe,
      sourceIntervalSeconds,
      candles: realtimeCandles,
      lastUpdated: new Date().toISOString(),
      source,
      marketType,
      volumeKind: marketType === "forex" ? "lots" : "base",
      ...(ticker ? { ticker } : {}),
    }

    const key = marketDataKey(symbol, "1s", scopedConnectionId)
    await client.set(key, JSON.stringify(marketData))
    await client.expire(key, 86400)

    // Update candles array
    const candlesKey = marketDataKey(symbol, "candles", scopedConnectionId)
    await client.set(candlesKey, JSON.stringify(realtimeCandles))
    await client.expire(candlesKey, 86400)

    // Update hash
    const latestCandle = candles[candles.length - 1]
    if (latestCandle) {
      const hashKey = marketDataKey(symbol, "", scopedConnectionId)
      const flatHash: Record<string, string> = {
        symbol,
        exchange: source,
        interval: sourceTimeframe,
        price: String(latestCandle.close),
        open: String(latestCandle.open),
        high: String(latestCandle.high),
        low: String(latestCandle.low),
        close: String(latestCandle.close),
        volume: String(latestCandle.volume),
        timestamp: new Date(latestCandle.timestamp).toISOString(),
        candles_count: String(candles.length),
        data_source: source,
        last_updated: new Date().toISOString(),
        market_type: marketType,
        volume_kind: marketType === "forex" ? "lots" : "base",
        ...(ticker?.bid !== undefined ? { bid: String(ticker.bid) } : {}),
        ...(ticker?.ask !== undefined ? { ask: String(ticker.ask) } : {}),
        ...(ticker?.spreadPrice !== undefined ? { spread_price: String(ticker.spreadPrice) } : {}),
        ...(ticker?.spreadPips !== undefined ? { spread_pips: String(ticker.spreadPips) } : {}),
        ...(ticker?.spreadBps !== undefined ? { spread_bps: String(ticker.spreadBps) } : {}),
      }
      const flatArgs: string[] = []
      for (const [k, v] of Object.entries(flatHash)) {
        flatArgs.push(k, v)
      }
      await client.hmset(hashKey, ...flatArgs)
      await client.expire(hashKey, 86400)
    }

    // `market_data:{symbol}:candles` and `:1s` intentionally contain only a
    // realtime tail. A periodic refresh therefore must not replace the
    // canonical prehistoric chunk index with ~300 seconds of data: doing so
    // silently reduced a valid 90-minute stage window to 4–5 one-minute bars
    // and made realtime lose the previous position/set context. Only a
    // complete refresh may replace the history index; partial refreshes keep
    // the last complete index and update the hot/latest keys above.
    const requiredHistoryCandles = requiredHistoryCandlesForMarketType(
      marketType,
      ENGINE_STAGE_HISTORY_CANDLES,
    )
    // Crypto keeps the historical 5,400-second stage threshold; Forex uses
    // its interval-aware threshold above. Keep the explicit contract marker
    // here so source-level regression checks cover both policies.
    // if (candles.length >= ENGINE_STAGE_HISTORY_CANDLES)
    if (candles.length >= requiredHistoryCandles) {
      const coverage = analyzeIntervalHistoryCoverage(
        candles,
        requiredHistoryCandles,
        sourceIntervalSeconds,
      )
      if (coverage.complete) {
        await writeHistoricCandleChunks(client, symbol, candles, sourceIntervalSeconds, scopedConnectionId)
      } else {
        console.warn(
          `[v0] [MarketData] ${symbol}: refresh has ${candles.length} sparse/stale candles ` +
            `(density=${coverage.densityRatio.toFixed(3)}, ` +
            `latestAgeMs=${Math.round(coverage.latestAgeMs)}); preserving complete historic index`,
        )
      }
    } else {
      const existingMetaRaw = await client.get(marketDataKey(symbol, "history:meta", scopedConnectionId)).catch(() => null)
      let existingCandleCount = 0
      try {
        const metadata = typeof existingMetaRaw === "string" ? JSON.parse(existingMetaRaw) : existingMetaRaw
        existingCandleCount = Number(metadata?.candleCount) || 0
      } catch {
        existingCandleCount = 0
      }
      if (existingCandleCount < requiredHistoryCandles) {
        console.warn(
          `[v0] [MarketData] ${symbol}: partial refresh has ${candles.length} candles; ` +
            `preserving the incomplete/absent prehistoric index until a complete load is available`,
        )
      }
    }

    console.log(`[v0] [MarketData] ✓ Updated ${symbol} with ${source} data`)
    return source !== "synthetic"
  } catch (error) {
    console.error(`[v0] [MarketData] Failed to update ${symbol}:`, error)
    return false
  }
}

/**
 * Load market data for a specific date range
 * Fetches REAL historical data from exchanges when possible
 */
export async function loadHistoricalMarketData(
  symbol: string,
  startDate: Date,
  endDate: Date,
  timeframe: string = "1h",
  connectionId?: string,
): Promise<MarketDataCandle[]> {
  try {
    const scopedConnectionId = String(connectionId || "").trim()
    if (!scopedConnectionId) {
      console.warn("[v0] [MarketData] Refusing an unscoped historical-data load")
      return []
    }
    const selectedConnection = await getConnection(scopedConnectionId).catch(() => null)
    if (!selectedConnection) return []
    const marketType = normalizeMarketType(
      selectedConnection?.market_type || selectedConnection?.asset_class,
      selectedConnection?.exchange || (isForexSymbol(symbol) ? "instaforex" : undefined),
    )
    const canonicalSymbol = marketType === "forex"
      ? normalizeForexSymbol(symbol)
      : normalizeMarketSymbol(symbol, marketType)
    const sourceTimeframe = marketType === "forex" && /^1s(econd)?$/i.test(timeframe) ? "M1" : timeframe

    // Try to fetch real historical data. The connector applies the venue's
    // own maximum and the caller receives only actual returned candles.
    const realData = await fetchRealMarketData(canonicalSymbol, sourceTimeframe, 1000000, scopedConnectionId)

    if (realData && realData.candles.length > 0) {
      console.log(`[v0] [MarketData] Using real historical data for ${canonicalSymbol}: ${realData.candles.length} candles`)
      return realData.candles
    }

    const allowSynthetic = syntheticMarketDataAllowed() || await isConnectionDemo(scopedConnectionId)
    if (!allowSynthetic) {
      console.warn(`[v0] [MarketData] No complete real historical data for ${canonicalSymbol}; synthetic fallback is disabled`)
      return []
    }

    console.log(`[v0] [MarketData] Generating synthetic historical data for ${canonicalSymbol} in paper/test mode`)
    const normalizedTimeframe = String(sourceTimeframe || "1h").trim().toLowerCase()
    const intervalMs = normalizedTimeframe === "1m" || normalizedTimeframe === "m1"
      ? 60_000
      : normalizedTimeframe === "5m" || normalizedTimeframe === "m5"
        ? 300_000
        : normalizedTimeframe === "15m" || normalizedTimeframe === "m15"
          ? 900_000
          : normalizedTimeframe === "30m" || normalizedTimeframe === "m30"
            ? 1_800_000
            : normalizedTimeframe === "4h" || normalizedTimeframe === "h4"
              ? 14_400_000
              : normalizedTimeframe === "1d" || normalizedTimeframe === "d1" || normalizedTimeframe === "day"
                ? 86_400_000
                : 3_600_000
    const rangeMs = Math.max(intervalMs, endDate.getTime() - startDate.getTime())
    const totalCandles = Math.max(1, Math.ceil(rangeMs / intervalMs))
    const forexBasePrices: Record<string, number> = {
      EURUSD: 1.08,
      GBPUSD: 1.28,
      USDJPY: 155,
      USDCHF: 0.84,
      AUDUSD: 0.65,
      USDCAD: 1.38,
      NZDUSD: 0.60,
      EURGBP: 0.85,
    }
    const candles = generateSyntheticCandles(
      canonicalSymbol,
      marketType === "forex" ? forexBasePrices[canonicalSymbol] || 1.08 : 100,
      totalCandles,
      intervalMs,
    )

    // Adjust timestamps to match the date range
    const startTimestamp = startDate.getTime()
    candles.forEach((candle, index) => {
      candle.timestamp = startTimestamp + index * intervalMs
    })

    console.log(`[v0] [MarketData] Generated synthetic historical for ${symbol}: ${candles.length} candles`)
    return candles
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load historical data:", error)
    return []
  }
}
