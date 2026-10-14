import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  commonIndicatorParameterConfigurations,
  normalizeCommonIndicationSettings,
  type CommonIndicationSettingsDocument,
  type CommonIndicatorSettings,
  type CommonIndicatorType,
} from "@/lib/common-indicator-config"
import { summarizeCommonCategories, type CommonCategorySummary } from "@/lib/common-indicators/categories"
import { commonWarmupMinutes, commonWindowStartMs } from "@/lib/common-indicators/history"
import { getCommonRule, toCommonResult, type CommonRule, type RuleParams } from "@/lib/common-indicators/registry"
import {
  createTechnicalIndicatorEvaluationContext,
  evaluateTechnicalIndicators,
  normalizeTechnicalCandles,
  resampleNormalizedCandles,
  summarizeTechnicalIndicators,
  type TechnicalCandle,
  type TechnicalIndicatorEvaluationContext,
  type TechnicalIndicatorParameters,
  type TechnicalIndicatorResult,
} from "@/lib/technical-indicators"

/**
 * One evaluation context per (input candle array, timeframe). Auto's step
 * summaries and the exhaustive Common Set pass of the same symbol cycle read
 * the same candle array, so its series (EMAs, RSIs, ATRs, …) are computed once
 * per cycle instead of once per pass. Keyed by the array itself: the contexts
 * are collected with the array, no TTL or size bound is needed.
 */
const TIMEFRAME_CONTEXTS = new WeakMap<object, Map<number, TechnicalIndicatorEvaluationContext>>()
const NORMALIZED_INPUTS = new WeakMap<object, TechnicalCandle[]>()

const TIMEFRAME_CONTEXTS_BY_KEY = new WeakMap<object, Map<string, TechnicalIndicatorEvaluationContext>>()

export interface CompletedBucketOptions {
  /**
   * Completed one-minute data ends here (exclusive). A higher-timeframe bucket
   * that would end later is still forming and is left out, so a 5m/15m/30m
   * reading cannot change until its bucket closes.
   */
  completedThroughMs?: number
}

export function timeframeEvaluationContext(
  candles: unknown[],
  timeframeMinutes: number,
  options: CompletedBucketOptions = {},
): TechnicalIndicatorEvaluationContext {
  const completedThroughMs = Number(options.completedThroughMs)
  if (!Number.isFinite(completedThroughMs)) {
    let byTimeframe = TIMEFRAME_CONTEXTS.get(candles)
    if (!byTimeframe) {
      byTimeframe = new Map()
      TIMEFRAME_CONTEXTS.set(candles, byTimeframe)
    }
    const cached = byTimeframe.get(timeframeMinutes)
    if (cached) return cached
    const context = createTechnicalIndicatorEvaluationContext(
      resampleNormalizedCandles(normalizedInput(candles), timeframeMinutes),
      { normalized: true },
    )
    byTimeframe.set(timeframeMinutes, context)
    return context
  }
  let byKey = TIMEFRAME_CONTEXTS_BY_KEY.get(candles)
  if (!byKey) {
    byKey = new Map()
    TIMEFRAME_CONTEXTS_BY_KEY.set(candles, byKey)
  }
  const key = `${timeframeMinutes}|${completedThroughMs}`
  const cached = byKey.get(key)
  if (cached) return cached
  const resampled = resampleNormalizedCandles(normalizedInput(candles), timeframeMinutes)
  const last = resampled[resampled.length - 1]
  const bucketMs = Math.max(1, Math.round(timeframeMinutes)) * 60_000
  const completed = last && last.timestamp + bucketMs > completedThroughMs ? resampled.slice(0, -1) : resampled
  // The bar length is the configured timeframe, not inferred from (possibly
  // gapped) timestamps, so live and replay contexts agree exactly.
  const context = createTechnicalIndicatorEvaluationContext(completed, { normalized: true, tfMin: timeframeMinutes })
  byKey.set(key, context)
  return context
}

function normalizedInput(candles: unknown[]): TechnicalCandle[] {
  let normalized = NORMALIZED_INPUTS.get(candles)
  if (!normalized) {
    normalized = normalizeTechnicalCandles(candles)
    NORMALIZED_INPUTS.set(candles, normalized)
  }
  return normalized
}

/**
 * Drop the evaluation contexts of a candle array that outlives its pass (the
 * Common history view is reused for a whole minute; its series are not needed
 * once Auto and the Set pass have read them).
 */
