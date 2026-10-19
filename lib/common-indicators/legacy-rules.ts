/**
 * The 17 original Common types, expressed per bar on the shared context.
 *
 * Each rule's `at(ctx, params, index)` reproduces the former last-bar block of
 * `evaluateTechnicalIndicators` exactly (same parameter fallbacks and clamps,
 * same warm-up guards, same arithmetic order) but at any bar index, so the live
 * engine (last bar), the Preset optimizer (every bar) and the preset runtime
 * read one definition. Behaviour is pinned by
 * __tests__/unit/common-indicators-legacy-equivalence.test.ts against the frozen
 * pre-refactor implementation.
 */
import type { CommonSeriesContext } from "./context"
import {
  accumulationDistribution,
  adx,
  atr,
  clamp,
  direction,
  ema,
  finite,
  onBalanceVolume,
  parabolicSar,
  rollingVwap,
  rsi,
  sma,
  stochastic,
} from "./kn-math"
import type { CommonRuleSample, TechnicalDirection } from "./types"

export type RuleParams = Record<string, number>

export interface CommonRule {
  type: string
  /** "state" rules hold a reading every bar; "event" rules fire on bars and are held for `keep` bars */
  kind: "state" | "event"
  /** configured parameters (possibly partial) + the fallback lookback → the values the rule evaluates */
  resolve(raw: Record<string, number> | undefined, periodInput: number): RuleParams
  /** bars needed before the rule may produce a result at the last index */
  warmup(params: RuleParams): number
  /** the rule at bar `index` (index + 1 ≥ warmup) */
  at(ctx: CommonSeriesContext, params: RuleParams, index: number): CommonRuleSample | null
  /** optional fast path: the direction at every bar (+1 / −1 / 0), causal */
  states?(ctx: CommonSeriesContext, params: RuleParams): Int8Array
}

interface FallbackPeriods {
  period: number
  shortPeriod: number
  longPeriod: number
}

export function fallbackPeriods(periodInput: number): FallbackPeriods {
  const period = Math.max(3, Math.round(periodInput))
  const shortPeriod = Math.max(2, Math.round(period / 2))
  const longPeriod = Math.max(shortPeriod + 1, period)
  return { period, shortPeriod, longPeriod }
}

const read = (
  raw: Record<string, number> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
) => clamp(finite(raw?.[key], fallback), min, max)

const percentageDistance = (from: number, to: number) => from > 0 ? (to - from) / from * 100 : 0

const closeSma = (ctx: CommonSeriesContext, period: number) =>
  ctx.memo(`kn:sma:close:${period}`, () => sma(ctx.closes, period))
const closeEma = (ctx: CommonSeriesContext, period: number) =>
  ctx.memo(`kn:ema:close:${period}`, () => ema(ctx.closes, period))

function sample(
  directionValue: TechnicalDirection,
  strength: number,
  value: number,
  signal: number,
  details: Record<string, number> = {},
): CommonRuleSample {
  return { direction: directionValue, strength, value, signal, details }
}

function periodPair(prefix: "short" | "long") {
  return `${prefix}Period`
}

function crossPeriods(raw: Record<string, number> | undefined, periodInput: number) {
  const fallback = fallbackPeriods(periodInput)
  const shortPeriod = Math.round(read(raw, periodPair("short"), fallback.shortPeriod, 2, 300))
  const longPeriod = Math.max(shortPeriod + 1, Math.round(read(raw, periodPair("long"), fallback.longPeriod, 3, 500)))
  return { shortPeriod, longPeriod }
}

