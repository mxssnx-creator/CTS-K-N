export const PRESET_INDICATOR_TYPES = [
  "rsi",
  "macd",
  "bollinger",
  "ema",
  "sma",
  "stochastic",
  "adx",
  "atr",
  "sar",
] as const

export type PresetIndicatorType = (typeof PRESET_INDICATOR_TYPES)[number]

export interface NumericPresetRange {
  min: number
  max: number
  step: number
}

export interface PresetOptimizerSettings {
  historyDays: number
  presetsPerSymbol: number
  minProfitFactor: number
  maxDrawdownHours: number
  takeProfit: NumericPresetRange
  stopLossRatio: NumericPresetRange
  trailingEnabled: boolean
  trailingIndependent: boolean
  trailingStart: NumericPresetRange
  trailingStop: NumericPresetRange
  trailingStepRatio: number
  autoGenerate: boolean
  autoSelect: boolean
  indicatorTypes: PresetIndicatorType[]
  maxIndicatorVariantsPerType: number
  maxSignalsPerVariant: number
  maxCandlesPerRun: number
  blockEnabled: boolean
  blockVolumeRatio: number
  blockProfitFactorRatio: number
  blockMaxStack: number
  blockPauseCountRatio: number
  blockActiveRealEnabled: boolean
  blockActiveLiveEnabled: boolean
}

export const DEFAULT_PRESET_OPTIMIZER_SETTINGS: PresetOptimizerSettings = {
  historyDays: 14,
  presetsPerSymbol: 4,
  minProfitFactor: 0.7,
  maxDrawdownHours: 5,
  takeProfit: { min: 3, max: 30, step: 1 },
  stopLossRatio: { min: 0.25, max: 2, step: 0.25 },
  trailingEnabled: true,
  trailingIndependent: true,
  trailingStart: { min: 0.5, max: 1.5, step: 0.1 },
  trailingStop: { min: 0.2, max: 0.4, step: 0.1 },
  trailingStepRatio: 0.5,
  autoGenerate: true,
  autoSelect: true,
  indicatorTypes: [...PRESET_INDICATOR_TYPES],
  maxIndicatorVariantsPerType: 4,
  maxSignalsPerVariant: 48,
  maxCandlesPerRun: 6_000,
  blockEnabled: true,
  blockVolumeRatio: 1,
  blockProfitFactorRatio: 0.8,
  blockMaxStack: 10,
  blockPauseCountRatio: 1,
  blockActiveRealEnabled: true,
  blockActiveLiveEnabled: true,
}

export interface PresetCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface PresetIndicatorConfiguration {
  type: PresetIndicatorType
  params: Record<string, number>
}

export interface PresetTrailingConfiguration {
  enabled: boolean
  independent: boolean
  startRatio: number
  stopRatio: number
  stepRatio: number
}

export interface PresetDailyStats {
  day: number
  date: string
  profitFactor: number
  netR: number
  averageR: number
  winRate: number
  positions: number
}

export interface PresetMetrics {
  profitFactor: number
  averageProfitFactor: number
  netR: number
  averageR: number
  grossPositiveR: number
  grossNegativeR: number
  winRate: number
  totalPositions: number
  winningPositions: number
  losingPositions: number
  maxDrawdownR: number
  drawdownTimeHours: number
  averageHoldMinutes: number
  score: number
  eligible: boolean
  daily: PresetDailyStats[]
}

export interface OptimizedPreset {
  id: string
  connectionId: string
  symbol: string
  indicator: PresetIndicatorConfiguration
  positionCostPct: number
  takeProfitRatio: number
  takeProfitPct: number
  takeProfitEnabled: boolean
  stopLossToTakeProfitRatio: number
  stopLossPct: number
  trailing: PresetTrailingConfiguration
  metrics: PresetMetrics
  selected: boolean
  rank: number
  generatedAt: string
  historyFrom: string
  historyTo: string
  dataPoints: number
}

export interface PresetOptimizationResult {
  presets: OptimizedPreset[]
  evaluatedConfigurations: number
  indicatorVariants: number
  signals: number
  sourceCandles: number
  sampledCandles: number
  historyFrom: string | null
  historyTo: string | null
}

export interface PresetSignalEntry {
  index: number
  direction: "long" | "short"
}

interface ExitHit {
  index: number
  price: number
  reason: "take_profit" | "stop_loss" | "trailing" | "timeout"
}

