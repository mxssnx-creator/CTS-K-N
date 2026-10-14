import {
  COMMON_INDICATOR_TYPES,
  type CommonIndicatorType,
} from "@/lib/common-indicator-config"
import {
  CommonSeriesContext,
  createCommonSeriesContext,
} from "@/lib/common-indicators/context"
import { round } from "@/lib/common-indicators/kn-math"
import { evaluateCommonRule, getCommonRule } from "@/lib/common-indicators/registry"
import type { TechnicalDirection } from "@/lib/common-indicators/types"

export type { TechnicalCandle, TechnicalDirection } from "@/lib/common-indicators/types"
export {
  atr,
  ema,
  normalizeTechnicalCandles,
  onBalanceVolume,
  resampleNormalizedCandles,
  resampleTechnicalCandles,
  rsi,
  sma,
} from "@/lib/common-indicators/kn-math"

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
 * and rebuilding the same series for every threshold tuple made the engine
 * monopolise the HTTP event loop. The context is deliberately scoped to one
 * immutable resampled array, so it has no cross-tick staleness risk and
 * becomes collectible as soon as that timeframe finishes.
 */
export type TechnicalIndicatorEvaluationContext = CommonSeriesContext

export function createTechnicalIndicatorEvaluationContext(
  rawCandles: unknown[],
  options: { normalized?: boolean; tfMin?: number } = {},
): TechnicalIndicatorEvaluationContext {
  return createCommonSeriesContext(rawCandles, options)
}

/**
 * Evaluate the canonical Common indicators for one already-resampled candle
 * stream at its last bar. `periodInput` is only the fallback lookback of the
 * original types; each indicator's configured period/threshold range remains
 * independent. Every type is one rule of the shared registry
 * (lib/common-indicators/registry.ts), which the Preset optimizer and the
 * preset runtime evaluate per bar, so all engines read the same definition.
 * Common callers use actual configured candle timeframes, never Default
 * Direction/Move/Active sample ranges or Trend's independent situation
 * coordination.
 */
export function evaluateTechnicalIndicators(
  rawCandles: unknown[],
  periodInput: number,
  enabledTypes?: readonly CommonIndicatorType[],
  parametersByType?: TechnicalIndicatorParameters,
  evaluationContext?: TechnicalIndicatorEvaluationContext,
): Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> {
  const context = evaluationContext || createTechnicalIndicatorEvaluationContext(rawCandles)
  if (context.length === 0) return {}
  const output: Partial<Record<CommonIndicatorType, TechnicalIndicatorResult>> = {}
  // Results keep the catalogue order whatever order the caller listed them in.
  const types: readonly CommonIndicatorType[] = !enabledTypes || enabledTypes.length === 0
    ? COMMON_INDICATOR_TYPES
    : enabledTypes.length === 1
      ? enabledTypes
      : COMMON_INDICATOR_TYPES.filter((type) => enabledTypes.includes(type))
  for (const type of types) {
    const rule = getCommonRule(type)
    if (!rule) continue
    const result = evaluateCommonRule(context, rule, parametersByType?.[type], periodInput)
    if (result) output[type] = result as TechnicalIndicatorResult
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
  const values = Object.values(indicators) as TechnicalIndicatorResult[]
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
