/**
 * K-N's own series math for the 17 original Common types, moved verbatim from
 * lib/technical-indicators.ts so the shared rule registry, the live engine,
 * the Preset optimizer and the preset runtime all read one implementation.
 * The arithmetic (seeding, partial windows, Wilder smoothing) is unchanged:
 * the original Common results must stay bit-identical
 * (__tests__/unit/common-indicators-legacy-equivalence.test.ts).
 */
import { wilderRsiSeries } from "@/lib/wilder-rsi"
import type { TechnicalCandle, TechnicalDirection } from "./types"

export function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals
  return Math.round((value + Number.EPSILON) * scale) / scale
}

export function direction(value: number, deadZone = 0): TechnicalDirection {
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

/**
 * Aggregate candles into `timeframeMinutes` bars. Wall-clock input is bucketed
 * by UTC time and each bar is stamped with its bucket start (the bar's open
 * time), so time-anchored rules (sessions, quarter hours, UTC days) and the
 * higher-timeframe views see aligned bars; index-ordered input (no wall-clock
 * time) is grouped by position and keeps its first candle's index.
 */
export function resampleTechnicalCandles(
  rawCandles: unknown[],
  timeframeMinutesInput: number,
): TechnicalCandle[] {
  return resampleNormalizedCandles(normalizeTechnicalCandles(rawCandles), timeframeMinutesInput)
}

/** As resampleTechnicalCandles, for candles that are already normalized (oldest first). */
export function resampleNormalizedCandles(
  candles: TechnicalCandle[],
  timeframeMinutesInput: number,
): TechnicalCandle[] {
  const timeframeMinutes = Math.max(1, Math.min(60, Math.round(timeframeMinutesInput)))
  if (candles.length <= 1) return candles

  const durationMs = timeframeMinutes * 60_000
  let hasWallClockTimestamps = true
  for (const candle of candles) {
    if (!(candle.timestamp > 10_000_000_000)) {
      hasWallClockTimestamps = false
      break
    }
  }
  // "1m" means one-minute bars. Live passes one-second candles (the stage
  // history), which used to go through unchanged — RSI(14) on "1m" was then
  // RSI over 14 seconds while the replay computed it over 14 minutes. Only
  // index-ordered input without wall-clock time is taken as already 1 m.
  if (timeframeMinutes === 1 && !hasWallClockTimestamps) return candles

  const output: TechnicalCandle[] = []
  let currentBucket = Number.NaN
  let bar: TechnicalCandle | null = null
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]
    const bucket = hasWallClockTimestamps
      ? Math.floor(candle.timestamp / durationMs)
      : Math.floor(index / timeframeMinutes)
    if (bar === null || bucket !== currentBucket) {
      if (bar) output.push(bar)
      currentBucket = bucket
      bar = {
        timestamp: hasWallClockTimestamps ? bucket * durationMs : candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }
      continue
    }
    if (candle.high > bar.high) bar.high = candle.high
    if (candle.low < bar.low) bar.low = candle.low
    bar.close = candle.close
    bar.volume += candle.volume
  }
  if (bar) output.push(bar)
  return output
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
  // Neutral 50 until the series can seed (lib/wilder-rsi.ts).
  return wilderRsiSeries(candles.map((candle) => candle.close), periodInput).map((value) => Number.isFinite(value) ? value : 50)
}


export function trueRange(candles: TechnicalCandle[], index: number): number {
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

export function adx(
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

export function stochastic(
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

export function parabolicSar(
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

export function accumulationDistribution(candles: TechnicalCandle[]): number[] {
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

export function rollingVwap(candles: TechnicalCandle[], periodInput: number): number[] {
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
