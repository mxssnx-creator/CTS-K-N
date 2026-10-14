import { SeriesCache, type Bars } from "./ao/series-cache"
import { normalizeTechnicalCandles } from "./kn-math"
import type { TechnicalCandle } from "./types"

/**
 * Per-candle-array calculation context shared by every Common rule.
 *
 * A Common grid varies thresholds independently of its underlying series (one
 * RSI period is paired with many oversold / overbought levels), so every
 * series is computed once per context and keyed only by the parameters that
 * shape it. The context is scoped to one immutable (resampled) candle array:
 * it has no cross-tick staleness and is collectible once its timeframe is done.
 */
export class CommonSeriesContext {
  readonly candles: TechnicalCandle[]
  readonly closes: number[]
  /** bar length in minutes (wall-clock series), 1 for index-ordered input */
  readonly tfMin: number
  private readonly cache = new Map<string, unknown>()
  private aoCache: SeriesCache | null = null

  constructor(candles: TechnicalCandle[], tfMin?: number) {
    this.candles = candles
    this.closes = candles.map((candle) => candle.close)
    this.tfMin = tfMin ?? inferTimeframeMinutes(candles)
  }

  get length(): number {
    return this.candles.length
  }

  memo<T>(key: string, fn: () => T): T {
    if (this.cache.has(key)) return this.cache.get(key) as T
    const value = fn()
    this.cache.set(key, value)
    return value
  }

  /** The CTS-A-O column view (Float64Array OHLCV) of the same bars, built once. */
  ao(): SeriesCache {
    if (this.aoCache) return this.aoCache
    const n = this.candles.length
    const bars: Bars = {
      tfMin: this.tfMin,
      n,
      t: new Float64Array(n),
      o: new Float64Array(n),
      h: new Float64Array(n),
      l: new Float64Array(n),
      c: new Float64Array(n),
      v: new Float64Array(n),
    }
    for (let index = 0; index < n; index++) {
      const candle = this.candles[index]
      bars.t[index] = candle.timestamp
      bars.o[index] = candle.open
      bars.h[index] = candle.high
      bars.l[index] = candle.low
      bars.c[index] = candle.close
      bars.v[index] = candle.volume
    }
    this.aoCache = new SeriesCache(bars)
    return this.aoCache
  }
}

/**
 * The bar length of a wall-clock series: the most common positive gap between
 * consecutive timestamps, in whole minutes (at least 1). Index-ordered input
 * (no wall-clock time) is treated as one-minute bars.
 */
export function inferTimeframeMinutes(candles: readonly TechnicalCandle[]): number {
  if (candles.length < 2 || !(candles[0].timestamp > 10_000_000_000)) return 1
  const counts = new Map<number, number>()
  const limit = Math.min(candles.length, 512)
  for (let index = candles.length - limit + 1; index < candles.length; index++) {
    const gap = candles[index].timestamp - candles[index - 1].timestamp
    if (!(gap > 0)) continue
    const minutes = Math.max(1, Math.round(gap / 60_000))
    counts.set(minutes, (counts.get(minutes) || 0) + 1)
  }
  let best = 1
  let bestCount = -1
  for (const [minutes, count] of counts) {
    if (count > bestCount || (count === bestCount && minutes < best)) {
      best = minutes
      bestCount = count
    }
  }
  return best
}

/** A context over raw candles (normalized here) or already-normalized candles. */
export function createCommonSeriesContext(
  rawCandles: unknown[],
  options: { normalized?: boolean; tfMin?: number } = {},
): CommonSeriesContext {
  const candles = options.normalized
    ? (rawCandles as TechnicalCandle[])
    : normalizeTechnicalCandles(rawCandles)
  return new CommonSeriesContext(candles, options.tfMin)
}
