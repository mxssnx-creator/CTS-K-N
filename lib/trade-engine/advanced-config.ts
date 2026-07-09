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
  // TakeProfit ranges (step count: 2-20)
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
  // Main strategy: min profit factor (0.1-3.0, default: 0.5)
  mainMinProfitFactor: { min: number; max: number; default: number; step: number }
  // Real strategy: min profit factor (default: 0.7)
  realMinProfitFactor: number
  // Real strategy: max drawdown time (12 hours)
  realMaxDrawdownTimeSeconds: number
  // Position counts to evaluate
  positionCountsToEvaluate: number[] // [1,2,3,4,5,6,8,10,12,15,20,30]
  // Recent position counts (min PF: 0.6)
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
    timeoutSeconds: { min: 0, max: 5, default: 1, step: 0.2 },
    maxPositionsPerDirection: { min: 1, max: 8, default: 1, step: 1 },
  },

  pseudoPosition: {
    timeoutSeconds: { min: 0, max: 5, default: 1, step: 0.2 },
    takeProfitSteps: { min: 2, max: 20, default: 5, step: 1 },
    stopLossRatio: { min: 0.25, max: 2.5, default: 0.5, step: 0.25 },
    trailingStart: { min: 0.2, max: 1.0, default: 0.5, step: 0.2 },
    trailingStop: { min: 0.1, max: 0.5, default: 0.2, step: 0.1 },
    databaseLength: 250,
    thresholdRearrange: 200,
  },

  strategyEvaluation: {
    mainMinProfitFactor: { min: 0.1, max: 3.0, default: 0.5, step: 0.1 },
    realMinProfitFactor: 0.7,
    realMaxDrawdownTimeSeconds: 43200, // 12 hours
    positionCountsToEvaluate: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30],
    recentPositionCounts: [1, 2, 3, 4],
    recentPositionMinProfitFactor: 0.6,
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
  indicationType: "direction" | "move" | "active" | "optimal" | "auto"
  parameters: Record<string, number>
}> {
  const sets: Array<{
    id: string
    indicationType: "direction" | "move" | "active" | "optimal" | "auto"
    parameters: Record<string, number>
  }> = []

  const indicationTypes: ("direction" | "move" | "active" | "optimal" | "auto")[] = [
    "direction",
    "move",
    "active",
    "optimal",
    "auto",
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
 * Helper: Generate parameter combinations (for now, return single default set per type)
 * In production, this would generate all valid combinations for comprehensive coverage
 */
function generateParameterCombinations(
  config: AdvancedEngineConfig,
  paramTypes: string[]
): Array<Record<string, number>> {
  // For high-frequency performance, use default values only
  // Extended variations can be added to HOT_CONFIGS for A/B testing
  const defaults: Record<string, number> = {
    steps: config.indicationParameters.steps.default,
    drawdownRatio: config.indicationParameters.drawdownRatio.default,
    marketActivity: config.indicationParameters.marketActivity.default,
    rangeRatio: config.indicationParameters.rangeRatio.default,
    activityRatio: config.indicationParameters.activityRatio.default,
    marketDistanceRatio: config.indicationParameters.marketDistanceRatio.default,
    takeProfitSteps: config.pseudoPosition.takeProfitSteps.default,
    stopLossRatio: config.pseudoPosition.stopLossRatio.default,
    trailingStart: config.pseudoPosition.trailingStart.default,
    trailingStop: config.pseudoPosition.trailingStop.default,
  }

  const result: Record<string, number> = {}
  for (const param of paramTypes) {
    result[param] = defaults[param] || 0
  }

  return [result]
}

/**
 * Generate simple hash for parameter set identification
 */
function generateParamHash(params: Record<string, number>): string {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}:${params[k].toFixed(2)}`)
    .join("|")
  return Buffer.from(sorted).toString("base64").substring(0, 8)
}

/**
 * Get indication configuration for a specific type
 */
export function getIndicationConfigForType(
  type: "direction" | "move" | "active" | "optimal" | "auto",
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
