import type { CommonIndicatorType } from "@/lib/common-indicator-config"

export type TechnicalDirection = "long" | "short" | "neutral"

export interface TechnicalCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TechnicalIndicatorResult {
  type: CommonIndicatorType
  direction: TechnicalDirection
  strength: number
  value: number
  signal: number
  details: Record<string, number>
}

export type TechnicalIndicatorParameters =
  Partial<Record<CommonIndicatorType, Record<string, number>>>

/**
 * Per-candle-stream calculation cache used by exhaustive Common evaluation.
 *
 * A Common grid changes thresholds independently of its underlying series
 * parameters (for example one RSI period is paired with many overbought /
 * oversold thresholds). Re-normalising thousands of identical candle arrays
 * and rebuilding the same RSI/SMA/EMA series for every threshold tuple made
 * the engine monopolise the HTTP event loop. The context is deliberately
 * scoped to one immutable resampled array, so it has no cross-tick staleness
 * risk and becomes collectible as soon as that timeframe finishes.
 */
export interface TechnicalIndicatorEvaluationContext {
  candles: TechnicalCandle[]
  closes: number[]
  movingAverages: WeakMap<number[], Map<number, number[]>>
  exponentialAverages: WeakMap<number[], Map<number, number[]>>
  rsiByPeriod: Map<number, number[]>
  atrByPeriod: Map<number, number[]>
  adxByPeriod: Map<number, ReturnType<typeof adx>>
  stochasticByPeriods: Map<string, ReturnType<typeof stochastic>>
  psarBySettings: Map<string, ReturnType<typeof parabolicSar>>
  macdBySettings: Map<string, { macd: number[]; signal: number[] }>
  bollingerByPeriod: Map<number, { middle: number[]; mean: number; deviation: number }>
  cciByPeriod: Map<number, { value: number; mean: number; meanDeviation: number }>
  fibonacciByLookback: Map<number, {
    high: number
    low: number
    level382: number
    level500: number
    level618: number
  }>
  williamsByPeriod: Map<number, { high: number; low: number; value: number }>
  vwapByPeriod: Map<number, number[]>
  typicalPrices?: number[]
  accumulationDistribution?: number[]
  onBalanceVolume?: number[]
  averageVolume?: number
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function direction(value: number, deadZone = 0): TechnicalDirection {
  if (Math.abs(value) <= deadZone) return "neutral"
  return value > 0 ? "long" : "short"
}

export function normalizeTechnicalCandles(rawCandles: unknown[]): TechnicalCandle[] {
  const normalized = (rawCandles || [])
    .map((raw, index) => {
      const candle = (raw || {}) as Record<string, unknown>
      const close = finite(candle.close ?? candle.c ?? candle.price)
      if (!(close > 0)) return null
      const open = finite(candle.open ?? candle.o, close)
      const high = Math.max(open, close, finite(candle.high ?? candle.h, close))
      const low = Math.min(open, close, finite(candle.low ?? candle.l, close))
      const rawTimestamp = candle.timestamp ?? candle.time ?? candle.t ?? candle.openTime
      const timestamp = finite(rawTimestamp, index)
      return {
        timestamp,
        open,
        high,
        low,
        close,
        volume: Math.max(0, finite(candle.volume ?? candle.v)),
        index,
        hasTimestamp: rawTimestamp !== undefined && rawTimestamp !== null,
      }
    })
    .filter((candle): candle is NonNullable<typeof candle> => candle !== null)

  if (normalized.length > 1 && normalized.every((candle) => candle.hasTimestamp)) {
    normalized.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
  }
  return normalized.map(({ timestamp, open, high, low, close, volume }) => ({
    timestamp,
    open,
    high,
    low,
    close,
    volume,
  }))
}

export function resampleTechnicalCandles(
  rawCandles: unknown[],
  timeframeMinutesInput: number,
): TechnicalCandle[] {
  const candles = normalizeTechnicalCandles(rawCandles)
  const timeframeMinutes = Math.max(1, Math.min(60, Math.round(timeframeMinutesInput)))
  if (timeframeMinutes === 1 || candles.length <= 1) return candles

  const durationMs = timeframeMinutes * 60_000
  const hasWallClockTimestamps = candles.every((candle) => candle.timestamp > 10_000_000_000)
  const groups = new Map<number, TechnicalCandle[]>()
  candles.forEach((candle, index) => {
    const bucket = hasWallClockTimestamps
      ? Math.floor(candle.timestamp / durationMs)
      : Math.floor(index / timeframeMinutes)
    const group = groups.get(bucket)
    if (group) group.push(candle)
    else groups.set(bucket, [candle])
  })

  return Array.from(groups.values()).map((group) => ({
    timestamp: group[0].timestamp,
    open: group[0].open,
    high: Math.max(...group.map((candle) => candle.high)),
    low: Math.min(...group.map((candle) => candle.low)),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, candle) => sum + candle.volume, 0),
  }))
}