const ma: CommonRule = {
  type: "ma",
  kind: "state",
  resolve: crossPeriods,
  warmup: (p) => p.longPeriod,
  at(ctx, p, i) {
    const shortSma = closeSma(ctx, p.shortPeriod)
    const longSma = closeSma(ctx, p.longPeriod)
    const shortEma = closeEma(ctx, p.shortPeriod)
    const longEma = closeEma(ctx, p.longPeriod)
    const smaDelta = percentageDistance(longSma[i], shortSma[i])
    const emaDelta = percentageDistance(longEma[i], shortEma[i])
    const blended = (smaDelta + emaDelta) / 2
    return sample(direction(blended, 0.000001), Math.abs(blended) / 0.5, ctx.candles[i].close, blended, {
      simple: shortSma[i],
      exponential: shortEma[i],
      long: (longSma[i] + longEma[i]) / 2,
    })
  },
}

function averageCross(type: "sma" | "ema"): CommonRule {
  return {
    type,
    kind: "state",
    resolve: crossPeriods,
    warmup: (p) => p.longPeriod,
    at(ctx, p, i) {
      const series = type === "sma" ? closeSma : closeEma
      const shortValues = series(ctx, p.shortPeriod)
      const longValues = series(ctx, p.longPeriod)
      const delta = percentageDistance(longValues[i], shortValues[i])
      return sample(direction(delta, 0.000001), Math.abs(delta) / 0.5, shortValues[i], delta, {
        short: shortValues[i],
        long: longValues[i],
      })
    },
  }
}

const macd: CommonRule = {
  type: "macd",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    const fastPeriod = Math.round(read(raw, "fastPeriod", Math.max(2, period * 0.46), 2, 300))
    const slowPeriod = Math.max(fastPeriod + 1, Math.round(read(raw, "slowPeriod", period, 3, 500)))
    const signalPeriod = Math.round(read(raw, "signalPeriod", Math.max(2, period * 0.35), 2, 300))
    return { fastPeriod, slowPeriod, signalPeriod }
  },
  warmup: (p) => p.slowPeriod + p.signalPeriod,
  at(ctx, p, i) {
    const cached = ctx.memo(`kn:macd:${p.fastPeriod}:${p.slowPeriod}:${p.signalPeriod}`, () => {
      const fast = closeEma(ctx, p.fastPeriod)
      const slow = closeEma(ctx, p.slowPeriod)
      const line = ctx.closes.map((_, index) => fast[index] - slow[index])
      return { line, signal: ema(line, p.signalPeriod) }
    })
    const histogram = cached.line[i] - cached.signal[i]
    const close = ctx.candles[i].close
    const normalized = close > 0 ? histogram / close * 100 : 0
    return sample(direction(histogram), Math.abs(normalized) / 0.2, cached.line[i], histogram, {
      signalLine: cached.signal[i],
      histogram,
    })
  },
}