interface PreparedPath {
  entry: PresetSignalEntry
  entryPrice: number
  entryTime: number
  timeout: ExitHit
  takeProfitHits: Map<number, ExitHit>
  stopLossHits: Map<number, ExitHit>
  trailingHits: Map<string, ExitHit>
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["0", "false", "off", "no"].includes(normalized)) return false
    if (["1", "true", "on", "yes"].includes(normalized)) return true
  }
  return Boolean(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function snap(value: unknown, min: number, max: number, step: number, fallback: number): number {
  const bounded = clamp(finite(value, fallback), min, max)
  return round(min + Math.round((bounded - min) / step) * step, 6)
}

function normalizeRange(
  raw: Partial<NumericPresetRange> | undefined,
  defaults: NumericPresetRange,
  bounds: NumericPresetRange,
): NumericPresetRange {
  const step = snap(raw?.step, bounds.step, bounds.max - bounds.min || bounds.step, bounds.step, defaults.step)
  let min = snap(raw?.min, bounds.min, bounds.max, step, defaults.min)
  let max = snap(raw?.max, bounds.min, bounds.max, step, defaults.max)
  if (min > max) [min, max] = [max, min]
  return { min, max, step }
}

export function normalizePresetOptimizerSettings(raw: Record<string, unknown> = {}): PresetOptimizerSettings {
  const d = DEFAULT_PRESET_OPTIMIZER_SETTINGS
  const indicatorTypes = Array.isArray(raw.indicatorTypes)
    ? raw.indicatorTypes
        .map(String)
        .filter((type): type is PresetIndicatorType => PRESET_INDICATOR_TYPES.includes(type as PresetIndicatorType))
    : d.indicatorTypes

  return {
    historyDays: snap(raw.historyDays, 1, 14, 1, d.historyDays),
    presetsPerSymbol: snap(raw.presetsPerSymbol, 1, 12, 1, d.presetsPerSymbol),
    minProfitFactor: snap(raw.minProfitFactor, 0.4, 3, 0.1, d.minProfitFactor),
    maxDrawdownHours: snap(raw.maxDrawdownHours, 1, 24, 0.5, d.maxDrawdownHours),
    takeProfit: normalizeRange(raw.takeProfit as Partial<NumericPresetRange>, d.takeProfit, { min: 3, max: 30, step: 1 }),
    stopLossRatio: normalizeRange(
      raw.stopLossRatio as Partial<NumericPresetRange>,
      d.stopLossRatio,
      { min: 0.25, max: 2, step: 0.25 },
    ),
    trailingEnabled: booleanSetting(raw.trailingEnabled, d.trailingEnabled),
    trailingIndependent: booleanSetting(raw.trailingIndependent, d.trailingIndependent),
    trailingStart: normalizeRange(
      raw.trailingStart as Partial<NumericPresetRange>,
      d.trailingStart,
      { min: 0.5, max: 1.5, step: 0.1 },
    ),
    trailingStop: normalizeRange(
      raw.trailingStop as Partial<NumericPresetRange>,
      d.trailingStop,
      { min: 0.2, max: 0.4, step: 0.1 },
    ),
    trailingStepRatio: snap(raw.trailingStepRatio, 0.1, 1, 0.1, d.trailingStepRatio),
    autoGenerate: booleanSetting(raw.autoGenerate, d.autoGenerate),
    autoSelect: booleanSetting(raw.autoSelect, d.autoSelect),
    indicatorTypes: indicatorTypes.length > 0 ? [...new Set(indicatorTypes)] : d.indicatorTypes,
    maxIndicatorVariantsPerType: snap(
      raw.maxIndicatorVariantsPerType,
      1,
      12,
      1,
      d.maxIndicatorVariantsPerType,
    ),
    maxSignalsPerVariant: snap(raw.maxSignalsPerVariant, 8, 128, 1, d.maxSignalsPerVariant),
    maxCandlesPerRun: snap(raw.maxCandlesPerRun, 500, 20_000, 100, d.maxCandlesPerRun),
    blockEnabled: booleanSetting(raw.blockEnabled, d.blockEnabled),
    blockVolumeRatio: snap(raw.blockVolumeRatio, 0.25, 3, 0.05, d.blockVolumeRatio),
    blockProfitFactorRatio: snap(raw.blockProfitFactorRatio, 0.2, 5, 0.1, d.blockProfitFactorRatio),
    blockMaxStack: snap(raw.blockMaxStack, 1, 10, 1, d.blockMaxStack),
    blockPauseCountRatio: snap(raw.blockPauseCountRatio, 1, 4, 0.5, d.blockPauseCountRatio),
    blockActiveRealEnabled: booleanSetting(raw.blockActiveRealEnabled, d.blockActiveRealEnabled),
    blockActiveLiveEnabled: booleanSetting(raw.blockActiveLiveEnabled, d.blockActiveLiveEnabled),
  }
}

export function rangeValues(range: NumericPresetRange): number[] {
  const values: number[] = []
  const count = Math.min(10_000, Math.floor((range.max - range.min) / range.step + 1 + 1e-9))
  for (let index = 0; index < count; index++) values.push(round(range.min + index * range.step, 6))
  return values
}

export function normalizeCandles(rawCandles: unknown[]): PresetCandle[] {
  const byTimestamp = new Map<number, PresetCandle>()
  for (const raw of rawCandles || []) {
    const candle = (raw || {}) as Record<string, unknown>
    const timestamp = finite(candle.timestamp ?? candle.time ?? candle.openTime, 0)
    const close = finite(candle.close ?? candle.price ?? candle.c, 0)
    if (!(timestamp > 0) || !(close > 0)) continue
    const open = finite(candle.open ?? candle.o, close)
    const high = Math.max(open, close, finite(candle.high ?? candle.h, close))
    const low = Math.min(open, close, finite(candle.low ?? candle.l, close))
    byTimestamp.set(timestamp, {
      timestamp,
      open,
      high,
      low,
      close,
      volume: Math.max(0, finite(candle.volume ?? candle.v, 0)),
    })
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Aggregate instead of sampling individual rows so intra-bucket highs/lows are
 * retained for TP/SL and trailing-hit tests. This is the memory bound used for
 * 1–14 day optimization runs.
 */
export function aggregateCandles(candles: PresetCandle[], maxPoints: number): PresetCandle[] {
  if (candles.length <= maxPoints) return candles
  const bucketSize = Math.ceil(candles.length / maxPoints)
  const result: PresetCandle[] = []
  for (let offset = 0; offset < candles.length; offset += bucketSize) {
    const end = Math.min(candles.length, offset + bucketSize)
    const first = candles[offset]
    if (!first) continue
    let high = first.high
    let low = first.low
    let volume = 0
    for (let index = offset; index < end; index++) {
      const candle = candles[index]
      if (candle.high > high) high = candle.high
      if (candle.low < low) low = candle.low
      volume += candle.volume
    }
    const last = candles[end - 1]
    result.push({
      timestamp: last.timestamp,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    })
  }
  return result
}

function selectRangeValues(raw: unknown, fallback: NumericPresetRange, maximum: number): number[] {
  const record = (raw || {}) as Record<string, unknown>
  const requested = {
    min: finite(record.from ?? record.min, fallback.min),
    max: finite(record.to ?? record.max, fallback.max),
    step: Math.max(0.001, finite(record.step, fallback.step)),
  }
  const lowerBound = Math.min(fallback.min, requested.min, requested.max)
  const upperBound = Math.max(fallback.max, requested.min, requested.max)
  const values = rangeValues(normalizeRange(requested, fallback, {
    min: lowerBound,
    max: upperBound,
    step: requested.step,
  }))
  if (values.length <= maximum) return values
  const picked = new Set<number>()
  for (let index = 0; index < maximum; index++) {
    picked.add(values[Math.round((index * (values.length - 1)) / Math.max(1, maximum - 1))])
  }
  return [...picked]
}

function latinVariants(
  type: PresetIndicatorType,
  parameters: Record<string, number[]>,
  limit: number,
): PresetIndicatorConfiguration[] {
  const entries = Object.entries(parameters).filter(([, values]) => values.length > 0)
  const variants: PresetIndicatorConfiguration[] = []
  const seen = new Set<string>()
  for (let variant = 0; variant < limit; variant++) {
    const params: Record<string, number> = {}
    entries.forEach(([key, values], parameterIndex) => {
      const index = (variant + parameterIndex * 2) % values.length
      params[key] = values[index]
    })
    const fingerprint = JSON.stringify(params)
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint)
      variants.push({ type, params })
    }
  }
  return variants
}

function indicatorRecord(commonSettings: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = commonSettings[key]
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function buildCommonIndicatorConfigurations(
  commonSettings: Record<string, unknown> = {},
  settingsInput: Partial<PresetOptimizerSettings> = {},
): PresetIndicatorConfiguration[] {
  const settings = normalizePresetOptimizerSettings(settingsInput as Record<string, unknown>)
  const max = settings.maxIndicatorVariantsPerType
  const configurations: PresetIndicatorConfiguration[] = []

  const add = (type: PresetIndicatorType, sourceKey: string, parameters: Record<string, number[]>) => {
    if (!settings.indicatorTypes.includes(type)) return
    const source = indicatorRecord(commonSettings, sourceKey)
    if (source.enabled === false) return
    configurations.push(...latinVariants(type, parameters, max))
  }

  const rsi = indicatorRecord(commonSettings, "rsi")
  add("rsi", "rsi", {
    period: selectRangeValues(rsi.period, { min: 7, max: 21, step: 2 }, max),
    oversold: selectRangeValues(rsi.oversold, { min: 20, max: 40, step: 5 }, max),
    overbought: selectRangeValues(rsi.overbought, { min: 60, max: 80, step: 5 }, max),
  })

  const macd = indicatorRecord(commonSettings, "macd")
  add("macd", "macd", {
    fast: selectRangeValues(macd.fastPeriod, { min: 8, max: 14, step: 2 }, max),
    slow: selectRangeValues(macd.slowPeriod, { min: 21, max: 30, step: 3 }, max),
    signal: selectRangeValues(macd.signalPeriod, { min: 7, max: 11, step: 2 }, max),
  })

  const bollinger = indicatorRecord(commonSettings, "bollinger")
  add("bollinger", "bollinger", {
    period: selectRangeValues(bollinger.period, { min: 14, max: 28, step: 2 }, max),
    stdDev: selectRangeValues(bollinger.stdDev, { min: 1.5, max: 2.5, step: 0.25 }, max),
  })

  const ema = indicatorRecord(commonSettings, "ema")
  add("ema", "ema", {
    short: selectRangeValues(ema.shortPeriod ?? ema.period, { min: 5, max: 13, step: 2 }, max),
    long: selectRangeValues(ema.longPeriod, { min: 18, max: 34, step: 4 }, max),
  })

  const sma = indicatorRecord(commonSettings, "sma")
  add("sma", "sma", {
    short: selectRangeValues(sma.shortPeriod ?? sma.period, { min: 5, max: 15, step: 2 }, max),
    long: selectRangeValues(sma.longPeriod, { min: 25, max: 75, step: 10 }, max),
  })

  const stochastic = indicatorRecord(commonSettings, "stochastic")
  add("stochastic", "stochastic", {
    period: selectRangeValues(stochastic.kPeriod, { min: 7, max: 21, step: 2 }, max),
    oversold: selectRangeValues(stochastic.oversold, { min: 20, max: 35, step: 5 }, max),
    overbought: selectRangeValues(stochastic.overbought, { min: 65, max: 80, step: 5 }, max),
  })

  const adx = indicatorRecord(commonSettings, "adx")
  add("adx", "adx", {
    period: selectRangeValues(adx.period, { min: 7, max: 21, step: 2 }, max),
    threshold: selectRangeValues(adx.threshold, { min: 15, max: 35, step: 5 }, max),
  })

  const atr = indicatorRecord(commonSettings, "atr")
  add("atr", "atr", {
    period: selectRangeValues(atr.period, { min: 7, max: 21, step: 2 }, max),
    multiplier: selectRangeValues(atr.multiplier, { min: 1, max: 3, step: 0.5 }, max),
  })

  const sar = indicatorRecord(commonSettings, "parabolicSAR")
  add("sar", "parabolicSAR", {
    acceleration: selectRangeValues(sar.acceleration, { min: 0.01, max: 0.03, step: 0.005 }, max),
    maximum: selectRangeValues(sar.maximum, { min: 0.1, max: 0.3, step: 0.05 }, max),
  })

  return configurations
}

type PresetSignalDirection = "long" | "short" | null

function simpleMovingAverageSeries(values: number[], periodInput: number): number[] {
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

function exponentialMovingAverageSeries(values: number[], periodInput: number): number[] {
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

function wilderRsiSeries(candles: PresetCandle[], periodInput: number): number[] {
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
  const value = () => averageLoss === 0
    ? averageGain > 0 ? 100 : 50
    : 100 - 100 / (1 + averageGain / averageLoss)
  result[period] = value()
  for (let index = period + 1; index < candles.length; index++) {
    const change = candles[index].close - candles[index - 1].close
    const gain = Math.max(0, change)
    const loss = Math.max(0, -change)
    averageGain = (averageGain * (period - 1) + gain) / period
    averageLoss = (averageLoss * (period - 1) + loss) / period
    result[index] = value()
  }
  return result
}

function trueRange(candles: PresetCandle[], index: number): number {
  if (index <= 0) return candles[0] ? candles[0].high - candles[0].low : 0
  const candle = candles[index]
  const previousClose = candles[index - 1].close
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  )
}

function wilderAtrSeries(candles: PresetCandle[], periodInput: number): number[] {
  const period = Math.max(2, Math.round(periodInput))
  const result = new Array<number>(candles.length).fill(0)
  if (candles.length === 0) return result
  let running = 0
  for (let index = 1; index < candles.length; index++) {
    const tr = trueRange(candles, index)
    if (index <= period) {
      running += tr
      result[index] = running / index
    } else {
      result[index] = (result[index - 1] * (period - 1) + tr) / period
    }
  }
  return result
}

function wilderAdxSeries(
  candles: PresetCandle[],
  periodInput: number,
): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const period = Math.max(3, Math.round(periodInput))
  const adx = new Array<number>(candles.length).fill(0)
  const plusDi = new Array<number>(candles.length).fill(0)
  const minusDi = new Array<number>(candles.length).fill(0)
  let smoothedTr = 0
  let smoothedPlus = 0
  let smoothedMinus = 0
  let adxSeed = 0
  let adxSeedCount = 0
  let currentAdx = 0
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
    const diTotal = plusDi[index] + minusDi[index]
    const dx = diTotal > 0 ? (Math.abs(plusDi[index] - minusDi[index]) / diTotal) * 100 : 0
    if (adxSeedCount < period) {
      adxSeed += dx
      adxSeedCount++
      if (adxSeedCount === period) currentAdx = adxSeed / period
    } else {
      currentAdx = (currentAdx * (period - 1) + dx) / period
    }
    if (adxSeedCount >= period) adx[index] = currentAdx
  }
  return { adx, plusDi, minusDi }
}

function parabolicSarDirections(
  candles: PresetCandle[],
  accelerationInput: number,
  maximumInput: number,
): PresetSignalDirection[] {
  const directions = new Array<PresetSignalDirection>(candles.length).fill(null)
  if (candles.length < 2) return directions
  const acceleration = clamp(finite(accelerationInput, 0.02), 0.001, 1)
  const maximum = Math.max(acceleration, clamp(finite(maximumInput, 0.2), acceleration, 1))
  let rising = candles[1].close >= candles[0].close
  let sar = rising
    ? Math.min(candles[0].low, candles[1].low)
    : Math.max(candles[0].high, candles[1].high)
  let extreme = rising
    ? Math.max(candles[0].high, candles[1].high)
    : Math.min(candles[0].low, candles[1].low)
  let factor = acceleration
  directions[1] = rising ? "long" : "short"
  for (let index = 2; index < candles.length; index++) {
    let nextSar = sar + factor * (extreme - sar)
    if (rising) {
      nextSar = Math.min(nextSar, candles[index - 1].low, candles[index - 2].low)
      if (candles[index].low < nextSar) {
        rising = false
        nextSar = extreme
        extreme = candles[index].low
        factor = acceleration
      } else if (candles[index].high > extreme) {
        extreme = candles[index].high
        factor = Math.min(maximum, factor + acceleration)
      }
    } else {
      nextSar = Math.max(nextSar, candles[index - 1].high, candles[index - 2].high)
      if (candles[index].high > nextSar) {
        rising = true
        nextSar = extreme
        extreme = candles[index].high
        factor = acceleration
      } else if (candles[index].low < extreme) {
        extreme = candles[index].low
        factor = Math.min(maximum, factor + acceleration)
      }
    }
    sar = nextSar
    directions[index] = rising ? "long" : "short"
  }
  return directions
}

function buildSignalSeries(
  candles: PresetCandle[],
  config: PresetIndicatorConfiguration,
): PresetSignalDirection[] {
  const result = new Array<PresetSignalDirection>(candles.length).fill(null)
  const closes = candles.map((candle) => candle.close)
  const p = config.params
  if (candles.length === 0) return result

  switch (config.type) {
    case "rsi": {
      const values = wilderRsiSeries(candles, p.period || 14)
      for (let index = 0; index < candles.length; index++) {
        if (values[index] <= (p.oversold || 30)) result[index] = "long"
        else if (values[index] >= (p.overbought || 70)) result[index] = "short"
      }
      break
    }
    case "macd": {
      const fast = Math.max(2, Math.round(p.fast || 12))
      const slow = Math.max(fast + 1, Math.round(p.slow || 26))
      const fastEma = exponentialMovingAverageSeries(closes, fast)
      const slowEma = exponentialMovingAverageSeries(closes, slow)
      const macd = closes.map((_, index) => fastEma[index] - slowEma[index])
      const signal = exponentialMovingAverageSeries(macd, Math.max(2, Math.round(p.signal || 9)))
      for (let index = 1; index < candles.length; index++) {
        if (macd[index] > signal[index] && macd[index - 1] <= signal[index - 1]) result[index] = "long"
        else if (macd[index] < signal[index] && macd[index - 1] >= signal[index - 1]) result[index] = "short"
      }
      break
    }
    case "bollinger": {
      const period = Math.max(3, Math.round(p.period || 20))
      const means = simpleMovingAverageSeries(closes, period)
      let sum = 0
      let sumSquares = 0
      for (let index = 0; index < candles.length; index++) {
        sum += closes[index]
        sumSquares += closes[index] ** 2
        if (index >= period) {
          sum -= closes[index - period]
          sumSquares -= closes[index - period] ** 2
        }
        const count = Math.min(period, index + 1)
        const variance = Math.max(0, sumSquares / count - (sum / count) ** 2)
        const deviation = Math.sqrt(variance) * (p.stdDev || 2)
        if (closes[index] <= means[index] - deviation) result[index] = "long"
        else if (closes[index] >= means[index] + deviation) result[index] = "short"
      }
      break
    }
    case "ema":
    case "sma": {
      const short = Math.max(2, Math.round(p.short || 9))
      const long = Math.max(short + 1, Math.round(p.long || 21))
      const shortAverage = config.type === "ema"
        ? exponentialMovingAverageSeries(closes, short)
        : simpleMovingAverageSeries(closes, short)
      const longAverage = config.type === "ema"
        ? exponentialMovingAverageSeries(closes, long)
        : simpleMovingAverageSeries(closes, long)
      for (let index = 1; index < candles.length; index++) {
        if (shortAverage[index] > longAverage[index] && shortAverage[index - 1] <= longAverage[index - 1]) {
          result[index] = "long"
        } else if (shortAverage[index] < longAverage[index] && shortAverage[index - 1] >= longAverage[index - 1]) {
          result[index] = "short"
        }
      }
      break
    }
    case "stochastic": {
      const period = Math.max(3, Math.round(p.period || 14))
      for (let index = 0; index < candles.length; index++) {
        const start = Math.max(0, index - period + 1)
        let high = Number.NEGATIVE_INFINITY
        let low = Number.POSITIVE_INFINITY
        for (let cursor = start; cursor <= index; cursor++) {
          high = Math.max(high, candles[cursor].high)
          low = Math.min(low, candles[cursor].low)
        }
        const k = high > low ? ((candles[index].close - low) / (high - low)) * 100 : 50
        if (k <= (p.oversold || 20)) result[index] = "long"
        else if (k >= (p.overbought || 80)) result[index] = "short"
      }
      break
    }
    case "adx": {
      const values = wilderAdxSeries(candles, p.period || 14)
      for (let index = 0; index < candles.length; index++) {
        if (values.adx[index] < (p.threshold || 25)) continue
        if (values.plusDi[index] > values.minusDi[index]) result[index] = "long"
        else if (values.minusDi[index] > values.plusDi[index]) result[index] = "short"
      }
      break
    }
    case "atr": {
      const period = Math.max(3, Math.round(p.period || 14))
      const atr = wilderAtrSeries(candles, period)
      const baseline = simpleMovingAverageSeries(closes, period)
      const multiplier = Math.max(0.1, p.multiplier || 1.5)
      for (let index = 1; index < candles.length; index++) {
        if (closes[index] > baseline[index - 1] + atr[index] * multiplier) result[index] = "long"
        else if (closes[index] < baseline[index - 1] - atr[index] * multiplier) result[index] = "short"
      }
      break
    }
    case "sar":
      return parabolicSarDirections(candles, p.acceleration || 0.02, p.maximum || 0.2)
  }
  return result
}

export function generatePresetSignals(
  candles: PresetCandle[],
  config: PresetIndicatorConfiguration,
  maximum: number,
): PresetSignalEntry[] {
  const warmup = Math.max(30, ...Object.values(config.params).map((value) => Math.ceil(value || 0)))
  const signalSeries = buildSignalSeries(candles, config)
  const candidates: PresetSignalEntry[] = []
  for (let index = warmup; index < candles.length - 1; index++) {
    const direction = signalSeries[index]
    if (!direction) continue
    candidates.push({ index, direction })
  }
  const limit = Math.max(1, Math.floor(maximum))
  if (candidates.length <= limit) return candidates

  // Use evenly-spaced quantiles instead of taking the first N signals. The
  // old early-fill loop could put every sampled trade in days 1–4 of a 14-day
  // run, producing empty later-day diagrams and a biased average PF.
  const sampled: PresetSignalEntry[] = []
  const selectedIndexes = new Set<number>()
  for (let offset = 0; offset < limit; offset++) {
    const candidateIndex = Math.round((offset * (candidates.length - 1)) / Math.max(1, limit - 1))
    if (selectedIndexes.has(candidateIndex)) continue
    selectedIndexes.add(candidateIndex)
    sampled.push(candidates[candidateIndex])
  }
  return sampled
}

function trailingKey(start: number, stop: number, step: number): string {
  return `${start.toFixed(4)}:${stop.toFixed(4)}:${step.toFixed(4)}`
}

function hitForThreshold(
  candles: PresetCandle[],
  entry: PresetSignalEntry,
  endIndex: number,
  percent: number,
  kind: "take_profit" | "stop_loss",
): ExitHit | null {
  const entryPrice = candles[entry.index].close
  const fraction = percent / 100
  const target = entry.direction === "long"
    ? entryPrice * (1 + (kind === "take_profit" ? fraction : -fraction))
    : entryPrice * (1 + (kind === "take_profit" ? -fraction : fraction))
  for (let index = entry.index + 1; index <= endIndex; index++) {
    const candle = candles[index]
    const hit = entry.direction === "long"
      ? kind === "take_profit" ? candle.high >= target : candle.low <= target
      : kind === "take_profit" ? candle.low <= target : candle.high >= target
    if (hit) return { index, price: target, reason: kind }
  }
  return null
}

function hitForTrailing(
  candles: PresetCandle[],
  entry: PresetSignalEntry,
  endIndex: number,
  profile: PresetTrailingConfiguration,
): ExitHit | null {
  const entryPrice = candles[entry.index].close
  let active = false
  let anchor = entryPrice
  let stop = 0
  for (let index = entry.index + 1; index <= endIndex; index++) {
    const candle = candles[index]
    const favorable = entry.direction === "long"
      ? (candle.high - entryPrice) / entryPrice
      : (entryPrice - candle.low) / entryPrice
    if (!active && favorable >= profile.startRatio) {
      active = true
      anchor = entry.direction === "long" ? candle.high : candle.low
      stop = entry.direction === "long"
        ? anchor * (1 - profile.stopRatio)
        : anchor * (1 + profile.stopRatio)
    }
    if (!active) continue

    const favorablePrice = entry.direction === "long" ? candle.high : candle.low
    const ratchetDistance = entryPrice * profile.stepRatio
    const shouldRatchet = entry.direction === "long"
      ? favorablePrice - anchor >= ratchetDistance
      : anchor - favorablePrice >= ratchetDistance
    if (shouldRatchet) {
      anchor = favorablePrice
      stop = entry.direction === "long"
        ? anchor * (1 - profile.stopRatio)
        : anchor * (1 + profile.stopRatio)
    }
    const crossed = entry.direction === "long" ? candle.low <= stop : candle.high >= stop
    if (crossed) return { index, price: stop, reason: "trailing" }
  }
  return null
}

function preparePaths(
  candles: PresetCandle[],
  entries: PresetSignalEntry[],
  settings: PresetOptimizerSettings,
  positionCostPct: number,
): PreparedPath[] {
  const tpRatios = rangeValues(settings.takeProfit)
  const slRatios = rangeValues(settings.stopLossRatio)
  const takeProfitPercents = [...new Set(tpRatios.map((ratio) => round(ratio * positionCostPct, 6)))]
  const stopLossPercents = [...new Set(tpRatios.flatMap((tp) => slRatios.map((sl) => round(tp * positionCostPct * sl, 6))))]
  const trailingProfiles = buildTrailingConfigurations(settings).filter((profile) => profile.enabled)

  return entries.map((entry) => {
    const deadline = candles[entry.index].timestamp + settings.maxDrawdownHours * HOUR_MS
    let endIndex = entry.index + 1
    while (endIndex + 1 < candles.length && candles[endIndex + 1].timestamp <= deadline) endIndex++
    const timeout: ExitHit = {
      index: endIndex,
      price: candles[endIndex].close,
      reason: "timeout",
    }
    const takeProfitHits = new Map<number, ExitHit>()
    const stopLossHits = new Map<number, ExitHit>()
    const trailingHits = new Map<string, ExitHit>()
    for (const percent of takeProfitPercents) {
      const hit = hitForThreshold(candles, entry, endIndex, percent, "take_profit")
      if (hit) takeProfitHits.set(percent, hit)
    }
    for (const percent of stopLossPercents) {
      const hit = hitForThreshold(candles, entry, endIndex, percent, "stop_loss")
      if (hit) stopLossHits.set(percent, hit)
    }
    for (const profile of trailingProfiles) {
      const hit = hitForTrailing(candles, entry, endIndex, profile)
      if (hit) trailingHits.set(trailingKey(profile.startRatio, profile.stopRatio, profile.stepRatio), hit)
    }
    return {
      entry,
      entryPrice: candles[entry.index].close,
      entryTime: candles[entry.index].timestamp,
      timeout,
      takeProfitHits,
      stopLossHits,
      trailingHits,
    }
  })
}

export function buildTrailingConfigurations(settings: PresetOptimizerSettings): PresetTrailingConfiguration[] {
  const profiles: PresetTrailingConfiguration[] = [{
    enabled: false,
    independent: false,
    startRatio: 0,
    stopRatio: 0,
    stepRatio: 0,
  }]
  if (!settings.trailingEnabled) return profiles
  for (const startRatio of rangeValues(settings.trailingStart)) {
    for (const stopRatio of rangeValues(settings.trailingStop)) {
      profiles.push({
        enabled: true,
        independent: settings.trailingIndependent,
        startRatio,
        stopRatio,
        stepRatio: round(stopRatio * settings.trailingStepRatio, 6),
      })
    }
  }
  return profiles
}

function earlierExit(...hits: Array<ExitHit | undefined>): ExitHit {
  let selected: ExitHit | undefined
  for (const hit of hits) {
    if (!hit) continue
    if (
      !selected ||
      hit.index < selected.index ||
      (hit.index === selected.index && hit.reason === "stop_loss" && selected.reason !== "stop_loss")
    ) {
      selected = hit
    }
  }
  // Every caller supplies a timeout fallback, so this is an invariant guard
  // rather than a normal execution path.
  if (!selected) throw new Error("Preset path has no exit")
  return selected
}

interface CandidateMetricScratch {
  signedResults: Float64Array
  exitTimes: Float64Array
  order: number[]
  dailyCount: Float64Array
  dailyWins: Float64Array
  dailyPositiveR: Float64Array
  dailyNegativeR: Float64Array
  dailyNetR: Float64Array
}

function createCandidateMetricScratch(positionCount: number, historyDays: number): CandidateMetricScratch {
  return {
    signedResults: new Float64Array(positionCount),
    exitTimes: new Float64Array(positionCount),
    order: Array.from({ length: positionCount }, (_, index) => index),
    dailyCount: new Float64Array(historyDays),
    dailyWins: new Float64Array(historyDays),
    dailyPositiveR: new Float64Array(historyDays),
    dailyNegativeR: new Float64Array(historyDays),
    dailyNetR: new Float64Array(historyDays),
  }
}

function metricsForCandidate(
  paths: PreparedPath[],
  candles: PresetCandle[],
  positionCostPct: number,
  takeProfitPct: number,
  stopLossPct: number,
  trailing: PresetTrailingConfiguration,
  settings: PresetOptimizerSettings,
  historyEnd: number,
  scratch: CandidateMetricScratch,
  includeDaily = true,
): PresetMetrics {
  scratch.dailyCount.fill(0)
  scratch.dailyWins.fill(0)
  scratch.dailyPositiveR.fill(0)
  scratch.dailyNegativeR.fill(0)
  scratch.dailyNetR.fill(0)
  const roundedTakeProfit = round(takeProfitPct, 6)
  const roundedStopLoss = round(stopLossPct, 6)
  const trailingHitKey = trailing.enabled
    ? trailingKey(trailing.startRatio, trailing.stopRatio, trailing.stepRatio)
    : ""
  const historyStart = historyEnd - settings.historyDays * DAY_MS
  let grossPositiveR = 0
  let grossNegativeR = 0
  let netR = 0
  let wins = 0
  let losses = 0
  let totalHoldMinutes = 0
  let exitsAreOrdered = true
  let previousExitTime = Number.NEGATIVE_INFINITY
  let longActiveUntil = Number.NEGATIVE_INFINITY
  let shortActiveUntil = Number.NEGATIVE_INFINITY
  let acceptedCount = 0
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]
    const exit = earlierExit(
      path.stopLossHits.get(roundedStopLoss),
      trailing.enabled && trailing.independent ? undefined : path.takeProfitHits.get(roundedTakeProfit),
      trailing.enabled ? path.trailingHits.get(trailingHitKey) : undefined,
      path.timeout,
    )
    const rawMovePct = path.entry.direction === "long"
      ? ((exit.price - path.entryPrice) / path.entryPrice) * 100
      : ((path.entryPrice - exit.price) / path.entryPrice) * 100
    const value = positionCostPct > 0 ? rawMovePct / positionCostPct : 0
    const exitTime = candles[exit.index]?.timestamp ?? path.entryTime
    // Match the engine's one-active-position-per-symbol/direction constraint.
    // Signals occurring while their direction already has an open historical
    // position are skipped instead of being counted as impossible overlapping
    // exposure that would inflate PF, volume, and win/loss totals.
    const activeUntil = path.entry.direction === "long" ? longActiveUntil : shortActiveUntil
    if (path.entryTime <= activeUntil) continue
    if (path.entry.direction === "long") longActiveUntil = exitTime
    else shortActiveUntil = exitTime

    const acceptedIndex = acceptedCount++
    scratch.signedResults[acceptedIndex] = Number.isFinite(value) ? value : 0
    scratch.exitTimes[acceptedIndex] = exitTime
    if (exitTime < previousExitTime) exitsAreOrdered = false
    previousExitTime = exitTime
    netR += scratch.signedResults[acceptedIndex]
    totalHoldMinutes += Math.max(0, exitTime - path.entryTime) / 60_000
    if (value > 0) {
      wins++
      grossPositiveR += value
    } else if (value < 0) {
      losses++
      grossNegativeR += Math.abs(value)
    }

    const elapsed = exitTime - historyStart
    if (!(elapsed > 0) || elapsed > settings.historyDays * DAY_MS) continue
    const dayIndex = Math.min(settings.historyDays - 1, Math.ceil(elapsed / DAY_MS) - 1)
    scratch.dailyCount[dayIndex]++
    scratch.dailyNetR[dayIndex] += value
    if (value > 0) {
      scratch.dailyWins[dayIndex]++
      scratch.dailyPositiveR[dayIndex] += value
    } else if (value < 0) {
      scratch.dailyNegativeR[dayIndex] += Math.abs(value)
    }
  }
  const count = acceptedCount
  const aggregateProfitFactor = grossNegativeR > 0
    ? grossPositiveR / grossNegativeR
    : grossPositiveR > 0 ? 999 : 0
  const daily: PresetDailyStats[] = []
  const dailyFactors: number[] = []
  for (let index = 0; index < settings.historyDays; index++) {
    const dayCount = scratch.dailyCount[index]
    const dayPositive = scratch.dailyPositiveR[index]
    const dayNegative = scratch.dailyNegativeR[index]
    const profitFactor = dayNegative > 0 ? dayPositive / dayNegative : dayPositive > 0 ? 999 : 0
    if (dayCount > 0) dailyFactors.push(Math.min(10, profitFactor))
    if (includeDaily) {
      daily.push({
        day: index + 1,
        date: new Date(historyStart + (index + 1) * DAY_MS).toISOString().slice(0, 10),
        profitFactor: round(profitFactor, 4),
        netR: round(scratch.dailyNetR[index], 4),
        averageR: round(dayCount > 0 ? scratch.dailyNetR[index] / dayCount : 0, 4),
        winRate: round((dayCount > 0 ? scratch.dailyWins[index] / dayCount : 0) * 100, 2),
        positions: dayCount,
      })
    }
  }
  const averageProfitFactor = dailyFactors.length > 0
    ? dailyFactors.reduce((sum, value) => sum + value, 0) / dailyFactors.length
    : Math.min(10, aggregateProfitFactor)
  scratch.order.length = count
  for (let index = 0; index < count; index++) scratch.order[index] = index
  if (!exitsAreOrdered) scratch.order.sort((a, b) => scratch.exitTimes[a] - scratch.exitTimes[b])
  let equity = 0
  let peak = 0
  let maxDrawdownR = 0
  let drawdownStartedAt: number | null = null
  let maxDurationMs = 0
  for (let offset = 0; offset < count; offset++) {
    const index = exitsAreOrdered ? offset : scratch.order[offset]
    const exitTime = scratch.exitTimes[index]
    equity += scratch.signedResults[index]
    if (equity >= peak) {
      if (drawdownStartedAt !== null) maxDurationMs = Math.max(maxDurationMs, exitTime - drawdownStartedAt)
      peak = equity
      drawdownStartedAt = null
    } else {
      if (drawdownStartedAt === null) drawdownStartedAt = exitTime
      maxDrawdownR = Math.max(maxDrawdownR, peak - equity)
    }
  }
  if (drawdownStartedAt !== null) maxDurationMs = Math.max(maxDurationMs, historyEnd - drawdownStartedAt)
  const drawdownHours = Math.max(0, maxDurationMs) / HOUR_MS
  const sampleConfidence = Math.min(1, count / 24)
  const boundedPf = Math.min(10, aggregateProfitFactor)
  const averageR = count > 0 ? netR / count : 0
  const winRate = count > 0 ? wins / count : 0
  const score =
    boundedPf * 3.2 +
    averageProfitFactor * 2.4 +
    Math.max(-5, Math.min(5, averageR)) * 1.4 +
    winRate * 2 +
    sampleConfidence * 2 -
    Math.min(10, maxDrawdownR) * 0.35 -
    Math.min(24, drawdownHours) * 0.25
  return {
    profitFactor: round(aggregateProfitFactor, 4),
    averageProfitFactor: round(averageProfitFactor, 4),
    netR: round(netR, 4),
    averageR: round(averageR, 4),
    grossPositiveR: round(grossPositiveR, 4),
    grossNegativeR: round(grossNegativeR, 4),
    winRate: round(winRate * 100, 2),
    totalPositions: count,
    winningPositions: wins,
    losingPositions: losses,
    maxDrawdownR: round(maxDrawdownR, 4),
    drawdownTimeHours: round(drawdownHours, 3),
    averageHoldMinutes: round(
      count > 0 ? totalHoldMinutes / count : 0,
      2,
    ),
    score: round(score, 6),
    eligible:
      count > 0 &&
      aggregateProfitFactor >= settings.minProfitFactor &&
      drawdownHours <= settings.maxDrawdownHours,
    daily,
  }
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function insertCandidate(pool: OptimizedPreset[], candidate: OptimizedPreset, limit: number): void {
  pool.push(candidate)
  pool.sort((a, b) =>
    Number(b.metrics.eligible) - Number(a.metrics.eligible) ||
    b.metrics.score - a.metrics.score ||
    b.metrics.totalPositions - a.metrics.totalPositions ||
    a.id.localeCompare(b.id),
  )
  if (pool.length > limit) pool.length = limit
}