export function sma(values: number[], periodInput: number): number[] {
  const period = Math.max(1, Math.round(periodInput))
  const result = new Array<number>(values.length).fill(0)
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    result[index] = sum / Math.min(period, index + 1)
  }
  return result
}

export function ema(values: number[], periodInput: number): number[] {
  if (values.length === 0) return []
  const period = Math.max(1, Math.round(periodInput))
  const multiplier = 2 / (period + 1)
  const result = new Array<number>(values.length).fill(0)
  result[0] = values[0]
  for (let index = 1; index < values.length; index++) {
    result[index] = values[index] * multiplier + result[index - 1] * (1 - multiplier)
  }
  return result
}

export function rsi(candles: TechnicalCandle[], periodInput: number): number[] {
  const period = Math.max(2, Math.round(periodInput))
  const result = new Array<number>(candles.length).fill(50)
  if (candles.length <= period) return result
  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= period; index++) {
    const change = candles[index].close - candles[index - 1].close
    if (change > 0) averageGain += change
    else averageLoss -= change
  }
  averageGain /= period
  averageLoss /= period
  const current = () => averageLoss === 0
    ? averageGain > 0 ? 100 : 50
    : 100 - 100 / (1 + averageGain / averageLoss)
  result[period] = current()
  for (let index = period + 1; index < candles.length; index++) {
    const change = candles[index].close - candles[index - 1].close
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period
    result[index] = current()
  }
  return result
}

function trueRange(candles: TechnicalCandle[], index: number): number {
  if (index <= 0) return candles[0] ? candles[0].high - candles[0].low : 0
  return Math.max(
    candles[index].high - candles[index].low,
    Math.abs(candles[index].high - candles[index - 1].close),
    Math.abs(candles[index].low - candles[index - 1].close),
  )
}

export function atr(candles: TechnicalCandle[], periodInput: number): number[] {
  const period = Math.max(2, Math.round(periodInput))
  const result = new Array<number>(candles.length).fill(0)
  let running = 0
  for (let index = 1; index < candles.length; index++) {
    const value = trueRange(candles, index)
    if (index <= period) {
      running += value
      result[index] = running / index
    } else {
      result[index] = (result[index - 1] * (period - 1) + value) / period
    }
  }
  return result
}

function adx(
  candles: TechnicalCandle[],
  periodInput: number,
): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const period = Math.max(3, Math.round(periodInput))
  const values = new Array<number>(candles.length).fill(0)
  const plusDi = new Array<number>(candles.length).fill(0)
  const minusDi = new Array<number>(candles.length).fill(0)
  let smoothedTr = 0
  let smoothedPlus = 0
  let smoothedMinus = 0
  let seed = 0
  let seedCount = 0
  let current = 0
  for (let index = 1; index < candles.length; index++) {
    const upMove = candles[index].high - candles[index - 1].high
    const downMove = candles[index - 1].low - candles[index].low
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0
    const tr = trueRange(candles, index)
    if (index <= period) {
      smoothedTr += tr
      smoothedPlus += plusDm
      smoothedMinus += minusDm
      if (index < period) continue
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + tr
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm
    }
    plusDi[index] = smoothedTr > 0 ? (smoothedPlus / smoothedTr) * 100 : 0
    minusDi[index] = smoothedTr > 0 ? (smoothedMinus / smoothedTr) * 100 : 0
    const total = plusDi[index] + minusDi[index]
    const dx = total > 0 ? Math.abs(plusDi[index] - minusDi[index]) / total * 100 : 0
    if (seedCount < period) {
      seed += dx
      seedCount++
      if (seedCount === period) current = seed / period
    } else {
      current = (current * (period - 1) + dx) / period
    }
    if (seedCount >= period) values[index] = current
  }
  return { adx: values, plusDi, minusDi }
}