const rsiRule: CommonRule = {
  type: "rsi",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 2, 300)),
      oversold: read(raw, "oversold", 30, 1, 49),
      overbought: read(raw, "overbought", 70, 51, 99),
    }
  },
  warmup: (p) => p.period + 1,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:rsi:${p.period}`, () => rsi(ctx.candles, p.period))
    const value = values[i]
    // Reversion: long only at or below oversold, short only at or above
    // overbought, neutral between. The former middle-zone vote (value versus
    // the midpoint) was momentum and flipped direction at the thresholds
    // (audit F1, operator decision 2026-10-19).
    const directional: TechnicalDirection = value <= p.oversold
      ? "long"
      : value >= p.overbought
        ? "short"
        : "neutral"
    return sample(directional, Math.abs(value - 50) / 50, value, value - 50, {
      overbought: p.overbought,
      oversold: p.oversold,
    })
  },
}

/** Population standard deviation of the closes in the window ending at `index` around a given mean. */
function windowDeviation(ctx: CommonSeriesContext, period: number, index: number, mean: number): number {
  const start = Math.max(0, index + 1 - period)
  let sum = 0
  for (let cursor = start; cursor <= index; cursor++) sum += (ctx.candles[cursor].close - mean) ** 2
  return Math.sqrt(sum / Math.max(1, index + 1 - start))
}

const bollinger: CommonRule = {
  type: "bollinger",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 3, 300)),
      stdDev: read(raw, "stdDev", 2, 0.1, 10),
    }
  },
  warmup: (p) => p.period,
  at(ctx, p, i) {
    const middle = closeSma(ctx, p.period)
    const mean = middle[i]
    // The deviation is shared by every stdDev multiplier of the same period and bar.
    const deviation = ctx.memo(`kn:bbdev:${p.period}:${i}`, () => windowDeviation(ctx, p.period, i, mean))
    const upper = mean + deviation * p.stdDev
    const lower = mean - deviation * p.stdDev
    const close = ctx.candles[i].close
    const bandPosition = upper > lower ? (close - lower) / (upper - lower) : 0.5
    const directional = bandPosition >= 0.55 ? "short" : bandPosition <= 0.45 ? "long" : "neutral"
    return sample(directional, Math.abs(bandPosition - 0.5) * 2, close, 0.5 - bandPosition, {
      upper,
      middle: mean,
      lower,
      bandPosition,
    })
  },
  states(ctx, p) {
    const out = new Int8Array(ctx.length)
    const middle = closeSma(ctx, p.period)
    for (let i = Math.max(0, p.period - 1); i < ctx.length; i++) {
      const mean = middle[i]
      const deviation = windowDeviation(ctx, p.period, i, mean)
      const upper = mean + deviation * p.stdDev
      const lower = mean - deviation * p.stdDev
      const bandPosition = upper > lower ? (ctx.candles[i].close - lower) / (upper - lower) : 0.5
      out[i] = bandPosition >= 0.55 ? -1 : bandPosition <= 0.45 ? 1 : 0
    }
    return out
  },
}

const stochasticRule: CommonRule = {
  type: "stochastic",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      kPeriod: Math.round(read(raw, "kPeriod", period, 3, 300)),
      dPeriod: Math.round(read(raw, "dPeriod", 3, 1, 100)),
      oversold: read(raw, "oversold", 20, 1, 49),
      overbought: read(raw, "overbought", 80, 51, 99),
    }
  },
  warmup: (p) => p.kPeriod + p.dPeriod - 1,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:stoch:${p.kPeriod}:${p.dPeriod}`, () => stochastic(ctx.candles, p.kPeriod, p.dPeriod))
    const k = values.k[i]
    const d = values.d[i]
    const delta = k - d
    const directional = k <= p.oversold && delta >= 0
      ? "long"
      : k >= p.overbought && delta <= 0
        ? "short"
        : direction(delta, 0.5)
    return sample(directional, Math.max(Math.abs(delta) / 25, Math.abs(k - 50) / 50), k, delta, {
      k,
      d,
      overbought: p.overbought,
      oversold: p.oversold,
    })
  },
}

const adxRule: CommonRule = {
  type: "adx",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 3, 300)),
      threshold: read(raw, "threshold", 20, 1, 100),
    }
  },
  warmup: (p) => p.period * 2,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:adx:${p.period}`, () => adx(ctx.candles, p.period))
    const value = values.adx[i]
    const delta = values.plusDi[i] - values.minusDi[i]
    return sample(value >= p.threshold ? direction(delta) : "neutral", value / 50, value, delta, {
      plusDi: values.plusDi[i],
      minusDi: values.minusDi[i],
      threshold: p.threshold,
    })
  },
}

const atrRule: CommonRule = {
  type: "atr",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 3, 300)),
      multiplier: read(raw, "multiplier", 1, 0.1, 20),
    }
  },
  warmup: (p) => p.period + 1,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:atr:${p.period}`, () => atr(ctx.candles, p.period))
    const value = values[i]
    // The breakout baseline is the SMA of the configured ATR period (it used to
    // be fixed to the 14-bar fallback whatever period was configured, while the
    // Preset optimizer used the configured period).
    const baseline = closeSma(ctx, p.period)[i]
    const delta = ctx.candles[i].close - baseline
    const normalized = value > 0 ? delta / (value * p.multiplier) : 0
    return sample(direction(normalized, 0.1), Math.abs(normalized) / 2, value, normalized, {
      baseline,
      normalized,
      multiplier: p.multiplier,
    })
  },
}

