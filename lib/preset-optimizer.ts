import { REALIZED_PROFIT_FACTOR_MIN_DEFAULT } from "@/lib/profit-factor-defaults"
import {
  normalizeMainTradePfRatio,
  signedResultRToMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"
import {
  COMMON_INDICATOR_DEFINITIONS,
  COMMON_INDICATOR_TYPES,
  LEGACY_COMMON_INDICATOR_TYPES,
  type CommonIndicatorDefinition,
  type CommonIndicatorType,
} from "@/lib/common-indicator-config"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { commonRuleStates, getCommonRule } from "@/lib/common-indicators/registry"
import {
  BLOCK_COUNT_MAX,
  BLOCK_INCREMENT_STEPS_MAX,
  normalizeBlockProfitFactorRatio,
} from "@/lib/block-count-state"

/**
 * Every Common type is an optimizer type: the 17 original ones and the types
 * ported from CTS-A-O (lib/common-indicator-config.ts). The optimizer and the
 * live engine evaluate the same causal rule (lib/common-indicators/registry.ts).
 */
export const PRESET_INDICATOR_TYPES: readonly CommonIndicatorType[] = COMMON_INDICATOR_TYPES

/** `sar` remains readable for legacy presets but is not generated twice. */
export type PresetIndicatorType = CommonIndicatorType | "sar"
const VALID_PRESET_INDICATOR_TYPES: readonly PresetIndicatorType[] = [
  ...PRESET_INDICATOR_TYPES,
  "sar",
]

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
  blockIncrementSteps: number
  blockMaxStack: number
  blockPauseCountRatio: number
  blockActiveRealEnabled: boolean
  blockActiveLiveEnabled: boolean
}

export const DEFAULT_PRESET_OPTIMIZER_SETTINGS: PresetOptimizerSettings = {
  historyDays: 14,
  presetsPerSymbol: 4,
  minProfitFactor: REALIZED_PROFIT_FACTOR_MIN_DEFAULT,
  maxDrawdownHours: 5,
  // Fresh preset grids begin at the systemwide five-step floor. The
  // normalizer still accepts an explicit legacy three-step range so existing
  // persisted presets remain reproducible until an operator changes them.
  takeProfit: { min: 5, max: 30, step: 1 },
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
  blockProfitFactorRatio: 1.1,
  blockIncrementSteps: BLOCK_INCREMENT_STEPS_MAX,
  blockMaxStack: BLOCK_COUNT_MAX,
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
  /** PositionCost-relative selection coordinate for this day's average net R. */
  positionCostRatio: number
  winRate: number
  positions: number
}