function stochastic(
  candles: TechnicalCandle[],
  kPeriodInput: number,
  dPeriodInput: number,
): { k: number[]; d: number[] } {
  const kPeriod = Math.max(3, Math.round(kPeriodInput))
  const values = new Array<number>(candles.length).fill(50)
  for (let index = 0; index < candles.length; index++) {
    const start = Math.max(0, index - kPeriod + 1)
    let high = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    for (let cursor = start; cursor <= index; cursor++) {
      high = Math.max(high, candles[cursor].high)
      low = Math.min(low, candles[cursor].low)
    }
    values[index] = high > low ? (candles[index].close - low) / (high - low) * 100 : 50
  }
  return { k: values, d: sma(values, Math.max(1, Math.round(dPeriodInput))) }
}

function parabolicSar(
  candles: TechnicalCandle[],
  accelerationInput = 0.02,
  maximumInput = 0.2,
): { values: number[]; directions: TechnicalDirection[] } {
  const values = new Array<number>(candles.length).fill(0)
  const directions = new Array<TechnicalDirection>(candles.length).fill("neutral")
  if (candles.length < 2) return { values, directions }
  const acceleration = clamp(accelerationInput, 0.001, 1)
  const maximum = Math.max(acceleration, clamp(maximumInput, acceleration, 1))
  let rising = candles[1].close >= candles[0].close
  let sarValue = rising
    ? Math.min(candles[0].low, candles[1].low)
    : Math.max(candles[0].high, candles[1].high)
  let extreme = rising
    ? Math.max(candles[0].high, candles[1].high)
    : Math.min(candles[0].low, candles[1].low)
  let factor = acceleration
  values[1] = sarValue
  directions[1] = rising ? "long" : "short"
  for (let index = 2; index < candles.length; index++) {
    let next = sarValue + factor * (extreme - sarValue)
    if (rising) {
      next = Math.min(next, candles[index - 1].low, candles[index - 2].low)
      if (candles[index].low < next) {
        rising = false
        next = extreme
        extreme = candles[index].low
        factor = acceleration
      } else if (candles[index].high > extreme) {
        extreme = candles[index].high
        factor = Math.min(maximum, factor + acceleration)
      }
    } else {
      next = Math.max(next, candles[index - 1].high, candles[index - 2].high)
      if (candles[index].high > next) {
        rising = true
        next = extreme
        extreme = candles[index].high
        factor = acceleration
      } else if (candles[index].low < extreme) {
        extreme = candles[index].low
        factor = Math.min(maximum, factor + acceleration)
      }
    }
    sarValue = next
    values[index] = next
    directions[index] = rising ? "long" : "short"
  }
  return { values, directions }
}

function accumulationDistribution(candles: TechnicalCandle[]): number[] {
  const result = new Array<number>(candles.length).fill(0)
  for (let index = 0; index < candles.length; index++) {
    const range = candles[index].high - candles[index].low
    const multiplier = range > 0
      ? ((candles[index].close - candles[index].low) - (candles[index].high - candles[index].close)) / range
      : 0
    result[index] = (result[index - 1] || 0) + multiplier * candles[index].volume
  }
  return result
}

export function onBalanceVolume(candles: TechnicalCandle[]): number[] {
  const result = new Array<number>(candles.length).fill(0)
  for (let index = 1; index < candles.length; index++) {
    const sign = candles[index].close > candles[index - 1].close
      ? 1
      : candles[index].close < candles[index - 1].close
        ? -1
        : 0
    result[index] = result[index - 1] + sign * candles[index].volume
  }
  return result
}

function rollingVwap(candles: TechnicalCandle[], periodInput: number): number[] {
  const period = Math.max(1, Math.round(periodInput))
  const result = new Array<number>(candles.length).fill(0)
  let priceVolume = 0
  let volume = 0
  for (let index = 0; index < candles.length; index++) {
    const typical = (candles[index].high + candles[index].low + candles[index].close) / 3
    priceVolume += typical * candles[index].volume
    volume += candles[index].volume
    if (index >= period) {
      const oldTypical =
        (candles[index - period].high + candles[index - period].low + candles[index - period].close) / 3
      priceVolume -= oldTypical * candles[index - period].volume
      volume -= candles[index - period].volume
    }
    result[index] = volume > 0 ? priceVolume / volume : candles[index].close
  }
  return result
}

export function createTechnicalIndicatorEvaluationContext(
  rawCandles: unknown[],
): TechnicalIndicatorEvaluationContext {
  const candles = normalizeTechnicalCandles(rawCandles)
  return {
    candles,
    closes: candles.map((candle) => candle.close),
    movingAverages: new WeakMap(),
    exponentialAverages: new WeakMap(),
    rsiByPeriod: new Map(),
    atrByPeriod: new Map(),
    adxByPeriod: new Map(),
    stochasticByPeriods: new Map(),
    psarBySettings: new Map(),
    macdBySettings: new Map(),
    bollingerByPeriod: new Map(),
    cciByPeriod: new Map(),
    fibonacciByLookback: new Map(),
    williamsByPeriod: new Map(),
    vwapByPeriod: new Map(),
  }
}

