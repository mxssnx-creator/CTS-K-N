/**
 * One-minute history for the Common indicators.
 *
 * The engine keeps about 90 minutes of 1-second stage history, which leaves 6
 * bars on 15m and 3 bars on 30m — almost no Common indicator can warm up there.
 * Common therefore reads a longer, real one-minute OHLCV history of COMPLETED
 * minutes only (the forming minute is never evaluated, so a Set or an Auto
 * vote cannot repaint within its minute):
 *
 *  - realtime: a per connection/symbol store of completed minutes, backfilled
 *    from the venue's real 1m klines (#559 `loadRangeMinuteBars`, which
 *    returns nothing for simulated / synthetic / forex series) and extended
 *    every cycle from the live 1s candles — no repeated venue reads. The
 *    store is persisted in Redis so a restart does not backfill again.
 *  - historic replay: the replay series already loaded, cut at the decision
 *    time — no venue reads, no look-ahead.
 *
 * Both return a view over an ANCHORED window: it starts on a 60-minute
 * boundary and covers commonHistoryMinutes() .. +59 minutes. Every decision
 * within one anchor hour therefore reads a prefix of the same series, so a
 * replay can compute the series once per hour and read it at each bar with
 * results identical to evaluating each bar's window separately.
 */
import { marketDataKey } from "@/lib/market-data-keys"
import { normalizeTechnicalCandles, resampleNormalizedCandles } from "./kn-math"
import { syntheticCandles } from "./synthetic"
import type { TechnicalCandle } from "./types"

const MINUTE_MS = 60_000

/** Window starts are aligned to this many minutes (see the module comment). */
export const COMMON_WINDOW_ANCHOR_MINUTES = 60

/** Minutes of Common history: 30 h gives 60 bars on the 30m timeframe (env COMMON_HISTORY_MINUTES, 90–2880). */
export function commonHistoryMinutes(): number {
  const configured = Number(process.env.COMMON_HISTORY_MINUTES)
  return Number.isFinite(configured) && configured > 0
    ? Math.max(90, Math.min(2_880, Math.round(configured)))
    : 1_800
}

/** The longest anchored window, i.e. the history a replay must load before its first decision. */
export function commonWarmupMinutes(): number {
  return commonHistoryMinutes() + COMMON_WINDOW_ANCHOR_MINUTES - 1
}

/** Start of the anchored window whose newest completed minute opens at `lastCompletedMs`. */
export function commonWindowStartMs(lastCompletedMs: number, historyMinutes = commonHistoryMinutes()): number {
  const anchorMs = COMMON_WINDOW_ANCHOR_MINUTES * MINUTE_MS
  return Math.floor((lastCompletedMs - (historyMinutes - 1) * MINUTE_MS) / anchorMs) * anchorMs
}

/** First index whose bar opens at or after `timestampMs` (bars oldest first). */
function lowerBound(bars: readonly TechnicalCandle[], timestampMs: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (bars[middle].timestamp < timestampMs) low = middle + 1
    else high = middle
  }
  return low
}

/** The anchored window ending at bars[index] (completed one-minute bars, oldest first). */
export function commonWindowSlice(bars: readonly TechnicalCandle[], index: number): TechnicalCandle[] {
  if (index < 0 || index >= bars.length) return []
  const start = lowerBound(bars, commonWindowStartMs(bars[index].timestamp))
  return bars.slice(start, index + 1)
}

export interface CommonHistoryView {
  /** completed one-minute bars, oldest first, timestamps in [windowStartMs, lastCompletedMs] */
  bars: TechnicalCandle[]
  windowStartMs: number
  /** open time of the newest completed minute */
  lastCompletedMs: number
  /** lastCompletedMs + 1 minute: higher-timeframe buckets ending after this are still forming */
  completedThroughMs: number
  contentHash: string
  /** changes exactly when the evaluated bars change */
  key: string
}

const hashScratch = new Float64Array(1)
const hashWords = new Uint32Array(hashScratch.buffer)