export function releaseTimeframeContexts(candles: unknown[]): void {
  TIMEFRAME_CONTEXTS.delete(candles)
  TIMEFRAME_CONTEXTS_BY_KEY.delete(candles)
  NORMALIZED_INPUTS.delete(candles)
}

function normalizeTimeframes(timeframesMinutes: number[]): number[] {
  return [...new Set(
    timeframesMinutes
      .map(Number)
      .filter(Number.isFinite)
      .map((value) => Math.max(1, Math.min(60, Math.round(value)))),
  )].sort((left, right) => left - right)
}

function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function buildParameterVariants(
  settingsInput: CommonIndicationSettingsDocument | undefined,
  enabledTypes: readonly CommonIndicatorType[],
): Array<{ type: CommonIndicatorType; parameters: TechnicalIndicatorParameters }> {
  const settings = normalizeCommonIndicationSettings(
    settingsInput || DEFAULT_COMMON_INDICATION_SETTINGS,
  )
  const enabled = new Set(enabledTypes)
  const variants: Array<{
    type: CommonIndicatorType
    parameters: TechnicalIndicatorParameters
  }> = []
  for (const definition of COMMON_INDICATOR_DEFINITIONS) {
    if (enabled.size > 0 && !enabled.has(definition.type)) continue
    const indicator = settings[definition.storageKey] as CommonIndicatorSettings
    if (indicator?.enabled === false) continue
    for (const values of commonIndicatorParameterConfigurations(definition, indicator)) {
      variants.push({
        type: definition.type,
        parameters: { [definition.type]: values },
      })
    }
  }
  return variants
}

type PreparedVariant = {
  type: CommonIndicatorType
  rule: CommonRule
  params: RuleParams
  warmup: number
}

/** buildParameterVariants with each tuple resolved once (rule, parameters, warm-up). */
function prepareSummaryVariants(
  settings: CommonIndicationSettingsDocument | undefined,
  enabledTypes: readonly CommonIndicatorType[],
): PreparedVariant[] {
  const prepared: PreparedVariant[] = []
  for (const { type, parameters } of buildParameterVariants(settings, enabledTypes)) {
    const rule = getCommonRule(type)
    if (!rule) continue
    const params = rule.resolve(parameters[type], 14)
    prepared.push({ type, rule, params, warmup: rule.warmup(params) })
  }
  return prepared
}

export type TimeframeSummary = {
  indicators: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>>
  summary: CommonCategorySummary
  typeSummary: ReturnType<typeof summarizeTechnicalIndicators>
  ma: number
  rsi: number
  macd: { macd: number; signal: number }
  bb: { upper: number; middle: number; lower: number }
  stochastic: { k: number; d: number }
  obv: number
}

/**
 * Every tuple of the grid read at bar `k` of one timeframe context and
 * aggregated per type (the Auto summary). Reading the last bar gives exactly
 * the per-tuple evaluateTechnicalIndicators results; an earlier bar of a
 * longer context gives the same result as the context cut after `k`, because
 * every Common rule is causal.
 */