function cachedSeries(
  cache: WeakMap<number[], Map<number, number[]>>,
  values: number[],
  periodInput: number,
  calculate: (series: number[], period: number) => number[],
): number[] {
  const period = Math.max(1, Math.round(periodInput))
  let byPeriod = cache.get(values)
  if (!byPeriod) {
    byPeriod = new Map()
    cache.set(values, byPeriod)
  }
  let series = byPeriod.get(period)
  if (!series) {
    series = calculate(values, period)
    byPeriod.set(period, series)
  }
  return series
}

function cachedSma(
  context: TechnicalIndicatorEvaluationContext,
  values: number[],
  period: number,
): number[] {
  return cachedSeries(context.movingAverages, values, period, sma)
}

function cachedEma(
  context: TechnicalIndicatorEvaluationContext,
  values: number[],
  period: number,
): number[] {
  return cachedSeries(context.exponentialAverages, values, period, ema)
}

function cachedByPeriod<T>(
  cache: Map<number, T>,
  periodInput: number,
  calculate: (period: number) => T,
): T {
  const period = Math.max(1, Math.round(periodInput))
  let value = cache.get(period)
  if (value === undefined) {
    value = calculate(period)
    cache.set(period, value)
  }
  return value
}

function result(
  type: CommonIndicatorType,
  directionValue: TechnicalDirection,
  strength: number,
  value: number,
  signal: number,
  details: Record<string, number> = {},
): TechnicalIndicatorResult {
  return {
    type,
    direction: directionValue,
    strength: round(clamp(strength, 0, 1)),
    value: round(value),
    signal: round(signal),
    details: Object.fromEntries(Object.entries(details).map(([key, item]) => [key, round(item)])),
  }
}

/**
 * Evaluate every canonical Common indicator for one already-resampled candle
 * stream. `periodInput` is only the fallback lookback; each indicator's
 * configured period/threshold range remains independent. Common callers use
 * actual configured candle timeframes, never Default Direction/Move/Active
 * sample ranges or Trend's independent situation coordination.
 * Default Direction/Move/Active sample ranges.
 */
