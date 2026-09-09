/**
 * Advanced Configuration Schema for High-Frequency Trading Engine
 * 
 * Defines all parameter ranges, defaults, and configuration sets for:
 * - Prehistoric data loading
 * - Indication generation and evaluation
 * - Strategy pseudo positions
 * - Real position execution
 * - Live exchange trading
 */
import { createHash } from "node:crypto"
import {
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  MAIN_TRADE_PF_RATIO_MAX,
  MAIN_TRADE_PF_RATIO_MIN,
  MAIN_TRADE_PF_RATIO_STEP,
} from "@/lib/main-trade-profit-factor"

export interface PrehistoricDataConfig {
  timeframeSeconds: number // Load timeframe in seconds (default: 1)
  candlesPerSymbol: number // Standard DB length (default: 250)
  thresholdRearrange: number // Rearrange at 80% of max length
}

export interface IndicationParameterRanges {
  steps: { min: number; max: number; default: number; step: number }
  drawdownRatio: { min: number; max: number; default: number; step: number }
  marketActivity: { min: number; max: number; default: number; step: number }
  rangeRatio: { min: number; max: number; default: number; step: number }
  activityRatio: { min: number; max: number; default: number; step: number }
  marketDistanceRatio: { min: number; max: number; default: number; step: number }
}

export interface IndicationEvaluationConfig {
  // Timeout for indications with state "Evaluated"
  timeoutSeconds: { min: number; max: number; default: number; step: number }
  // Max concurrent positions per direction (long/short)
  maxPositionsPerDirection: { min: number; max: number; default: number; step: number }
}

export interface PseudoPositionConfig {
  // Timeout for pseudo positions
  timeoutSeconds: { min: number; max: number; default: number; step: number }
  // TakeProfit ranges (fresh-install minimum: 5)
  takeProfitSteps: { min: number; max: number; default: number; step: number }
  // StopLoss ratios
  stopLossRatio: { min: number; max: number; default: number; step: number }
  // Trailing start (ratio from TP: 0.2-1.0)
  trailingStart: { min: number; max: number; default: number; step: number }
  // Trailing stop (ratio from highest: 0.1-0.5)
  trailingStop: { min: number; max: number; default: number; step: number }
  // Database configuration
  databaseLength: number // Standard: 250
  thresholdRearrange: number // Rearrange at 80% of max
}

export interface StrategyEvaluationConfig {
  // Main strategy: selectable PositionCost-relative PF ratio (1.02-2.30, default: 1.10; 1.00 remains calculation-neutral)
  mainMinProfitFactor: { min: number; max: number; default: number; step: number }
  // Real strategy: PositionCost-relative PF ratio (default: 1.10)
  realMinProfitFactor: number
  // Real strategy: max drawdown time (12 hours)
  realMaxDrawdownTimeSeconds: number
  // Position counts to evaluate
  positionCountsToEvaluate: number[] // [1,2,3,4,5,6,8,10,12,15,20,30]
  // Recent position counts (PositionCost-relative min PF ratio: 1.10)
  recentPositionCounts: number[] // [1,2,3,4]
  recentPositionMinProfitFactor: number
  // Configuration variations (1-6 independent sets)
  pseudoPositionConfigurations: number[] // [1,2,3,4,5,6]
}

export interface AdvancedEngineConfig {
  prehistoric: PrehistoricDataConfig
  indicationParameters: IndicationParameterRanges
  indicationEvaluation: IndicationEvaluationConfig
  pseudoPosition: PseudoPositionConfig
  strategyEvaluation: StrategyEvaluationConfig
}

/**
 * Default advanced configuration matching system requirements
 */