/** Two 32-bit lanes over the IEEE-754 bits of every OHLCV value. */
function barsContentHash(bars: readonly TechnicalCandle[]): string {
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  const mix = (value: number) => {
    hashScratch[0] = value
    const low = hashWords[0]
    const high = hashWords[1]
    left = Math.imul(left ^ low, 16777619)
    left = Math.imul(left ^ high, 16777619)
    right = Math.imul(right ^ high, 2246822519)
    right = Math.imul(right ^ low, 3266489917)
  }
  for (const bar of bars) {
    mix(bar.timestamp)
    mix(bar.open)
    mix(bar.high)
    mix(bar.low)
    mix(bar.close)
    mix(bar.volume)
  }
  return `${(left >>> 0).toString(36)}.${(right >>> 0).toString(36)}`
}

/** The anchored view over completed bars (oldest first). Null without bars. */
export function buildCommonHistoryView(completed: readonly TechnicalCandle[]): CommonHistoryView | null {
  if (completed.length === 0) return null
  const lastCompletedMs = completed[completed.length - 1].timestamp
  const windowStartMs = commonWindowStartMs(lastCompletedMs)
  const bars = completed.slice(lowerBound(completed, windowStartMs))
  const contentHash = barsContentHash(bars)
  return {
    bars,
    windowStartMs,
    lastCompletedMs,
    completedThroughMs: lastCompletedMs + MINUTE_MS,
    contentHash,
    key: `${windowStartMs}:${lastCompletedMs}:${bars.length}:${contentHash}`,
  }
}

function rawTimestampMs(raw: unknown): number {
  const candle = (raw || {}) as Record<string, unknown>
  return Number(candle.timestamp ?? candle.time ?? candle.t ?? candle.openTime)
}

/**
 * Completed one-minute bars of raw candles (1s or 1m, oldest first) that open
 * at or after `fromMs` and before `formingStartMs` (the forming minute).
 */
export function completedMinuteBars(candles: readonly unknown[], formingStartMs: number, fromMs = 0): TechnicalCandle[] {
  const normalized = normalizeTechnicalCandles(candles as unknown[])
    .filter((candle) => candle.timestamp > 10_000_000_000 && candle.timestamp >= fromMs && candle.timestamp < formingStartMs)
  return resampleNormalizedCandles(normalized, 1)
}

const STORE_SYMBOL_LIMIT = 256
const BACKFILL_RETRY_MS = 10 * 60_000
const PERSIST_EVERY_MS = 5 * 60_000
const STORE_TTL_SECONDS = 36 * 60 * 60
const LEADING_GAP_TOLERANCE_MS = 5 * MINUTE_MS

interface MinuteStore {
  bars: TechnicalCandle[]
  lastAttemptAt: number
  persistedAt: number
  restored: boolean
  mutation: number
  view: CommonHistoryView | null
  viewMutation: number
}

const stores = new Map<string, MinuteStore>()
const backfills = new Map<string, Promise<void>>()
const stats = { viewBuilds: 0, backfillAttempts: 0, backfillBars: 0, restores: 0 }

export type MinuteBarLoader = (
  symbol: string,
  options: { connectionId: string; startMs: number; endMs: number; nowMs?: number; referencePrice?: number },
) => Promise<unknown[]>

export interface CommonHistoryOptions {
  connectionId: string
  symbol: string
  /** the causal candles of this cycle (1s or 1m, oldest first) */
  candles: unknown[]
  /** decision time: the minute containing it is forming (replay); realtime uses the newest candle */
  asOfMs?: number
  mode: "realtime" | "historical"
  /** test seam: the venue's 1m kline reader (null: no backfill) */
  loadMinuteBars?: MinuteBarLoader | null
  /** test seam: Redis client for persistence */
  redis?: { get(key: string): Promise<any>; set(key: string, value: string, ...args: any[]): Promise<any> } | null
  /** wait for a pending backfill instead of continuing without it (tests, warm start) */
  awaitBackfill?: boolean
  /** test seam: wall clock */
  nowMs?: number
}