export function evaluateTechnicalIndicators(
  rawCandles: unknown[],
  periodInput: number,
  enabledTypes?: readonly CommonIndicatorType[],
  parametersByType?: TechnicalIndicatorParameters,
  evaluationContext?: TechnicalIndicatorEvaluationContext,
): Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> {
  const context = evaluationContext || createTechnicalIndicatorEvaluationContext(rawCandles)
  const candles = context.candles
  if (candles.length === 0) return {}
  const types = new Set(enabledTypes)
  const include = (type: CommonIndicatorType) => types.size === 0 || types.has(type)
  const period = Math.max(3, Math.round(periodInput))
  const shortPeriod = Math.max(2, Math.round(period / 2))
  const longPeriod = Math.max(shortPeriod + 1, period)
  const lastIndex = candles.length - 1
  const current = candles[lastIndex]
  const closes = context.closes
  const output: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> = {}
  const percentageDistance = (from: number, to: number) => from > 0 ? (to - from) / from * 100 : 0
  const parameter = (
    type: CommonIndicatorType,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ) => clamp(finite(parametersByType?.[type]?.[key], fallback), min, max)

  if (include("ma")) {
    const maShortPeriod = Math.round(parameter("ma", "shortPeriod", shortPeriod, 2, 300))
    const maLongPeriod = Math.max(
      maShortPeriod + 1,
      Math.round(parameter("ma", "longPeriod", longPeriod, 3, 500)),
    )
    if (candles.length >= maLongPeriod) {
      const shortSma = cachedSma(context, closes, maShortPeriod)
      const longSma = cachedSma(context, closes, maLongPeriod)
      const shortEma = cachedEma(context, closes, maShortPeriod)
      const longEma = cachedEma(context, closes, maLongPeriod)
      const smaDelta = percentageDistance(longSma[lastIndex], shortSma[lastIndex])
      const emaDelta = percentageDistance(longEma[lastIndex], shortEma[lastIndex])
      const blended = (smaDelta + emaDelta) / 2
      output.ma = result("ma", direction(blended, 0.000001), Math.abs(blended) / 0.5, current.close, blended, {
        simple: shortSma[lastIndex],
        exponential: shortEma[lastIndex],
        long: (longSma[lastIndex] + longEma[lastIndex]) / 2,
      })
    }
  }
  if (include("sma")) {
    const configuredShort = Math.round(parameter("sma", "shortPeriod", shortPeriod, 2, 300))
    const configuredLong = Math.max(
      configuredShort + 1,
      Math.round(parameter("sma", "longPeriod", longPeriod, 3, 500)),
    )
    if (candles.length < configuredLong) {
      // Official moving averages require a complete long lookback.
    } else {
    const shortValues = cachedSma(context, closes, configuredShort)
    const longValues = cachedSma(context, closes, configuredLong)
    const delta = percentageDistance(longValues[lastIndex], shortValues[lastIndex])
    output.sma = result("sma", direction(delta, 0.000001), Math.abs(delta) / 0.5, shortValues[lastIndex], delta, {
      short: shortValues[lastIndex],
      long: longValues[lastIndex],
    })
    }
  }
  if (include("ema")) {
    const configuredShort = Math.round(parameter("ema", "shortPeriod", shortPeriod, 2, 300))
    const configuredLong = Math.max(
      configuredShort + 1,
      Math.round(parameter("ema", "longPeriod", longPeriod, 3, 500)),
    )
    if (candles.length < configuredLong) {
      // Wait for the complete configured long lookback.
    } else {
    const shortValues = cachedEma(context, closes, configuredShort)
    const longValues = cachedEma(context, closes, configuredLong)
    const delta = percentageDistance(longValues[lastIndex], shortValues[lastIndex])
    output.ema = result("ema", direction(delta, 0.000001), Math.abs(delta) / 0.5, shortValues[lastIndex], delta, {
      short: shortValues[lastIndex],
      long: longValues[lastIndex],
    })
    }
  }

  if (include("macd")) {
    const fastPeriod = Math.round(parameter("macd", "fastPeriod", Math.max(2, period * 0.46), 2, 300))
    const slowPeriod = Math.max(
      fastPeriod + 1,
      Math.round(parameter("macd", "slowPeriod", period, 3, 500)),
    )
    const signalPeriod = Math.round(parameter("macd", "signalPeriod", Math.max(2, period * 0.35), 2, 300))
    if (candles.length < slowPeriod + signalPeriod) {
      // MACD needs the slow window plus a complete signal window.
    } else {
    const cacheKey = `${fastPeriod}:${slowPeriod}:${signalPeriod}`
    let cached = context.macdBySettings.get(cacheKey)
    if (!cached) {
      const fast = cachedEma(context, closes, fastPeriod)
      const slow = cachedEma(context, closes, slowPeriod)
      const macd = closes.map((_, index) => fast[index] - slow[index])
      cached = { macd, signal: cachedEma(context, macd, signalPeriod) }
      context.macdBySettings.set(cacheKey, cached)
    }
    const histogram = cached.macd[lastIndex] - cached.signal[lastIndex]
    const normalized = current.close > 0 ? histogram / current.close * 100 : 0
    output.macd = result("macd", direction(histogram), Math.abs(normalized) / 0.2, cached.macd[lastIndex], histogram, {
      signalLine: cached.signal[lastIndex],
      histogram,
    })
    }
  }

  if (include("rsi")) {
    const configuredPeriod = Math.round(parameter("rsi", "period", period, 2, 300))
    const oversold = parameter("rsi", "oversold", 30, 1, 49)
    const overbought = parameter("rsi", "overbought", 70, 51, 99)
    if (candles.length < configuredPeriod + 1) {
      // Wait for a complete RSI seed.
    } else {
    const values = cachedByPeriod(
      context.rsiByPeriod,
      configuredPeriod,
      (cachedPeriod) => rsi(candles, cachedPeriod),
    )
    const value = values[lastIndex]
    const midpoint = (oversold + overbought) / 2
    const directional = value <= oversold
      ? "long"
      : value >= overbought
        ? "short"
        : direction(value - midpoint, Math.max(1, (overbought - oversold) * 0.1))
    output.rsi = result("rsi", directional, Math.abs(value - 50) / 50, value, value - 50, {
      overbought,
      oversold,
    })
    }
  }

  if (include("bollinger")) {
    const configuredPeriod = Math.round(parameter("bollinger", "period", period, 3, 300))
    const stdDev = parameter("bollinger", "stdDev", 2, 0.1, 10)
    if (candles.length < configuredPeriod) {
      // Wait for a full Bollinger window.
    } else {
    const cached = cachedByPeriod(
      context.bollingerByPeriod,
      configuredPeriod,
      (cachedPeriod) => {
        const middle = cachedSma(context, closes, cachedPeriod)
        const start = Math.max(0, candles.length - cachedPeriod)
        const mean = middle[lastIndex]
        const variance = candles.slice(start).reduce(
          (sum, candle) => sum + (candle.close - mean) ** 2,
          0,
        ) / Math.max(1, candles.length - start)
        return { middle, mean, deviation: Math.sqrt(variance) }
      },
    )
    const mean = cached.mean
    const deviation = cached.deviation
    const upper = mean + deviation * stdDev
    const lower = mean - deviation * stdDev
    const bandPosition = upper > lower ? (current.close - lower) / (upper - lower) : 0.5
    const directional = bandPosition >= 0.55 ? "short" : bandPosition <= 0.45 ? "long" : "neutral"
    output.bollinger = result("bollinger", directional, Math.abs(bandPosition - 0.5) * 2, current.close, 0.5 - bandPosition, {
      upper,
      middle: mean,
      lower,
      bandPosition,
    })
    }
  }

  if (include("stochastic")) {
    const kPeriod = Math.round(parameter("stochastic", "kPeriod", period, 3, 300))
    const dPeriod = Math.round(parameter("stochastic", "dPeriod", 3, 1, 100))
    const oversold = parameter("stochastic", "oversold", 20, 1, 49)
    const overbought = parameter("stochastic", "overbought", 80, 51, 99)
    if (candles.length < kPeriod + dPeriod - 1) {
      // Wait for complete %K and %D windows.
    } else {
    const stochasticKey = `${kPeriod}:${dPeriod}`
    let values = context.stochasticByPeriods.get(stochasticKey)
    if (!values) {
      values = stochastic(candles, kPeriod, dPeriod)
      context.stochasticByPeriods.set(stochasticKey, values)
    }
    const k = values.k[lastIndex]
    const d = values.d[lastIndex]
    const delta = k - d
    const directional = k <= oversold && delta >= 0
      ? "long"
      : k >= overbought && delta <= 0
        ? "short"
        : direction(delta, 0.5)
    output.stochastic = result("stochastic", directional, Math.max(Math.abs(delta) / 25, Math.abs(k - 50) / 50), k, delta, {
      k,
      d,
      overbought,
      oversold,
    })
    }
  }

  if (include("adx")) {
    const configuredPeriod = Math.round(parameter("adx", "period", period, 3, 300))
    const threshold = parameter("adx", "threshold", 20, 1, 100)
    if (candles.length < configuredPeriod * 2) {
      // Wilder ADX needs both the directional and ADX seed windows.
    } else {
    const values = cachedByPeriod(
      context.adxByPeriod,
      configuredPeriod,
      (cachedPeriod) => adx(candles, cachedPeriod),
    )
    const value = values.adx[lastIndex]
    const delta = values.plusDi[lastIndex] - values.minusDi[lastIndex]
    output.adx = result("adx", value >= threshold ? direction(delta) : "neutral", value / 50, value, delta, {
      plusDi: values.plusDi[lastIndex],
      minusDi: values.minusDi[lastIndex],
      threshold,
    })
    }
  }

  if (include("atr")) {
    const configuredPeriod = Math.round(parameter("atr", "period", period, 3, 300))
    const multiplier = parameter("atr", "multiplier", 1, 0.1, 20)
    if (candles.length < configuredPeriod + 1) {
      // Wait for a complete ATR seed.
    } else {
    const values = cachedByPeriod(
      context.atrByPeriod,
      configuredPeriod,
      (cachedPeriod) => atr(candles, cachedPeriod),
    )
    const value = values[lastIndex]
    const baseline = cachedSma(context, closes, longPeriod)[lastIndex]
    const delta = current.close - baseline
    const normalized = value > 0 ? delta / (value * multiplier) : 0
    output.atr = result("atr", direction(normalized, 0.1), Math.abs(normalized) / 2, value, normalized, {
      baseline,
      normalized,
      multiplier,
    })
    }
  }

  if (include("psar")) {
    const acceleration = parameter("psar", "acceleration", 0.02, 0.001, 1)
    const maximum = parameter("psar", "maximum", 0.2, acceleration, 1)
    if (candles.length < 3) {
      // PSAR needs two seed candles and one evaluated candle.
    } else {
    const psarKey = `${acceleration}:${maximum}`
    let values = context.psarBySettings.get(psarKey)
    if (!values) {
      values = parabolicSar(candles, acceleration, maximum)
      context.psarBySettings.set(psarKey, values)
    }
    const sarValue = values.values[lastIndex]
    const delta = current.close - sarValue
    output.psar = result("psar", values.directions[lastIndex], Math.abs(delta) / Math.max(current.close * 0.01, 1e-9), sarValue, delta)
    }
  }

  if (include("cci")) {
    const configuredPeriod = Math.round(parameter("cci", "period", period, 3, 300))
    const threshold = parameter("cci", "threshold", 100, 1, 500)
    if (candles.length < configuredPeriod) {
      // Wait for the complete CCI lookback.
    } else {
    const cached = cachedByPeriod(
      context.cciByPeriod,
      configuredPeriod,
      (cachedPeriod) => {
        const typical = context.typicalPrices || candles.map(
          (candle) => (candle.high + candle.low + candle.close) / 3,
        )
        context.typicalPrices = typical
        const means = cachedSma(context, typical, cachedPeriod)
        const start = Math.max(0, candles.length - cachedPeriod)
        const mean = means[lastIndex]
        const meanDeviation = typical.slice(start).reduce(
          (sum, value) => sum + Math.abs(value - mean),
          0,
        ) / Math.max(1, candles.length - start)
        const value = meanDeviation > 0
          ? (typical[lastIndex] - mean) / (0.015 * meanDeviation)
          : 0
        return { value, mean, meanDeviation }
      },
    )
    output.cci = result("cci", direction(cached.value, threshold), Math.abs(cached.value) / Math.max(200, threshold), cached.value, cached.value, {
      mean: cached.mean,
      meanDeviation: cached.meanDeviation,
      threshold,
    })
    }
  }

  if (include("adl")) {
    const configuredShort = Math.round(parameter("adl", "shortPeriod", shortPeriod, 2, 300))
    const configuredLong = Math.max(
      configuredShort + 1,
      Math.round(parameter("adl", "longPeriod", longPeriod, 3, 500)),
    )
    if (candles.length < configuredLong) {
      // Wait for complete short/long ADL smoothing windows.
    } else {
    const values = context.accumulationDistribution || accumulationDistribution(candles)
    context.accumulationDistribution = values
    const short = cachedSma(context, values, configuredShort)
    const long = cachedSma(context, values, configuredLong)
    const delta = short[lastIndex] - long[lastIndex]
    const scale = Math.max(1, Math.abs(long[lastIndex]))
    output.adl = result("adl", direction(delta), Math.abs(delta) / scale * 10, values[lastIndex], delta, {
      short: short[lastIndex],
      long: long[lastIndex],
    })
    }
  }

  if (include("fibonacci")) {
    const lookback = Math.round(parameter("fibonacci", "lookback", period, 3, 500))
    const tolerancePct = parameter("fibonacci", "tolerancePct", 0.3, 0.01, 10)
    if (candles.length < lookback) {
      // Wait for the configured Fibonacci range.
    } else {
    const cached = cachedByPeriod(
      context.fibonacciByLookback,
      lookback,
      (cachedLookback) => {
        const window = candles.slice(-cachedLookback)
        const high = Math.max(...window.map((candle) => candle.high))
        const low = Math.min(...window.map((candle) => candle.low))
        const span = high - low
        return {
          high,
          low,
          level382: high - span * 0.382,
          level500: high - span * 0.5,
          level618: high - span * 0.618,
        }
      },
    )
    const span = cached.high - cached.low
    const nearest = [cached.level382, cached.level500, cached.level618].sort(
      (left, right) => Math.abs(current.close - left) - Math.abs(current.close - right),
    )[0] ?? current.close
    const delta = current.close - nearest
    const deltaPct = current.close > 0 ? Math.abs(delta) / current.close * 100 : 0
    const fibonacciDirection = deltaPct <= tolerancePct ? direction(delta) : "neutral"
    output.fibonacci = result("fibonacci", fibonacciDirection, span > 0 ? Math.abs(delta) / span * 4 : 0, nearest, delta, {
      high: cached.high,
      low: cached.low,
      tolerancePct,
      level382: cached.level382,
      level500: cached.level500,
      level618: cached.level618,
    })
    }
  }

  if (include("roc")) {
    const configuredPeriod = Math.round(parameter("roc", "period", period, 1, 300))
    const threshold = parameter("roc", "thresholdPct", 0.1, 0, 100)
    if (candles.length < configuredPeriod + 1) {
      // Wait for the full ROC comparison window.
    } else {
    const reference = closes[Math.max(0, lastIndex - configuredPeriod)]
    const value = percentageDistance(reference, current.close)
    output.roc = result("roc", direction(value, threshold), Math.abs(value) / 2, value, value, { reference, threshold })
    }
  }

  if (include("williamsR")) {
    const configuredPeriod = Math.round(parameter("williamsR", "period", period, 3, 300))
    const oversold = parameter("williamsR", "oversold", -80, -100, -50)
    const overbought = parameter("williamsR", "overbought", -20, -50, 0)
    if (candles.length < configuredPeriod) {
      // Wait for the complete Williams %R range.
    } else {
    const cached = cachedByPeriod(
      context.williamsByPeriod,
      configuredPeriod,
      (cachedPeriod) => {
        const window = candles.slice(-cachedPeriod)
        const high = Math.max(...window.map((candle) => candle.high))
        const low = Math.min(...window.map((candle) => candle.low))
        return {
          high,
          low,
          value: high > low ? -100 * (high - current.close) / (high - low) : -50,
        }
      },
    )
    const directional = cached.value <= oversold ? "long" : cached.value >= overbought ? "short" : "neutral"
    output.williamsR = result("williamsR", directional, Math.abs(cached.value + 50) / 50, cached.value, cached.value + 50, {
      high: cached.high,
      low: cached.low,
      oversold,
      overbought,
    })
    }
  }

  if (include("obv")) {
    const configuredShort = Math.round(parameter("obv", "shortPeriod", shortPeriod, 2, 300))
    const configuredLong = Math.max(
      configuredShort + 1,
      Math.round(parameter("obv", "longPeriod", longPeriod, 3, 500)),
    )
    if (candles.length < configuredLong) {
      // Wait for complete OBV smoothing windows.
    } else {
    const values = context.onBalanceVolume || onBalanceVolume(candles)
    context.onBalanceVolume = values
    const short = cachedSma(context, values, configuredShort)
    const long = cachedSma(context, values, configuredLong)
    const delta = short[lastIndex] - long[lastIndex]
    const averageVolume = context.averageVolume ?? (
      candles.slice(-period).reduce((sum, candle) => sum + candle.volume, 0) /
      Math.min(period, candles.length)
    )
    context.averageVolume = averageVolume
    output.obv = result("obv", direction(delta), Math.abs(delta) / Math.max(averageVolume * period, 1), values[lastIndex], delta, {
      short: short[lastIndex],
      long: long[lastIndex],
      averageVolume,
    })
    }
  }

  if (include("vwap")) {
    const configuredPeriod = Math.round(parameter("vwap", "period", period, 2, 300))
    const deviationThreshold = parameter("vwap", "deviationPct", 0.1, 0, 100)
    if (candles.length < configuredPeriod) {
      // Wait for the complete rolling VWAP window.
    } else {
    const values = cachedByPeriod(
      context.vwapByPeriod,
      configuredPeriod,
      (cachedPeriod) => rollingVwap(candles, cachedPeriod),
    )
    const value = values[lastIndex]
    const deltaPct = percentageDistance(value, current.close)
    output.vwap = result("vwap", direction(deltaPct, deviationThreshold), Math.abs(deltaPct), value, deltaPct, {
      price: current.close,
      deviationPct: deltaPct,
      deviationThreshold,
    })
    }
  }

  return output
}

export function summarizeTechnicalIndicators(
  indicators: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>>,
): {
  direction: TechnicalDirection
  agreement: number
  strength: number
  longVotes: number
  shortVotes: number
  neutralVotes: number
  signals: number
} {
  const values = Object.values(indicators)
  const long = values.filter((item) => item.direction === "long")
  const short = values.filter((item) => item.direction === "short")
  const neutral = values.length - long.length - short.length
  const directional = long.length + short.length
  const dominant = Math.max(long.length, short.length)
  const finalDirection: TechnicalDirection = long.length === short.length
    ? "neutral"
    : long.length > short.length
      ? "long"
      : "short"
  const selected = finalDirection === "long" ? long : finalDirection === "short" ? short : []
  return {
    direction: finalDirection,
    agreement: directional > 0 ? round(dominant / directional) : 0,
    strength: selected.length > 0
      ? round(selected.reduce((sum, item) => sum + item.strength, 0) / selected.length)
      : 0,
    longVotes: long.length,
    shortVotes: short.length,
    neutralVotes: neutral,
    signals: directional,
  }
}
