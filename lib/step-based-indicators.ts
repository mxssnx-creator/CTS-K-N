import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  commonIndicatorParameterConfigurations,
  normalizeCommonIndicationSettings,
  type CommonIndicationSettingsDocument,
  type CommonIndicatorSettings,
  type CommonIndicatorType,
} from "@/lib/common-indicator-config"
import {
  evaluateTechnicalIndicators,
  resampleTechnicalCandles,
  summarizeTechnicalIndicators,
  type TechnicalIndicatorParameters,
  type TechnicalIndicatorResult,
} from "@/lib/technical-indicators"

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
      const resampled = resampleTechnicalCandles(candles, timeframeMinutes)
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
      const macd = indicators.macd
      const bollinger = indicators.bollinger
      const stochastic = indicators.stochastic
      results[String(timeframeMinutes)] = {
        indicators,
        summary: summarizeTechnicalIndicators(indicators),
        configurations,
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
      summary: ReturnType<typeof summarizeTechnicalIndicators>
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
      const resampled = resampleTechnicalCandles(candles, timeframeMinutes)
      const configurations = parameterVariants.map(({ type, parameters }) => {
        const indicators = evaluateTechnicalIndicators(
          resampled,
          14,
          [type],
          parameters,
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
      const macd = indicators.macd
      const bollinger = indicators.bollinger
      const stochastic = indicators.stochastic
      results[String(timeframeMinutes)] = {
        indicators,
        summary: summarizeTechnicalIndicators(indicators),
        configurations,
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
    return results
  }
}