const storeKey = (connectionId: string, symbol: string) => `${connectionId}:${symbol}`

function touch(key: string): MinuteStore {
  let store = stores.get(key)
  if (store) {
    stores.delete(key)
    stores.set(key, store)
    return store
  }
  store = { bars: [], lastAttemptAt: 0, persistedAt: 0, restored: false, mutation: 0, view: null, viewMutation: -1 }
  stores.set(key, store)
  if (stores.size > STORE_SYMBOL_LIMIT) {
    const oldest = stores.keys().next().value
    if (oldest !== undefined) stores.delete(oldest)
  }
  return store
}

function sameBar(left: TechnicalCandle, right: TechnicalCandle): boolean {
  return left.open === right.open && left.high === right.high && left.low === right.low &&
    left.close === right.close && left.volume === right.volume
}

/** Union by minute, oldest first; on the same minute `preferred` wins. */
function unionByMinute(other: readonly TechnicalCandle[], preferred: readonly TechnicalCandle[]): TechnicalCandle[] {
  const out: TechnicalCandle[] = []
  let i = 0
  let j = 0
  while (i < other.length || j < preferred.length) {
    if (j >= preferred.length || (i < other.length && other[i].timestamp < preferred[j].timestamp)) out.push(other[i++])
    else {
      if (i < other.length && other[i].timestamp === preferred[j].timestamp) i++
      out.push(preferred[j++])
    }
  }
  return out
}

/** Apply live completed minutes to the store; returns whether any bar changed. */
function applyLiveMinutes(store: MinuteStore, fresh: readonly TechnicalCandle[]): boolean {
  if (fresh.length === 0) return false
  const bars = store.bars
  const last = bars[bars.length - 1]
  if (!last || fresh[0].timestamp >= last.timestamp) {
    // the common case: the live window re-reads the newest stored minute and appends
    let changed = false
    let start = 0
    if (last && fresh[0].timestamp === last.timestamp) {
      if (!sameBar(last, fresh[0])) {
        bars[bars.length - 1] = fresh[0]
        changed = true
      }
      start = 1
    }
    for (let index = start; index < fresh.length; index++) bars.push(fresh[index])
    return changed || fresh.length > start
  }
  const merged = unionByMinute(bars, fresh)
  const changed = merged.length !== bars.length || merged.some((bar, index) => bar !== bars[index])
  store.bars = merged
  return changed
}

function trimStore(store: MinuteStore): void {
  const keep = commonWarmupMinutes() + COMMON_WINDOW_ANCHOR_MINUTES
  if (store.bars.length > keep) store.bars.splice(0, store.bars.length - keep)
}

/** The first missing range of the anchored window, or null when it is covered. */
function missingRange(store: MinuteStore, windowStartMs: number, formingStartMs: number): { startMs: number; endMs: number; referencePrice?: number } | null {
  const bars = store.bars
  if (bars.length === 0) return { startMs: windowStartMs, endMs: formingStartMs }
  if (bars[0].timestamp > windowStartMs + LEADING_GAP_TOLERANCE_MS) {
    return { startMs: windowStartMs, endMs: bars[0].timestamp, referencePrice: bars[0].open }
  }
  for (let index = lowerBound(bars, windowStartMs) + 1; index < bars.length; index++) {
    if (bars[index].timestamp - bars[index - 1].timestamp > MINUTE_MS) {
      return { startMs: bars[index - 1].timestamp + MINUTE_MS, endMs: bars[index].timestamp, referencePrice: bars[index].open }
    }
  }
  return null
}

let defaultRedisClient: Promise<any> | null = null

function defaultRedis(): Promise<any> {
  defaultRedisClient ||= (async () => {
    try {
      const { getRedisClient, initRedis } = await import("@/lib/redis-db")
      await initRedis()
      return getRedisClient() as any
    } catch {
      defaultRedisClient = null
      return null
    }
  })()
  return defaultRedisClient
}

/**
 * Paper / stress runs only (COMMON_HISTORY_SIMULATED_BACKFILL=1 under forced
 * simulation): synthetic minutes joined to the first stored price, so a fresh
 * simulated engine evaluates the same window length as a real one.
 */