const psar: CommonRule = {
  type: "psar",
  kind: "state",
  resolve(raw) {
    const acceleration = read(raw, "acceleration", 0.02, 0.001, 1)
    return { acceleration, maximum: read(raw, "maximum", 0.2, acceleration, 1) }
  },
  warmup: () => 3,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:psar:${p.acceleration}:${p.maximum}`, () =>
      parabolicSar(ctx.candles, p.acceleration, p.maximum))
    const sarValue = values.values[i]
    const close = ctx.candles[i].close
    const delta = close - sarValue
    return sample(values.directions[i], Math.abs(delta) / Math.max(close * 0.01, 1e-9), sarValue, delta)
  },
}

const typicalPrices = (ctx: CommonSeriesContext) =>
  ctx.memo("kn:typical", () => ctx.candles.map((candle) => (candle.high + candle.low + candle.close) / 3))

const cci: CommonRule = {
  type: "cci",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 3, 300)),
      threshold: read(raw, "threshold", 100, 1, 500),
    }
  },
  warmup: (p) => p.period,
  at(ctx, p, i) {
    const reading = ctx.memo(`kn:cci:${p.period}:${i}`, () => {
      const typical = typicalPrices(ctx)
      const means = ctx.memo(`kn:sma:typical:${p.period}`, () => sma(typical, p.period))
      const start = Math.max(0, i + 1 - p.period)
      const mean = means[i]
      let deviation = 0
      for (let cursor = start; cursor <= i; cursor++) deviation += Math.abs(typical[cursor] - mean)
      const meanDeviation = deviation / Math.max(1, i + 1 - start)
      const value = meanDeviation > 0 ? (typical[i] - mean) / (0.015 * meanDeviation) : 0
      return { value, mean, meanDeviation }
    })
    return sample(direction(reading.value, p.threshold), Math.abs(reading.value) / Math.max(200, p.threshold), reading.value, reading.value, {
      mean: reading.mean,
      meanDeviation: reading.meanDeviation,
      threshold: p.threshold,
    })
  },
}

function volumeLineCross(type: "adl" | "obv"): CommonRule {
  return {
    type,
    kind: "state",
    resolve(raw, periodInput) {
      const periods = crossPeriods(raw, periodInput)
      return { ...periods, fallbackPeriod: fallbackPeriods(periodInput).period }
    },
    warmup: (p) => p.longPeriod,
    at(ctx, p, i) {
      const values = type === "adl"
        ? ctx.memo("kn:adl", () => accumulationDistribution(ctx.candles))
        : ctx.memo("kn:obv", () => onBalanceVolume(ctx.candles))
      const short = ctx.memo(`kn:sma:${type}:${p.shortPeriod}`, () => sma(values, p.shortPeriod))
      const long = ctx.memo(`kn:sma:${type}:${p.longPeriod}`, () => sma(values, p.longPeriod))
      const delta = short[i] - long[i]
      if (type === "adl") {
        const scale = Math.max(1, Math.abs(long[i]))
        return sample(direction(delta), Math.abs(delta) / scale * 10, values[i], delta, {
          short: short[i],
          long: long[i],
        })
      }
      const period = p.fallbackPeriod
      const averageVolume = ctx.memo(`kn:avgvol:${period}:${i}`, () => {
        const start = Math.max(0, i + 1 - period)
        let sum = 0
        for (let cursor = start; cursor <= i; cursor++) sum += ctx.candles[cursor].volume
        return sum / Math.min(period, i + 1)
      })
      return sample(direction(delta), Math.abs(delta) / Math.max(averageVolume * period, 1), values[i], delta, {
        short: short[i],
        long: long[i],
        averageVolume,
      })
    },
  }
}

function windowRange(ctx: CommonSeriesContext, length: number, index: number) {
  return ctx.memo(`kn:range:${length}:${index}`, () => {
    let high = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    for (let cursor = Math.max(0, index + 1 - length); cursor <= index; cursor++) {
      const candle = ctx.candles[cursor]
      if (candle.high > high) high = candle.high
      if (candle.low < low) low = candle.low
    }
    return { high, low }
  })
}

const fibonacci: CommonRule = {
  type: "fibonacci",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      lookback: Math.round(read(raw, "lookback", period, 3, 500)),
      tolerancePct: read(raw, "tolerancePct", 0.3, 0.01, 10),
    }
  },
  warmup: (p) => p.lookback,
  at(ctx, p, i) {
    const { high, low } = windowRange(ctx, p.lookback, i)
    const span = high - low
    const level382 = high - span * 0.382
    const level500 = high - span * 0.5
    const level618 = high - span * 0.618
    const close = ctx.candles[i].close
    const nearest = [level382, level500, level618].sort(
      (left, right) => Math.abs(close - left) - Math.abs(close - right),
    )[0] ?? close
    const delta = close - nearest
    const deltaPct = close > 0 ? Math.abs(delta) / close * 100 : 0
    const fibonacciDirection = deltaPct <= p.tolerancePct ? direction(delta) : "neutral"
    return sample(fibonacciDirection, span > 0 ? Math.abs(delta) / span * 4 : 0, nearest, delta, {
      high,
      low,
      tolerancePct: p.tolerancePct,
      level382,
      level500,
      level618,
    })
  },
}

const roc: CommonRule = {
  type: "roc",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 1, 300)),
      thresholdPct: read(raw, "thresholdPct", 0.1, 0, 100),
    }
  },
  warmup: (p) => p.period + 1,
  at(ctx, p, i) {
    const reference = ctx.closes[Math.max(0, i - p.period)]
    const value = percentageDistance(reference, ctx.candles[i].close)
    return sample(direction(value, p.thresholdPct), Math.abs(value) / 2, value, value, {
      reference,
      threshold: p.thresholdPct,
    })
  },
}

const williamsR: CommonRule = {
  type: "williamsR",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 3, 300)),
      oversold: read(raw, "oversold", -80, -100, -50),
      overbought: read(raw, "overbought", -20, -50, 0),
    }
  },
  warmup: (p) => p.period,
  at(ctx, p, i) {
    const { high, low } = windowRange(ctx, p.period, i)
    const value = high > low ? -100 * (high - ctx.candles[i].close) / (high - low) : -50
    const directional = value <= p.oversold ? "long" : value >= p.overbought ? "short" : "neutral"
    return sample(directional, Math.abs(value + 50) / 50, value, value + 50, {
      high,
      low,
      oversold: p.oversold,
      overbought: p.overbought,
    })
  },
}

const vwap: CommonRule = {
  type: "vwap",
  kind: "state",
  resolve(raw, periodInput) {
    const { period } = fallbackPeriods(periodInput)
    return {
      period: Math.round(read(raw, "period", period, 2, 300)),
      deviationPct: read(raw, "deviationPct", 0.1, 0, 100),
    }
  },
  warmup: (p) => p.period,
  at(ctx, p, i) {
    const values = ctx.memo(`kn:vwap:${p.period}`, () => rollingVwap(ctx.candles, p.period))
    const value = values[i]
    const close = ctx.candles[i].close
    const deltaPct = percentageDistance(value, close)
    return sample(direction(deltaPct, p.deviationPct), Math.abs(deltaPct), value, deltaPct, {
      price: close,
      deviationPct: deltaPct,
      deviationThreshold: p.deviationPct,
    })
  },
}

export const LEGACY_COMMON_RULES: readonly CommonRule[] = [
  ma,
  averageCross("sma"),
  averageCross("ema"),
  macd,
  rsiRule,
  bollinger,
  stochasticRule,
  adxRule,
  atrRule,
  psar,
  cci,
  volumeLineCross("adl"),
  fibonacci,
  roc,
  williamsR,
  volumeLineCross("obv"),
  vwap,
]