export const DEFAULT_ADVANCED_CONFIG: AdvancedEngineConfig = {
  prehistoric: {
    timeframeSeconds: 1,
    candlesPerSymbol: 250,
    thresholdRearrange: 200, // 80% of 250
  },

  indicationParameters: {
    steps: { min: 2, max: 30, default: 15, step: 1 },
    drawdownRatio: { min: 0.1, max: 0.5, default: 0.3, step: 0.1 },
    marketActivity: { min: 0.01, max: 0.1, default: 0.05, step: 0.01 },
    rangeRatio: { min: 0.1, max: 0.4, default: 0.25, step: 0.1 },
    activityRatio: { min: 0.7, max: 1.7, default: 1.2, step: 0.1 },
    marketDistanceRatio: { min: 0.7, max: 1.7, default: 1.0, step: 0.1 },
  },

  indicationEvaluation: {
    // Default/Additional indication lanes recalculate independently after
    // their configured cadence. Common lanes default to a separate 1-second contract.
    timeoutSeconds: { min: 0.25, max: 0.25, default: 0.25, step: 0.25 },
    // One active Base pseudo position per exact
    // symbol+type+name+config+direction identity.
    maxPositionsPerDirection: { min: 1, max: 1, default: 1, step: 1 },
  },

  pseudoPosition: {
    timeoutSeconds: { min: 1, max: 1, default: 1, step: 1 },
    takeProfitSteps: { min: 5, max: 20, default: 5, step: 1 },
    stopLossRatio: { min: 0.25, max: 2.5, default: 0.5, step: 0.25 },
    trailingStart: { min: 0.2, max: 1.0, default: 0.5, step: 0.2 },
    trailingStop: { min: 0.1, max: 0.5, default: 0.2, step: 0.1 },
    databaseLength: 250,
    thresholdRearrange: 200,
  },

  strategyEvaluation: {
    mainMinProfitFactor: {
      min: MAIN_TRADE_PF_RATIO_MIN,
      max: MAIN_TRADE_PF_RATIO_MAX,
      default: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
      step: MAIN_TRADE_PF_RATIO_STEP,
    },
    realMinProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
    realMaxDrawdownTimeSeconds: 43200, // 12 hours
    positionCountsToEvaluate: Array.from({ length: 30 }, (_, index) => index + 1),
    recentPositionCounts: [1, 2, 3, 4],
    recentPositionMinProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
    pseudoPositionConfigurations: [1, 2, 3, 4, 5, 6],
  },
}

/**
 * Generate all possible configuration combinations for indication sets
 * Each combination creates an independent DB set for optimal performance
 */
export function generateIndicationConfigurationSets(
  config: AdvancedEngineConfig
): Array<{
  id: string
  indicationType: "direction" | "move" | "active" | "optimal" | "auto" | "signal" | "trend"
  parameters: Record<string, number>
}> {
  const sets: Array<{
    id: string
    indicationType: "direction" | "move" | "active" | "optimal" | "auto" | "signal" | "trend"
    parameters: Record<string, number>
  }> = []

  const indicationTypes: ("direction" | "move" | "active" | "optimal" | "auto" | "signal" | "trend")[] = [
    "direction",
    "move",
    "active",
    "optimal",
    "auto",
    "signal",
    "trend",
  ]

  for (const type of indicationTypes) {
    // For "active" type, use subset of parameters
    if (type === "active") {
      // Active: steps, drawdown, activity, activity ratios
      const combos = generateParameterCombinations(config, ["steps", "drawdownRatio", "marketActivity", "activityRatio"])
      for (const params of combos) {
        sets.push({
          id: `indication_${type}_${generateParamHash(params)}`,
          indicationType: type,
          parameters: params,
        })
      }
    } else {
      // All other types: all 6 parameters
      const combos = generateParameterCombinations(config, [
        "steps",
        "drawdownRatio",
        "marketActivity",
        "rangeRatio",
        "activityRatio",
        "marketDistanceRatio",
      ])
      for (const params of combos) {
        sets.push({
          id: `indication_${type}_${generateParamHash(params)}`,
          indicationType: type,
          parameters: params,
        })
      }
    }
  }

  return sets
}

/**
 * Generate strategy pseudo position configuration sets
 */