const syntheticMinuteLoader: MinuteBarLoader = async (symbol, options) => {
  const count = Math.max(0, Math.floor((options.endMs - options.startMs) / MINUTE_MS))
  if (count === 0) return []
  const bars = syntheticCandles(symbol, 1, count, options.endMs - MINUTE_MS, 11)
  const scale = Number(options.referencePrice) > 0 ? Number(options.referencePrice) / bars[bars.length - 1].close : 1
  return bars.map((bar) => ({
    ...bar,
    open: bar.open * scale,
    high: bar.high * scale,
    low: bar.low * scale,
    close: bar.close * scale,
  }))
}

async function defaultLoader(): Promise<MinuteBarLoader | null> {
  try {
    const { isForcedSimulation } = await import("@/lib/real-trade-gates")
    if (isForcedSimulation()) {
      return process.env.COMMON_HISTORY_SIMULATED_BACKFILL === "1" ? syntheticMinuteLoader : null
    }
    return (await import("@/lib/market-data-loader")).loadRangeMinuteBars
  } catch {
    return null
  }
}

async function restore(options: CommonHistoryOptions, store: MinuteStore, redis: any): Promise<void> {
  store.restored = true
  if (!redis) return
  try {
    const raw = await redis.get(marketDataKey(options.symbol, "common_1m", options.connectionId))
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed?.bars)) return
    const bars: TechnicalCandle[] = parsed.bars
      .map((row: unknown) => Array.isArray(row)
        ? { timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) || 0 }
        : null)
      .filter((bar: TechnicalCandle | null): bar is TechnicalCandle =>
        Boolean(bar && bar.close > 0 && bar.timestamp % MINUTE_MS === 0))
      .sort((left: TechnicalCandle, right: TechnicalCandle) => left.timestamp - right.timestamp)
    if (bars.length > 0) {
      // bars the live feed already added this process win
      store.bars = unionByMinute(bars, store.bars)
      store.mutation++
      stats.restores++
    }
  } catch {
    // an unreadable snapshot is rebuilt by the backfill
  }
}

async function persist(options: CommonHistoryOptions, store: MinuteStore, redis: any, now: number): Promise<void> {
  if (!redis || now - store.persistedAt < PERSIST_EVERY_MS || store.bars.length === 0) return
  store.persistedAt = now
  const payload = JSON.stringify({
    v: 1,
    savedAt: now,
    bars: store.bars.map((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume]),
  })
  try {
    await redis.set(marketDataKey(options.symbol, "common_1m", options.connectionId), payload, "EX", STORE_TTL_SECONDS)
  } catch {
    // persistence is an optimisation; the in-process store keeps working
  }
}

function backfill(
  options: CommonHistoryOptions,
  store: MinuteStore,
  loader: MinuteBarLoader,
  range: { startMs: number; endMs: number; referencePrice?: number },
  now: number,
): Promise<void> {
  const key = storeKey(options.connectionId, options.symbol)
  const running = backfills.get(key)
  if (running) return running
  store.lastAttemptAt = now
  stats.backfillAttempts++
  const flight = (async () => {
    try {
      const rows = await loader(options.symbol, {
        connectionId: options.connectionId,
        startMs: range.startMs,
        endMs: range.endMs,
        referencePrice: range.referencePrice,
      })
      const venue = completedMinuteBars(Array.isArray(rows) ? rows : [], range.endMs, range.startMs)
      if (venue.length === 0) return
      // stored minutes (live feed, restore) win; the venue fills what is missing
      store.bars = unionByMinute(venue, store.bars)
      store.mutation++
      stats.backfillBars += venue.length
      trimStore(store)
    } catch {
      // retried after BACKFILL_RETRY_MS like an empty result
    } finally {
      backfills.delete(key)
    }
  })()
  backfills.set(key, flight)
  return flight
}