function diverseTop(pool: OptimizedPreset[], count: number, trailingEnabled: boolean): OptimizedPreset[] {
  const selected: OptimizedPreset[] = []
  const fingerprints = new Set<string>()
  const add = (candidate: OptimizedPreset | undefined) => {
    if (!candidate || selected.includes(candidate)) return
    const fingerprint = `${candidate.takeProfitRatio}:${candidate.stopLossToTakeProfitRatio}:${candidate.trailing.enabled}`
    if (fingerprints.has(fingerprint)) return
    fingerprints.add(fingerprint)
    selected.push(candidate)
  }
  add(pool.find((candidate) => candidate.metrics.eligible && !candidate.trailing.enabled))
  if (trailingEnabled) add(pool.find((candidate) => candidate.metrics.eligible && candidate.trailing.enabled))
  for (const candidate of pool) {
    if (selected.length >= count) break
    add(candidate)
  }
  return selected.slice(0, count).map((preset, index) => ({ ...preset, rank: index + 1 }))
}

export function optimizePresetsForSymbol(input: {
  connectionId: string
  symbol: string
  candles: unknown[]
  commonSettings?: Record<string, unknown>
  settings?: Record<string, unknown>
  positionCostPct: number
  sourceCandleCount?: number
  now?: number
}): PresetOptimizationResult {
  const settings = normalizePresetOptimizerSettings(input.settings || {})
  let allCandles = normalizeCandles(input.candles)
  const sourceCandleCount = Math.max(
    allCandles.length,
    Math.floor(finite(input.sourceCandleCount, allCandles.length)),
  )
  const now = input.now ?? allCandles[allCandles.length - 1]?.timestamp ?? Date.now()
  const cutoff = now - settings.historyDays * DAY_MS
  let ranged = allCandles.filter((candle) => candle.timestamp >= cutoff && candle.timestamp <= now)
  const candles = aggregateCandles(ranged, settings.maxCandlesPerRun)
  // Historical input is needed only to produce this bounded working set.
  // Release both larger reference arrays before the calculation matrix runs;
  // this keeps the hot phase proportional to maxCandlesPerRun for 12/32 symbols.
  allCandles = []
  if (candles !== ranged) ranged = []
  const indicatorConfigs = buildCommonIndicatorConfigurations(input.commonSettings || {}, settings)
  const positionCostPct = clamp(finite(input.positionCostPct, 0.1), 0.000001, 100)
  const takeProfitRatios = rangeValues(settings.takeProfit)
  const stopLossRatios = rangeValues(settings.stopLossRatio)
  const trailingConfigurations = buildTrailingConfigurations(settings)
  const pools = new Map<PresetIndicatorType, OptimizedPreset[]>()
  const generatedAt = new Date().toISOString()
  const historyFrom = candles[0]?.timestamp ?? now
  const historyTo = candles[candles.length - 1]?.timestamp ?? now
  let evaluatedConfigurations = 0
  let signalCount = 0

  if (candles.length < 40) {
    return {
      presets: [],
      evaluatedConfigurations: 0,
      indicatorVariants: indicatorConfigs.length,
      signals: 0,
      sourceCandles: sourceCandleCount,
      sampledCandles: candles.length,
      historyFrom: candles[0] ? new Date(historyFrom).toISOString() : null,
      historyTo: candles[0] ? new Date(historyTo).toISOString() : null,
    }
  }

  for (const indicator of indicatorConfigs) {
    const signals = generatePresetSignals(candles, indicator, settings.maxSignalsPerVariant)
    signalCount += signals.length
    if (signals.length === 0) continue
    const paths = preparePaths(candles, signals, settings, positionCostPct)
    const metricScratch = createCandidateMetricScratch(paths.length, settings.historyDays)
    const pool = pools.get(indicator.type) || []

    for (const takeProfitRatio of takeProfitRatios) {
      const takeProfitPct = round(takeProfitRatio * positionCostPct, 6)
      for (const stopLossToTakeProfitRatio of stopLossRatios) {
        const stopLossPct = round(takeProfitPct * stopLossToTakeProfitRatio, 6)
        for (const trailing of trailingConfigurations) {
          evaluatedConfigurations++
          // Ranking needs scalar metrics but not fourteen allocated daily-row
          // objects for every candidate. Detailed daily rows are materialized
          // only for the bounded finalist pool below.
          const metrics = metricsForCandidate(
            paths,
            candles,
            positionCostPct,
            takeProfitPct,
            stopLossPct,
            trailing,
            settings,
            historyTo,
            metricScratch,
            false,
          )
          const identity = JSON.stringify({
            connectionId: input.connectionId,
            symbol: input.symbol,
            indicator,
            positionCostPct,
            takeProfitRatio,
            stopLossToTakeProfitRatio,
            trailing,
          })
          const candidate: OptimizedPreset = {
            id: `preset-${stableHash(identity)}`,
            connectionId: input.connectionId,
            symbol: input.symbol,
            indicator,
            positionCostPct,
            takeProfitRatio,
            takeProfitPct,
            takeProfitEnabled: !(trailing.enabled && trailing.independent),
            stopLossToTakeProfitRatio,
            stopLossPct,
            trailing,
            metrics,
            selected: false,
            rank: 0,
            generatedAt,
            historyFrom: new Date(historyFrom).toISOString(),
            historyTo: new Date(historyTo).toISOString(),
            dataPoints: candles.length,
          }
          insertCandidate(pool, candidate, Math.max(32, settings.presetsPerSymbol * 12))
        }
      }
    }
    const detailedPool = pool.map((candidate) => {
      // The per-type pool spans several indication parameter variants. Only
      // candidates created from the current variant may be recomputed against
      // its prepared paths; older finalists already carry their own detailed
      // metrics and must not be evaluated using another variant's signals.
      if (candidate.indicator !== indicator || candidate.metrics.daily.length > 0) return candidate
      return {
        ...candidate,
        metrics: metricsForCandidate(
          paths,
          candles,
          positionCostPct,
          candidate.takeProfitPct,
          candidate.stopLossPct,
          candidate.trailing,
          settings,
          historyTo,
          metricScratch,
          true,
        ),
      }
    })
    detailedPool.sort((a, b) =>
      Number(b.metrics.eligible) - Number(a.metrics.eligible) ||
      b.metrics.score - a.metrics.score ||
      b.metrics.totalPositions - a.metrics.totalPositions ||
      a.id.localeCompare(b.id),
    )
    pools.set(indicator.type, detailedPool)
  }

  const presets: OptimizedPreset[] = []
  for (const type of settings.indicatorTypes) {
    const selected = diverseTop(pools.get(type) || [], settings.presetsPerSymbol, settings.trailingEnabled)
    presets.push(...selected)
  }
  presets.sort((a, b) =>
    Number(b.metrics.eligible) - Number(a.metrics.eligible) ||
    b.metrics.score - a.metrics.score ||
    a.symbol.localeCompare(b.symbol) ||
    a.indicator.type.localeCompare(b.indicator.type),
  )

  return {
    presets,
    evaluatedConfigurations,
    indicatorVariants: indicatorConfigs.length,
    signals: signalCount,
    sourceCandles: sourceCandleCount,
    sampledCandles: candles.length,
    historyFrom: new Date(historyFrom).toISOString(),
    historyTo: new Date(historyTo).toISOString(),
  }
}