export function generateStrategyConfigurationSets(
  config: AdvancedEngineConfig
): Array<{
  id: string
  configurationId: number
  positionCount: number
  parameters: Record<string, number>
  databaseLength: number
}> {
  const sets: Array<{
    id: string
    configurationId: number
    positionCount: number
    parameters: Record<string, number>
    databaseLength: number
  }> = []

  // For each pseudo position configuration (1-6)
  for (const configId of config.strategyEvaluation.pseudoPositionConfigurations) {
    // For each position count to evaluate
    for (const posCount of config.strategyEvaluation.positionCountsToEvaluate) {
      // Generate all TP/SL combinations
      const combos = generateParameterCombinations(config, [
        "takeProfitSteps",
        "stopLossRatio",
        "trailingStart",
        "trailingStop",
      ])

      for (const params of combos) {
        sets.push({
          id: `strategy_config${configId}_pos${posCount}_${generateParamHash(params)}`,
          configurationId: configId,
          positionCount: posCount,
          parameters: params,
          databaseLength: config.pseudoPosition.databaseLength,
        })
      }
    }
  }

  return sets
}

/**
 * Generate the full Cartesian product of every configured inclusive range.
 *
 * There is deliberately no candidate cap or representative-value sampling
 * here. Runtime callers may process the returned rows in bounded asynchronous
 * batches, but batching must never change which configurations exist.
 */
function generateParameterCombinations(
  config: AdvancedEngineConfig,
  paramTypes: string[]
): Array<Record<string, number>> {
  const definitions: Record<string, { min: number; max: number; default: number; step: number }> = {
    steps: config.indicationParameters.steps,
    drawdownRatio: config.indicationParameters.drawdownRatio,
    marketActivity: config.indicationParameters.marketActivity,
    rangeRatio: config.indicationParameters.rangeRatio,
    activityRatio: config.indicationParameters.activityRatio,
    marketDistanceRatio: config.indicationParameters.marketDistanceRatio,
    takeProfitSteps: config.pseudoPosition.takeProfitSteps,
    stopLossRatio: config.pseudoPosition.stopLossRatio,
    trailingStart: config.pseudoPosition.trailingStart,
    trailingStop: config.pseudoPosition.trailingStop,
  }

  const valuesFor = (name: string): number[] => {
    const definition = definitions[name]
    if (!definition) return [0]
    const min = Number(definition.min)
    const max = Number(definition.max)
    const step = Math.abs(Number(definition.step))
    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      !Number.isFinite(step) ||
      step === 0 ||
      max < min
    ) {
      return [Number(definition.default) || 0]
    }
    const precision = Math.max(
      0,
      String(step).split(".")[1]?.length || 0,
      String(min).split(".")[1]?.length || 0,
      String(max).split(".")[1]?.length || 0,
    )
    const scale = 10 ** Math.min(precision, 8)
    const start = Math.round(min * scale)
    const end = Math.round(max * scale)
    const increment = Math.max(1, Math.round(step * scale))
    const values: number[] = []
    for (let value = start; value <= end; value += increment) {
      values.push(value / scale)
    }
    if (values.at(-1) !== end / scale) values.push(end / scale)
    return values
  }

  let combinations: Array<Record<string, number>> = [{}]
  for (const param of paramTypes) {
    const next: Array<Record<string, number>> = []
    for (const combination of combinations) {
      for (const value of valuesFor(param)) {
        next.push({ ...combination, [param]: value })
      }
    }
    combinations = next
  }
  return combinations
}

/**
 * Generate simple hash for parameter set identification
 */
function generateParamHash(params: Record<string, number>): string {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}:${params[k].toFixed(2)}`)
    .join("|")
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16)
}

/**
 * Get indication configuration for a specific type
 */
export function getIndicationConfigForType(
  type: "direction" | "move" | "active" | "optimal" | "auto" | "signal" | "trend",
  config: AdvancedEngineConfig
): Record<string, { min: number; max: number; default: number; step: number }> {
  if (type === "active") {
    return {
      steps: config.indicationParameters.steps,
      drawdownRatio: config.indicationParameters.drawdownRatio,
      marketActivity: config.indicationParameters.marketActivity,
      activityRatio: config.indicationParameters.activityRatio,
    }
  }

  // All other types use all 6 parameters
  return {
    steps: config.indicationParameters.steps,
    drawdownRatio: config.indicationParameters.drawdownRatio,
    marketActivity: config.indicationParameters.marketActivity,
    rangeRatio: config.indicationParameters.rangeRatio,
    activityRatio: config.indicationParameters.activityRatio,
    marketDistanceRatio: config.indicationParameters.marketDistanceRatio,
  }
}