async function summarizeTimeframeAt(
  context: TechnicalIndicatorEvaluationContext,
  k: number,
  variants: readonly PreparedVariant[],
  batchSize: number,
): Promise<TimeframeSummary> {
  const byType = new Map<CommonIndicatorType, IndicatorAccumulator>()
  if (k >= 0 && k < context.length) {
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[index]
      if (k + 1 >= variant.warmup) {
        const sample = variant.rule.at(context, variant.params, k)
        if (sample) {
          let accumulator = byType.get(variant.type)
          if (!accumulator) {
            accumulator = createIndicatorAccumulator(variant.type)
            byType.set(variant.type, accumulator)
          }
          addIndicatorResult(accumulator, toCommonResult(variant.rule.type, sample) as TechnicalIndicatorResult)
        }
      }
      // Promise continuations alone do not give timers/control requests a
      // turn while the grid is CPU-bound; yield like the batch loop does.
      if (batchSize > 0 && (index + 1) % batchSize === 0 && index + 1 < variants.length) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  const indicators: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> = {}
  for (const accumulator of byType.values()) {
    indicators[accumulator.type] = finalizeIndicatorAccumulator(accumulator)
  }
  return {
    indicators,
    // Auto's vote: one vote per category (lib/common-indicators/categories.ts)
    summary: summarizeCommonCategories(indicators),
    typeSummary: summarizeTechnicalIndicators(indicators),
    ...compatibilityValues(indicators),
  }
}

function aggregateIndicatorVariants(
  variants: Array<ReturnType<typeof evaluateTechnicalIndicators>>,
  enabledTypes: readonly CommonIndicatorType[],
): Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> {
  const output: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> = {}
  for (const type of enabledTypes) {
    const values = variants
      .map((variant) => variant[type])
      .filter((value): value is TechnicalIndicatorResult => Boolean(value))
    if (values.length === 0) continue
    const long = values.filter((value) => value.direction === "long")
    const short = values.filter((value) => value.direction === "short")
    const finalDirection = long.length === short.length
      ? "neutral"
      : long.length > short.length
        ? "long"
        : "short"
    const directionalValues = finalDirection === "long"
      ? long
      : finalDirection === "short"
        ? short
        : values
    const detailKeys = [...new Set(values.flatMap((value) => Object.keys(value.details)))]
    output[type] = {
      type,
      direction: finalDirection,
      strength: round(
        directionalValues.reduce((sum, value) => sum + value.strength, 0) /
          Math.max(1, directionalValues.length),
      ),
      value: round(values.reduce((sum, value) => sum + value.value, 0) / values.length),
      signal: round(values.reduce((sum, value) => sum + value.signal, 0) / values.length),
      details: Object.fromEntries(detailKeys.map((key) => [
        key,
        round(values.reduce((sum, value) => sum + (Number(value.details[key]) || 0), 0) / values.length),
      ])),
    }
  }
  return output
}

export type StepBasedIndicatorConfiguration = {
  type: CommonIndicatorType
  parameters: TechnicalIndicatorParameters
  indicators: ReturnType<typeof evaluateTechnicalIndicators>
  summary: ReturnType<typeof summarizeTechnicalIndicators>
}

type IndicatorAccumulator = {
  type: CommonIndicatorType
  count: number
  longCount: number
  shortCount: number
  neutralCount: number
  longStrength: number
  shortStrength: number
  value: number
  signal: number
  detailOrder: string[]
  detailSums: Record<string, number>
}

function createIndicatorAccumulator(type: CommonIndicatorType): IndicatorAccumulator {
  return {
    type,
    count: 0,
    longCount: 0,
    shortCount: 0,
    neutralCount: 0,
    longStrength: 0,
    shortStrength: 0,
    value: 0,
    signal: 0,
    detailOrder: [],
    detailSums: Object.create(null) as Record<string, number>,
  }
}

function addIndicatorResult(
  accumulator: IndicatorAccumulator,
  value: TechnicalIndicatorResult,
): void {
  accumulator.count += 1
  if (value.direction === "long") {
    accumulator.longCount += 1
    accumulator.longStrength += value.strength
  } else if (value.direction === "short") {
    accumulator.shortCount += 1
    accumulator.shortStrength += value.strength
  } else {
    accumulator.neutralCount += 1
  }
  accumulator.value += value.value
  accumulator.signal += value.signal
  for (const key of Object.keys(value.details || {})) {
    if (!Object.prototype.hasOwnProperty.call(accumulator.detailSums, key)) {
      accumulator.detailOrder.push(key)
      accumulator.detailSums[key] = 0
    }
    // This deliberately counts a missing detail as zero. That is the same
    // denominator used by the historic aggregateIndicatorVariants path.
    accumulator.detailSums[key] += Number(value.details[key]) || 0
  }
}

function finalizeIndicatorAccumulator(
  accumulator: IndicatorAccumulator,
): TechnicalIndicatorResult {
  const direction = accumulator.longCount === accumulator.shortCount
    ? "neutral"
    : accumulator.longCount > accumulator.shortCount
      ? "long"
      : "short"
  const directionalCount = direction === "long"
    ? accumulator.longCount
    : direction === "short"
      ? accumulator.shortCount
      : accumulator.count
  const directionalStrength = direction === "long"
    ? accumulator.longStrength
    : direction === "short"
      ? accumulator.shortStrength
      : 0
  return {
    type: accumulator.type,
    direction,
    strength: round(directionalStrength / Math.max(1, directionalCount)),
    value: round(accumulator.value / Math.max(1, accumulator.count)),
    signal: round(accumulator.signal / Math.max(1, accumulator.count)),
    details: Object.fromEntries(accumulator.detailOrder.map((key) => [
      key,
      round(accumulator.detailSums[key] / Math.max(1, accumulator.count)),
    ])),
  }
}

function compatibilityValues(
  indicators: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>>,
) {
  const macd = indicators.macd
  const bollinger = indicators.bollinger
  const stochastic = indicators.stochastic
  return {
    ma: indicators.ma?.details.simple ?? indicators.sma?.value ?? 0,
    rsi: indicators.rsi?.value ?? 50,
    macd: {
      macd: macd?.value ?? 0,
      signal: macd?.details.signalLine ?? 0,
    },
    bb: {
      upper: bollinger?.details.upper ?? 0,
      middle: bollinger?.details.middle ?? 0,
      lower: bollinger?.details.lower ?? 0,
    },
    stochastic: {
      k: stochastic?.details.k ?? 50,
      d: stochastic?.details.d ?? 50,
    },
    obv: indicators.obv?.value ?? 0,
  }
}

/**
 * Common technical indicator calculator used by the Main engine.
 *
 * Each key is an actual configured candle timeframe. Indicator periods
 * and thresholds come from Common Settings; they are not confused with the
 * independent Direction/Move/Active sample ranges or Trend's 1/5/15/30
 * situation windows.
 */
export class StepBasedIndicators {
  /**
   * Exhaustive Common-indicator evaluation without retaining the Cartesian
   * result graph. Every configuration is still evaluated exactly once; the
   * caller receives bounded batches and may persist/consume them before the
   * next batch is calculated. This is the production path for Row-Real and
   * keeps the full matrix from multiplying by the active symbol count.
   */
  static async forEachConfigurationAsync(
    candles: unknown[],
    timeframesMinutes: number[] = [1, 5, 15, 30],
    enabledTypes: readonly CommonIndicatorType[] = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.enabled)
      .map((definition) => definition.type),
    settings: CommonIndicationSettingsDocument | undefined,
    onBatch: (configurations: StepBasedIndicatorConfiguration[], timeframeMinutes: number) => Promise<void>,
    batchSize = 32,
    options: CompletedBucketOptions = {},
  ): Promise<{ configurations: number; timeframes: number[] }> {
    const parameterVariants = buildParameterVariants(settings, enabledTypes)
    const normalizedTimeframes = [...new Set(
      timeframesMinutes
        .map(Number)
        .filter(Number.isFinite)
        .map((value) => Math.max(1, Math.min(60, Math.round(value)))),
    )].sort((left, right) => left - right)
    const boundedBatchSize = Math.max(1, Math.min(256, Math.floor(batchSize) || 32))
    let configurationCount = 0

    for (const timeframeMinutes of normalizedTimeframes) {
      const evaluationContext = timeframeEvaluationContext(candles, timeframeMinutes, options)
      const resampled = evaluationContext.candles
      for (let start = 0; start < parameterVariants.length; start += boundedBatchSize) {
        const batch = parameterVariants.slice(start, start + boundedBatchSize).map(({ type, parameters }) => {
          const indicators = evaluateTechnicalIndicators(
            resampled,
            14,
            [type],
            parameters,
            evaluationContext,
          )
          return {
            type,
            parameters,
            indicators,
            summary: summarizeTechnicalIndicators(indicators),
          }
        })
        configurationCount += batch.length
        await onBatch(batch, timeframeMinutes)
        // Promise continuations alone do not give timers/control requests a
        // turn when a batch callback is CPU-heavy. The explicit timer yield is
        // deliberately after the callback so persistence and calculation stay
        // ordered while the HTTP server remains schedulable.
        if (start + boundedBatchSize < parameterVariants.length) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }

    return { configurations: configurationCount, timeframes: normalizedTimeframes }
  }

  /**
   * Exhaustively evaluate the Common matrix while retaining only one
   * aggregate result per indicator type and timeframe. This has the exact
   * direction/strength/value/detail semantics of calculateAllAsync, but does
   * not retain every configuration's indicator object until the cycle ends.
   * Row-Real uses this summary for Auto alignment; the exact Set processor
   * remains responsible for persisting every qualified configuration.
   */
  static async calculateSummariesAsync(
    candles: unknown[],
    timeframesMinutes: number[] = [1, 5, 15, 30],
    enabledTypes: readonly CommonIndicatorType[] = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.enabled)
      .map((definition) => definition.type),
    settings?: CommonIndicationSettingsDocument,
    batchSize = 32,
    options: CompletedBucketOptions = {},
  ): Promise<Record<string, TimeframeSummary>> {
    const results: Record<string, TimeframeSummary> = {}
    const variants = prepareSummaryVariants(settings, enabledTypes)
    if (variants.length === 0) return results
    const boundedBatchSize = Math.max(1, Math.min(256, Math.floor(batchSize) || 32))
    for (const timeframeMinutes of normalizeTimeframes(timeframesMinutes)) {
      const context = timeframeEvaluationContext(candles, timeframeMinutes, options)
      results[String(timeframeMinutes)] = await summarizeTimeframeAt(
        context,
        context.length - 1,
        variants,
        boundedBatchSize,
      )
    }
    return results
  }

  /**
   * Auto summaries for every bar of a replay, computed once per anchor hour
   * instead of once per bar. `bars` are completed one-minute bars, oldest
   * first. `at(i)` equals calculateSummariesAsync over the anchored Common
   * window ending at bars[i] (commonWindowSlice) with completedThroughMs =
   * bars[i] close: the decisions of one anchor hour read prefixes of one
   * series, and the Common rules are causal. Calls must move forward in time
   * (one group is kept).
   */
  static createSummarySeries(
    bars: readonly TechnicalCandle[],
    timeframesMinutes: number[] = [1, 5, 15, 30],
    enabledTypes: readonly CommonIndicatorType[] = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.enabled)
      .map((definition) => definition.type),
    settings?: CommonIndicationSettingsDocument,
    batchSize = 256,
  ): { at(index: number): Promise<Record<string, TimeframeSummary>> } {
    const variants = prepareSummaryVariants(settings, enabledTypes)
    const timeframes = normalizeTimeframes(timeframesMinutes)
    const boundedBatchSize = Math.max(0, Math.min(4096, Math.floor(batchSize) || 0))
    let group: {
      windowStartMs: number
      contexts: Map<number, TechnicalIndicatorEvaluationContext>
      summaries: Map<string, TimeframeSummary>
    } | null = null
    const lowerBound = (values: readonly TechnicalCandle[], timestampMs: number) => {
      let low = 0
      let high = values.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (values[middle].timestamp < timestampMs) low = middle + 1
        else high = middle
      }
      return low
    }
    return {
      async at(index: number) {
        const results: Record<string, TimeframeSummary> = {}
        const bar = bars[index]
        if (!bar || variants.length === 0) return results
        const windowStartMs = commonWindowStartMs(bar.timestamp)
        if (!group || group.windowStartMs !== windowStartMs) {
          // Every decision of this anchor hour reads a prefix of these bars.
          const first = lowerBound(bars, windowStartMs)
          const end = lowerBound(bars, windowStartMs + commonWarmupMinutes() * 60_000)
          const normalized = normalizeTechnicalCandles(bars.slice(first, end) as unknown[])
          const contexts = new Map<number, TechnicalIndicatorEvaluationContext>()
          for (const timeframeMinutes of timeframes) {
            contexts.set(
              timeframeMinutes,
              createTechnicalIndicatorEvaluationContext(
                resampleNormalizedCandles(normalized, timeframeMinutes),
                { normalized: true, tfMin: timeframeMinutes },
              ),
            )
          }
          group = { windowStartMs, contexts, summaries: new Map() }
        }
        const completedThroughMs = bar.timestamp + 60_000
        for (const timeframeMinutes of timeframes) {
          const context = group.contexts.get(timeframeMinutes)!
          // the last bucket that is complete when this bar closes
          const k = lowerBound(context.candles, completedThroughMs - timeframeMinutes * 60_000 + 1) - 1
          const cacheKey = `${timeframeMinutes}:${k}`
          let summary = group.summaries.get(cacheKey)
          if (!summary) {
            summary = await summarizeTimeframeAt(context, k, variants, boundedBatchSize)
            group.summaries.set(cacheKey, summary)
          }
          results[String(timeframeMinutes)] = summary
        }
        return results
      },
    }
  }

  /**
   * Exhaustive asynchronous Common-indicator evaluation.
   *
   * Every timeframe × indicator × complete parameter tuple is evaluated.
   * `batchSize` controls event-loop yielding only; it is never used to slice,
   * rank, sample, or cap the configuration space.
   */
  static async calculateAllAsync(
    candles: unknown[],
    timeframesMinutes: number[] = [1, 5, 15, 30],
    enabledTypes: readonly CommonIndicatorType[] = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.enabled)
      .map((definition) => definition.type),
    settings?: CommonIndicationSettingsDocument,
    batchSize = 32,
  ) {
    const results: ReturnType<typeof StepBasedIndicators.calculateAll> = {}
    const parameterVariants = buildParameterVariants(settings, enabledTypes)
    const normalizedTimeframes = [...new Set(
      timeframesMinutes
        .map(Number)
        .filter(Number.isFinite)
        .map((value) => Math.max(1, Math.min(60, Math.round(value)))),
    )].sort((left, right) => left - right)
    const boundedBatchSize = Math.max(1, Math.min(256, Math.floor(batchSize) || 32))

    for (const timeframeMinutes of normalizedTimeframes) {
      const evaluationContext = timeframeEvaluationContext(candles, timeframeMinutes)
      const resampled = evaluationContext.candles
      const configurations: Array<{
        type: CommonIndicatorType
        parameters: TechnicalIndicatorParameters
        indicators: ReturnType<typeof evaluateTechnicalIndicators>
        summary: ReturnType<typeof summarizeTechnicalIndicators>
      }> = []

      for (let start = 0; start < parameterVariants.length; start += boundedBatchSize) {
        const batch = parameterVariants.slice(start, start + boundedBatchSize)
        configurations.push(...batch.map(({ type, parameters }) => {
          const indicators = evaluateTechnicalIndicators(
            resampled,
            14,
            [type],
            parameters,
            evaluationContext,
          )
          return {
            type,
            parameters,
            indicators,
            summary: summarizeTechnicalIndicators(indicators),
          }
        }))
        if (start + boundedBatchSize < parameterVariants.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      const indicators = aggregateIndicatorVariants(
        configurations.map((configuration) => configuration.indicators),
        enabledTypes,
      )
      results[String(timeframeMinutes)] = {
        indicators,
        // Auto's vote: one vote per category (lib/common-indicators/categories.ts)
        summary: summarizeCommonCategories(indicators),
        typeSummary: summarizeTechnicalIndicators(indicators),
        configurations,
        ...compatibilityValues(indicators),
      }
    }
    return results
  }

  static calculateAll(
    candles: unknown[],
    timeframesMinutes: number[] = [1, 5, 15, 30],
    enabledTypes: readonly CommonIndicatorType[] = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.enabled)
      .map((definition) => definition.type),
    settings?: CommonIndicationSettingsDocument,
  ) {
    const results: Record<string, {
      indicators: ReturnType<typeof evaluateTechnicalIndicators>
      summary: CommonCategorySummary
      typeSummary: ReturnType<typeof summarizeTechnicalIndicators>
      configurations: Array<{
        type: CommonIndicatorType
        parameters: TechnicalIndicatorParameters
        indicators: ReturnType<typeof evaluateTechnicalIndicators>
        summary: ReturnType<typeof summarizeTechnicalIndicators>
      }>
      // Compatibility values consumed by older engine/dashboard code.
      ma: number
      rsi: number
      macd: { macd: number; signal: number }
      bb: { upper: number; middle: number; lower: number }
      stochastic: { k: number; d: number }
      obv: number
    }> = {}

    const parameterVariants = buildParameterVariants(settings, enabledTypes)
    const normalizedTimeframes = [...new Set(
      timeframesMinutes
        .map(Number)
        .filter(Number.isFinite)
        .map((value) => Math.max(1, Math.min(60, Math.round(value)))),
    )].sort((left, right) => left - right)

    for (const timeframeMinutes of normalizedTimeframes) {
      const evaluationContext = timeframeEvaluationContext(candles, timeframeMinutes)
      const resampled = evaluationContext.candles
      const configurations = parameterVariants.map(({ type, parameters }) => {
        const indicators = evaluateTechnicalIndicators(
          resampled,
          14,
          [type],
          parameters,
          evaluationContext,
        )
        return {
          type,
          parameters,
          indicators,
          summary: summarizeTechnicalIndicators(indicators),
        }
      })
      const indicators = aggregateIndicatorVariants(
        configurations.map((configuration) => configuration.indicators),
        enabledTypes,
      )
      results[String(timeframeMinutes)] = {
        indicators,
        // Auto's vote: one vote per category (lib/common-indicators/categories.ts)
        summary: summarizeCommonCategories(indicators),
        typeSummary: summarizeTechnicalIndicators(indicators),
        configurations,
        ...compatibilityValues(indicators),
      }
    }
    return results
  }
}