export interface PresetMetrics {
  profitFactor: number
  averageProfitFactor: number
  /** Canonical admission coordinate; classic PF remains in `profitFactor`. */
  positionCostRatio: number
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

/**
 * Express a gross price move in net PositionCost multiples.
 *
 * One gross PositionCost is neutral (0R) after the cost is deducted once;
 * two gross costs are +1R. This keeps the optimizer's PF, win rate, daily
 * totals, drawdown and ranking on the same cost-adjusted basis as Direct,
 * Base/Main/Real and Auto-Optimal calculations.
 */
export function netPositionCostMultiple(
  grossMovePct: unknown,
  positionCostPct: unknown,
): number {
  const gross = finite(grossMovePct, 0)
  const cost = Math.max(0, finite(positionCostPct, 0))
  return cost > 0 ? (gross - cost) / cost : 0
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

/**
 * A stored type list that is still the former 17-type default (with or
 * without the legacy "sar" alias) gains every type added since — new Common
 * types are on by default. A list the operator customised is kept as it is.
 */
export function expandLegacyDefaultIndicatorTypes(types: readonly string[]): string[] {
  const listed = new Set(types.map((type) => (type === "sar" ? "psar" : type)))
  const isFormerDefault = listed.size === LEGACY_COMMON_INDICATOR_TYPES.length &&
    LEGACY_COMMON_INDICATOR_TYPES.every((type) => listed.has(type))
  return isFormerDefault ? [...PRESET_INDICATOR_TYPES] : [...types]
}

export function normalizePresetOptimizerSettings(raw: Record<string, unknown> = {}): PresetOptimizerSettings {
  const d = DEFAULT_PRESET_OPTIMIZER_SETTINGS
  const indicatorTypes = Array.isArray(raw.indicatorTypes)
    ? expandLegacyDefaultIndicatorTypes(raw.indicatorTypes.map(String))
        .map((type) => type === "sar" ? "psar" : type)
        .filter((type): type is PresetIndicatorType =>
          VALID_PRESET_INDICATOR_TYPES.includes(type as PresetIndicatorType))
    : d.indicatorTypes

  return {
    historyDays: snap(raw.historyDays, 1, 14, 1, d.historyDays),
    presetsPerSymbol: snap(raw.presetsPerSymbol, 1, 12, 1, d.presetsPerSymbol),
    minProfitFactor: normalizeMainTradePfRatio(raw.minProfitFactor, d.minProfitFactor),
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
    blockProfitFactorRatio: normalizeBlockProfitFactorRatio(
      raw.blockProfitFactorRatio,
      d.blockProfitFactorRatio,
    ),
    blockIncrementSteps: snap(raw.blockIncrementSteps, 1, BLOCK_INCREMENT_STEPS_MAX, 1, d.blockIncrementSteps),
    blockMaxStack: snap(raw.blockMaxStack, 1, BLOCK_COUNT_MAX, 1, d.blockMaxStack),
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

/** Wall-clock bar lengths (minutes) the aggregation may use; every Common timeframe is a multiple of one of them. */
const ALIGNED_AGGREGATION_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440] as const

/**
 * Aggregate instead of sampling individual rows so intra-bucket highs/lows are
 * retained for TP/SL and trailing-hit tests. This is the memory bound used for
 * 1–14 day optimization runs.
 *
 * Wall-clock series are aggregated into UTC-aligned bars of the smallest
 * standard length that fits `maxPoints`, stamped with the bar's open time, so
 * timeframes and time-anchored rules keep their meaning (14 days of 1m bars
 * become 5m bars instead of "every 4 rows"). Index-ordered input keeps the
 * row-count buckets.
 */
export function aggregateCandles(candles: PresetCandle[], maxPoints: number): PresetCandle[] {
  if (candles.length <= maxPoints) return candles
  const first = candles[0].timestamp
  const last = candles[candles.length - 1].timestamp
  if (first > 10_000_000_000) {
    for (const minutes of ALIGNED_AGGREGATION_MINUTES) {
      const bucketMs = minutes * 60_000
      if (Math.floor(last / bucketMs) - Math.floor(first / bucketMs) + 1 > maxPoints) continue
      const result: PresetCandle[] = []
      let bucket = Number.NaN
      for (const candle of candles) {
        const next = Math.floor(candle.timestamp / bucketMs)
        if (next !== bucket) {
          bucket = next
          result.push({ ...candle, timestamp: next * bucketMs })
          continue
        }
        const target = result[result.length - 1]
        if (candle.high > target.high) target.high = candle.high
        if (candle.low < target.low) target.low = candle.low
        target.close = candle.close
        target.volume += candle.volume
      }
      return result
    }
  }
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

function selectRangeValues(raw: unknown, fallback: NumericPresetRange, _batchSize: number): number[] {
  const record = (raw || {}) as Record<string, unknown>
  const requested = {
    min: finite(record.from ?? record.min, fallback.min),
    max: finite(record.to ?? record.max, fallback.max),
    step: Math.max(0.001, finite(record.step, fallback.step)),
  }
  const lowerBound = Math.min(fallback.min, requested.min, requested.max)
  const upperBound = Math.max(fallback.max, requested.min, requested.max)
  return rangeValues(normalizeRange(requested, fallback, {
    min: lowerBound,
    max: upperBound,
    step: requested.step,
  }))
}

const DEFINITION_BY_TYPE: ReadonlyMap<string, CommonIndicatorDefinition> = new Map(
  COMMON_INDICATOR_DEFINITIONS.map((definition) => [definition.type, definition]),
)
const LEGACY_TYPES: ReadonlySet<string> = new Set(LEGACY_COMMON_INDICATOR_TYPES)

/** The catalogue's ordering constraints (fast < slow, tenkan < kijun < senkou, …) of a type. */
function satisfiesDefinitionConstraints(type: PresetIndicatorType, params: Record<string, number>): boolean {
  for (const [left, operator, right] of DEFINITION_BY_TYPE.get(type)?.constraints || []) {
    const a = params[left]
    const b = params[right]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (operator === "<" ? !(a < b) : !(a <= b)) return false
  }
  return true
}

function latinVariants(
  type: PresetIndicatorType,
  parameters: Record<string, number[]>,
  batchSize: number,
): PresetIndicatorConfiguration[] {
  const entries = Object.entries(parameters).filter(([, values]) => values.length > 0)
  let variants: PresetIndicatorConfiguration[] = [{ type, params: {} }]
  for (const [key, values] of entries) {
    variants = variants.flatMap((variant) =>
      values.map((value) => ({
        type,
        params: { ...variant.params, [key]: value },
      })),
    )
  }
  const valid = variants.filter(({ params }) => {
    const short = params.short
    const long = params.long
    if (Number.isFinite(short) && Number.isFinite(long) && short >= long) return false
    const fast = params.fast
    const slow = params.slow
    if (Number.isFinite(fast) && Number.isFinite(slow) && fast >= slow) return false
    const oversold = params.oversold
    const overbought = params.overbought
    if (Number.isFinite(oversold) && Number.isFinite(overbought) && oversold >= overbought) return false
    const acceleration = params.acceleration
    const maximum = params.maximum
    if (Number.isFinite(acceleration) && Number.isFinite(maximum) && acceleration > maximum) return false
    return satisfiesDefinitionConstraints(type, params)
  })
  const limit = Math.max(1, Math.floor(batchSize))
  if (valid.length <= limit) return valid

  // Keep the optimizer bounded without biasing every run toward the first
  // parameter values. Preserve each configured Common timeframe first when
  // the operator's limit permits it; otherwise an even Cartesian sample can
  // accidentally omit a valid 5m/15m lane despite the timeframe being enabled.
  // The remaining sample is deterministic, keeping presets reproducible while
  // honoring the per-indicator limit.
  if (limit === 1) return [valid[0]]
  const selected: PresetIndicatorConfiguration[] = []
  const selectedIndexes = new Set<number>()
  const configuredTimeframes = Array.from(new Set(
    (parameters.timeframeMinutes || [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0),
  ))
  if (configuredTimeframes.length > 0 && limit >= configuredTimeframes.length) {
    for (const timeframeMinutes of configuredTimeframes) {
      const sourceIndex = valid.findIndex(
        (variant) => Number(variant.params.timeframeMinutes) === timeframeMinutes,
      )
      if (sourceIndex < 0 || selectedIndexes.has(sourceIndex)) continue
      selectedIndexes.add(sourceIndex)
      selected.push(valid[sourceIndex])
    }
  }
  for (let index = 0; index < limit; index++) {
    if (selected.length >= limit) break
    const sourceIndex = Math.round(
      (index * (valid.length - 1)) / Math.max(1, limit - 1),
    )
    if (selectedIndexes.has(sourceIndex)) continue
    selectedIndexes.add(sourceIndex)
    selected.push(valid[sourceIndex])
  }
  // A coverage reservation can overlap the evenly-spaced indexes above. Fill
  // any resulting gap in stable Cartesian order so the exact limit still holds.
  for (let sourceIndex = 0; selected.length < limit && sourceIndex < valid.length; sourceIndex++) {
    if (selectedIndexes.has(sourceIndex)) continue
    selectedIndexes.add(sourceIndex)
    selected.push(valid[sourceIndex])
  }
  return selected
}

function indicatorRecord(commonSettings: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = commonSettings[key]
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function normalizedCommonTimeframes(commonSettings: Record<string, unknown>): number[] {
  const coordination = indicatorRecord(commonSettings, "coordination")
  const source = Array.isArray(coordination.timeframesMinutes)
    ? coordination.timeframesMinutes
    : [1, 5, 15, 30]
  const values = [...new Set(source
    .map(Number)
    .filter(Number.isFinite)
    .map((value) => Math.max(1, Math.min(60, Math.round(value)))))]
    .sort((left, right) => left - right)
  return values.length > 0 ? values : [1, 5, 15, 30]
}

export function buildCommonIndicatorConfigurations(
  commonSettings: Record<string, unknown> = {},
  settingsInput: Partial<PresetOptimizerSettings> = {},
): PresetIndicatorConfiguration[] {
  const settings = normalizePresetOptimizerSettings(settingsInput as Record<string, unknown>)
  const max = settings.maxIndicatorVariantsPerType
  const configurations: PresetIndicatorConfiguration[] = []
  const timeframes = normalizedCommonTimeframes(commonSettings)

  const add = (type: PresetIndicatorType, sourceKey: string, parameters: Record<string, number[]>) => {
    if (!settings.indicatorTypes.includes(type)) return
    const source = indicatorRecord(commonSettings, sourceKey)
    if (source.enabled === false) return
    configurations.push(...latinVariants(type, {
      ...parameters,
      timeframeMinutes: timeframes,
    }, max))
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

  const ma = indicatorRecord(commonSettings, "ma")
  add("ma", "ma", {
    short: selectRangeValues(ma.shortPeriod, { min: 3, max: 15, step: 2 }, max),
    long: selectRangeValues(ma.longPeriod, { min: 20, max: 80, step: 10 }, max),
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
    kPeriod: selectRangeValues(stochastic.kPeriod, { min: 7, max: 21, step: 2 }, max),
    dPeriod: selectRangeValues(stochastic.dPeriod, { min: 2, max: 5, step: 1 }, max),
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
  add("psar", "parabolicSAR", {
    acceleration: selectRangeValues(sar.acceleration, { min: 0.01, max: 0.03, step: 0.005 }, max),
    maximum: selectRangeValues(sar.maximum, { min: 0.1, max: 0.3, step: 0.05 }, max),
  })
  const cci = indicatorRecord(commonSettings, "cci")
  add("cci", "cci", {
    period: selectRangeValues(cci.period, { min: 10, max: 30, step: 5 }, max),
    threshold: selectRangeValues(cci.threshold, { min: 80, max: 160, step: 20 }, max),
  })

  const adl = indicatorRecord(commonSettings, "adl")
  add("adl", "adl", {
    short: selectRangeValues(adl.shortPeriod, { min: 3, max: 10, step: 1 }, max),
    long: selectRangeValues(adl.longPeriod, { min: 15, max: 40, step: 5 }, max),
  })

  const fibonacci = indicatorRecord(commonSettings, "fibonacci")
  add("fibonacci", "fibonacci", {
    lookback: selectRangeValues(fibonacci.lookback, { min: 13, max: 55, step: 7 }, max),
    tolerancePct: selectRangeValues(fibonacci.tolerancePct, { min: 0.1, max: 0.5, step: 0.1 }, max),
  })

  const roc = indicatorRecord(commonSettings, "roc")
  add("roc", "roc", {
    period: selectRangeValues(roc.period, { min: 3, max: 20, step: 1 }, max),
    thresholdPct: selectRangeValues(roc.thresholdPct, { min: 0.1, max: 1, step: 0.1 }, max),
  })

  const williams = indicatorRecord(commonSettings, "williamsR")
  add("williamsR", "williamsR", {
    period: selectRangeValues(williams.period, { min: 7, max: 21, step: 2 }, max),
    oversold: selectRangeValues(williams.oversold, { min: -90, max: -70, step: 5 }, max),
    overbought: selectRangeValues(williams.overbought, { min: -30, max: -10, step: 5 }, max),
  })

  const obv = indicatorRecord(commonSettings, "obv")
  add("obv", "obv", {
    short: selectRangeValues(obv.shortPeriod, { min: 3, max: 10, step: 1 }, max),
    long: selectRangeValues(obv.longPeriod, { min: 15, max: 40, step: 5 }, max),
  })

  const vwap = indicatorRecord(commonSettings, "vwap")
  add("vwap", "vwap", {
    period: selectRangeValues(vwap.period, { min: 5, max: 30, step: 5 }, max),
    deviationPct: selectRangeValues(vwap.deviationPct, { min: 0.1, max: 1, step: 0.1 }, max),
  })

  // The types ported from CTS-A-O use their catalogue parameter names and ranges.
  for (const definition of COMMON_INDICATOR_DEFINITIONS) {
    if (LEGACY_TYPES.has(definition.type)) continue
    const record = indicatorRecord(commonSettings, definition.storageKey)
    add(definition.type, definition.storageKey, Object.fromEntries(
      Object.entries(definition.parameters).map(([key, parameter]) => [
        key,
        selectRangeValues(record[key], {
          min: parameter.default.from,
          max: parameter.default.to,
          step: parameter.default.step,
        }, max),
      ]),
    ))
  }

  return configurations
}

type PresetSignalDirection = "long" | "short" | null

/**
 * Optimizer parameter names of the 17 original types (persisted presets keep
 * them) → the Common catalogue names the shared rules read.
 */
export function toCommonParameters(type: PresetIndicatorType, params: Record<string, number>): Record<string, number> {
  const canonical: Record<string, number> = { ...params }
  const alias = (from: string, to: string) => {
    if (Number.isFinite(params[from]) && !Number.isFinite(params[to])) canonical[to] = params[from]
  }
  switch (type) {
    case "ma":
    case "ema":
    case "sma":
    case "adl":
    case "obv":
      alias("short", "shortPeriod")
      alias("long", "longPeriod")
      alias("period", "shortPeriod")
      break
    case "macd":
      alias("fast", "fastPeriod")
      alias("slow", "slowPeriod")
      alias("signal", "signalPeriod")
      break
    case "stochastic":
      alias("period", "kPeriod")
      break
    default:
      break
  }
  return canonical
}

/**
 * Entry series of one configuration: the shared Common rule's causal state —
 * the same rule the live engine reads at the last bar. Live creates the
 * configuration's Set on every cycle while its state holds, so every bar with
 * a direction is a candidate entry here too (generatePresetSignals samples
 * them evenly over the window).
 */
function buildSignalSeries(
  candles: PresetCandle[],
  config: PresetIndicatorConfiguration,
): PresetSignalDirection[] {
  const result = new Array<PresetSignalDirection>(candles.length).fill(null)
  const rule = getCommonRule(config.type)
  if (candles.length === 0 || !rule) return result
  const context = createCommonSeriesContext(candles, { normalized: true })
  const states = commonRuleStates(context, rule, toCommonParameters(config.type, config.params), 14)
  for (let index = 0; index < states.length; index++) {
    const state = states[index]
    if (state !== 0) result[index] = state > 0 ? "long" : "short"
  }
  return result
}

/** Bars before a configuration's first possible signal (its rule's warm-up, at least 30). */
function configurationWarmup(config: PresetIndicatorConfiguration): number {
  const rule = getCommonRule(config.type)
  if (!rule) return 30
  return Math.max(30, rule.warmup(rule.resolve(toCommonParameters(config.type, config.params), 14)))
}

function resamplePresetCandles(
  candles: PresetCandle[],
  timeframeMinutesInput: number,
): { candles: PresetCandle[]; sourceIndexes: number[] } {
  const timeframeMinutes = Math.max(1, Math.min(60, Math.round(timeframeMinutesInput || 1)))
  if (candles.length < 2) {
    return { candles, sourceIndexes: candles.map((_, index) => index) }
  }
  const positiveIntervals = candles.slice(1)
    .map((candle, index) => candle.timestamp - candles[index].timestamp)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
  const baseIntervalMinutes = positiveIntervals.length > 0
    ? positiveIntervals[Math.floor(positiveIntervals.length / 2)] / 60_000
    : timeframeMinutes
  if (timeframeMinutes <= baseIntervalMinutes + 0.001) {
    return { candles, sourceIndexes: candles.map((_, index) => index) }
  }

  const bucketMs = timeframeMinutes * 60_000
  const result: PresetCandle[] = []
  const sourceIndexes: number[] = []
  let bucket = Number.NaN
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]
    const nextBucket = Math.floor(candle.timestamp / bucketMs)
    if (nextBucket !== bucket) {
      bucket = nextBucket
      // the bar carries its bucket's open time (time-anchored rules read it);
      // its entry index is the bucket's last source candle, so entries stay causal
      result.push({ ...candle, timestamp: nextBucket * bucketMs })
      sourceIndexes.push(index)
      continue
    }
    const target = result[result.length - 1]
    target.high = Math.max(target.high, candle.high)
    target.low = Math.min(target.low, candle.low)
    target.close = candle.close
    target.volume += candle.volume
    sourceIndexes[sourceIndexes.length - 1] = index
  }
  return { candles: result, sourceIndexes }
}

export function generatePresetSignals(
  candles: PresetCandle[],
  config: PresetIndicatorConfiguration,
  maximum: number,
): PresetSignalEntry[] {
  const timeframeMinutes = Math.max(1, Math.min(60, Math.round(config.params.timeframeMinutes || 1)))
  const resampled = resamplePresetCandles(candles, timeframeMinutes)
  const calculationParams = Object.fromEntries(
    Object.entries(config.params).filter(([key]) => key !== "timeframeMinutes"),
  )
  const calculationConfig = { ...config, params: calculationParams }
  const warmup = configurationWarmup(calculationConfig)
  const signalSeries = buildSignalSeries(resampled.candles, calculationConfig)
  const candidates: PresetSignalEntry[] = []
  for (let index = warmup; index < resampled.candles.length - 1; index++) {
    const direction = signalSeries[index]
    if (!direction) continue
    candidates.push({ index: resampled.sourceIndexes[index], direction })
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
    const value = netPositionCostMultiple(rawMovePct, positionCostPct)
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
      const averageR = dayCount > 0 ? scratch.dailyNetR[index] / dayCount : 0
      daily.push({
        day: index + 1,
        date: new Date(historyStart + (index + 1) * DAY_MS).toISOString().slice(0, 10),
        profitFactor: round(profitFactor, 4),
        netR: round(scratch.dailyNetR[index], 4),
        averageR: round(averageR, 4),
        positionCostRatio: round(signedResultRToMainTradePfRatio(averageR), 6),
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
  const positionCostRatio = signedResultRToMainTradePfRatio(averageR)
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
    positionCostRatio: round(positionCostRatio, 6),
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
      positionCostRatio >= settings.minProfitFactor &&
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