/**
 * The Common history of this cycle: completed one-minute bars over the
 * anchored window, oldest first, causal. Returns the same view object while
 * the evaluated bars are unchanged (within a minute), so per-minute caches can
 * key on `view.key`. Null when no completed minute exists yet.
 */
export async function commonHistoryForCycle(options: CommonHistoryOptions): Promise<CommonHistoryView | null> {
  const candles = Array.isArray(options.candles) ? options.candles : []
  if (candles.length === 0) return null
  const newestMs = rawTimestampMs(candles[candles.length - 1])
  const decisionMs = options.mode === "historical" && Number.isFinite(Number(options.asOfMs))
    ? Number(options.asOfMs)
    : newestMs
  if (!Number.isFinite(decisionMs) || decisionMs <= 10_000_000_000) return null
  const formingStartMs = Math.floor(decisionMs / MINUTE_MS) * MINUTE_MS

  if (options.mode === "historical") {
    const fromMs = formingStartMs - (commonWarmupMinutes() + 1) * MINUTE_MS
    let start = candles.length
    while (start > 0 && rawTimestampMs(candles[start - 1]) >= fromMs) start--
    return buildCommonHistoryView(completedMinuteBars(candles.slice(start), formingStartMs, fromMs))
  }

  const key = storeKey(options.connectionId, options.symbol)
  const store = touch(key)
  const redis = options.redis === undefined ? await defaultRedis() : options.redis
  if (!store.restored) await restore(options, store, redis)

  // Only minutes the live window covers from their first second are complete
  // (the 1s window starts at an arbitrary second); the newest stored minute is
  // re-read so a late tick still corrects it.
  const firstMs = rawTimestampMs(candles[0])
  const firstFullMinuteMs = firstMs % MINUTE_MS === 0 ? firstMs : (Math.floor(firstMs / MINUTE_MS) + 1) * MINUTE_MS
  const lastStored = store.bars[store.bars.length - 1]
  const cutMs = lastStored ? Math.max(firstFullMinuteMs, lastStored.timestamp) : firstFullMinuteMs
  let start = candles.length
  let sorted = true
  let previous = Number.POSITIVE_INFINITY
  while (start > 0) {
    const timestamp = rawTimestampMs(candles[start - 1])
    if (timestamp > previous) {
      sorted = false
      break
    }
    if (timestamp < cutMs) break
    previous = timestamp
    start--
  }
  const fresh = sorted
    ? completedMinuteBars(candles.slice(start), formingStartMs, cutMs)
    : completedMinuteBars(candles, formingStartMs, firstFullMinuteMs)
  if (applyLiveMinutes(store, fresh)) store.mutation++
  trimStore(store)

  const now = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  if (now - store.lastAttemptAt >= BACKFILL_RETRY_MS) {
    const newest = store.bars[store.bars.length - 1]
    const windowStartMs = commonWindowStartMs(newest ? newest.timestamp : formingStartMs - MINUTE_MS)
    const range = missingRange(store, windowStartMs, formingStartMs)
    const loader = range && range.endMs > range.startMs
      ? (options.loadMinuteBars === undefined ? await defaultLoader() : options.loadMinuteBars)
      : null
    if (range && loader) {
      if (range.referencePrice === undefined && fresh.length > 0) range.referencePrice = fresh[0].open
      const flight = backfill(options, store, loader, range, now)
      if (options.awaitBackfill) await flight
    }
  }
  void persist(options, store, redis, now)

  if (store.view === null || store.viewMutation !== store.mutation) {
    store.view = buildCommonHistoryView(store.bars)
    store.viewMutation = store.mutation
    stats.viewBuilds++
  }
  return store.view
}

/** In-process counters (telemetry). */
export function commonHistoryStats() {
  return { stores: stores.size, ...stats }
}

/** Test helper: forget the in-process stores. */
export function resetCommonHistoryForTests(): void {
  defaultRedisClient = null
  stores.clear()
  backfills.clear()
  stats.viewBuilds = 0
  stats.backfillAttempts = 0
  stats.backfillBars = 0
  stats.restores = 0
}
