import {
  DEFAULT_ADVANCED_CONFIG,
  generateIndicationConfigurationSets,
  generateStrategyConfigurationSets,
  type AdvancedEngineConfig,
} from "@/lib/trade-engine/advanced-config"

const twoPointRange = {
  min: 1,
  max: 2,
  default: 1,
  step: 1,
}

function compactConfig(): AdvancedEngineConfig {
  return {
    ...DEFAULT_ADVANCED_CONFIG,
    indicationParameters: {
      steps: twoPointRange,
      drawdownRatio: twoPointRange,
      marketActivity: twoPointRange,
      rangeRatio: twoPointRange,
      activityRatio: twoPointRange,
      marketDistanceRatio: twoPointRange,
    },
    pseudoPosition: {
      ...DEFAULT_ADVANCED_CONFIG.pseudoPosition,
      takeProfitSteps: twoPointRange,
      stopLossRatio: twoPointRange,
      trailingStart: twoPointRange,
      trailingStop: twoPointRange,
    },
    strategyEvaluation: {
      ...DEFAULT_ADVANCED_CONFIG.strategyEvaluation,
      positionCountsToEvaluate: [1, 2],
      pseudoPositionConfigurations: [1, 2],
    },
  }
}

describe("advanced compatibility configuration generator", () => {
  test("uses the canonical stage ratios and exact independent cooldowns", () => {
    expect(DEFAULT_ADVANCED_CONFIG.strategyEvaluation.mainMinProfitFactor).toEqual({
      min: 0.8,
      max: 2.7,
      default: 1.12,
      step: 0.02,
    })
    expect(DEFAULT_ADVANCED_CONFIG.strategyEvaluation.realMinProfitFactor).toBe(1.12)
    expect(DEFAULT_ADVANCED_CONFIG.indicationEvaluation.timeoutSeconds.default).toBe(0.25)
    expect(DEFAULT_ADVANCED_CONFIG.pseudoPosition.timeoutSeconds.default).toBe(1)
    expect(DEFAULT_ADVANCED_CONFIG.indicationEvaluation.maxPositionsPerDirection.default).toBe(1)
  })

  test("materializes every configured indication combination including endpoints", () => {
    const sets = generateIndicationConfigurationSets(compactConfig())

    // Active uses four axes: 2^4 = 16. The six other compatibility types use
    // six axes each: 6 × 2^6 = 384. No representative sampling is permitted.
    expect(sets).toHaveLength(400)
    expect(sets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        indicationType: "direction",
        parameters: {
          steps: 1,
          drawdownRatio: 1,
          marketActivity: 1,
          rangeRatio: 1,
          activityRatio: 1,
          marketDistanceRatio: 1,
        },
      }),
      expect.objectContaining({
        indicationType: "direction",
        parameters: {
          steps: 2,
          drawdownRatio: 2,
          marketActivity: 2,
          rangeRatio: 2,
          activityRatio: 2,
          marketDistanceRatio: 2,
        },
      }),
    ]))
  })

  test("materializes every configured strategy combination independently", () => {
    const sets = generateStrategyConfigurationSets(compactConfig())

    // Two configuration IDs × two position counts × four two-point axes.
    expect(sets).toHaveLength(64)
    expect(new Set(sets.map((set) => set.id)).size).toBe(64)
  })
})
