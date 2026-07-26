import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"

describe("indication configuration counts", () => {
  it("matches the processor's balanced default grids", () => {
    const result = calculateIndicationConfigurationCounts({}, undefined)

    expect(result.totalPossibleSets).toBe(330)
    expect(result.totalEvaluationConfigurations).toBe(300)
    expect(result.settings.commonTimeframes).toEqual([1, 3, 5, 15])
    expect(result.settings.enabledCommonIndicators).toBe(11)
    expect(Object.fromEntries(result.types.map((type) => [type.type, type.possibleSets]))).toEqual({
      direction: 66,
      move: 66,
      active: 78,
      active_advanced: 6,
      optimal: 10,
      auto: 0,
      signal: 2,
      trend: 102,
      common: 0,
    })
  })

  it("keeps Trend windows separate and caps Common windows at 15 minutes", () => {
    const result = calculateIndicationConfigurationCounts(
      {
        trendTimeframesMinutes: [1, 5, 15, 30],
        trendDrawdownValues: [-1],
        trendLastSituationRatios: [1],
        trendActiveSituationRatios: [1],
        trendRangeSteps: [2, 3],
      },
      {
        coordination: { timeframesMinutes: [1, 5, 15, 30] },
      },
    )
    const trend = result.types.find((type) => type.type === "trend")
    const common = result.types.find((type) => type.type === "common")

    expect(trend?.params.timeframes).toBe(4)
    expect(trend?.possibleSets).toBe(12)
    expect(result.settings.commonTimeframes).toEqual([1, 5, 15])
    expect(common?.params.timeframes).toBe("1/5/15")
  })

  it("reports runtime evaluations separately from durable Long/Short sets", () => {
    const result = calculateIndicationConfigurationCounts(
      {
        directionEnabled: false,
        moveEnabled: false,
        activeEnabled: false,
        optimalEnabled: false,
        autoEnabled: true,
        trendEnabled: false,
      },
      {
        coordination: { timeframesMinutes: [1] },
        ma: { enabled: true },
        sma: { enabled: false },
        ema: { enabled: false },
        macd: { enabled: false },
        rsi: { enabled: false },
        bollinger: { enabled: false },
        stochastic: { enabled: false },
        adx: { enabled: false },
        atr: { enabled: false },
        parabolicSAR: { enabled: false },
        cci: { enabled: false },
        adl: { enabled: false },
        fibonacci: { enabled: false },
        roc: { enabled: false },
        williamsR: { enabled: false },
        obv: { enabled: false },
        vwap: { enabled: false },
      },
    )

    expect(result.totalPossibleSets).toBe(8)
    expect(result.types.find((type) => type.type === "auto")).toMatchObject({
      storage: "runtime",
      possibleSets: 0,
      evaluationConfigurations: 1,
    })
    expect(result.types.find((type) => type.type === "common")).toMatchObject({
      storage: "runtime",
      possibleSets: 0,
      evaluationConfigurations: 3,
    })
    expect(result.types.find((type) => type.type === "signal")).toMatchObject({
      storage: "independent_set",
      possibleSets: 2,
      evaluationConfigurations: 11,
    })
  })

  it("uses the scalar Active Advanced range written by its dedicated settings route", () => {
    const result = calculateIndicationConfigurationCounts({
      activeAdvancedActivityRatiosFrom: 0.5,
      activeAdvancedActivityRatiosTo: 2,
      activeAdvancedActivityRatiosStep: 0.5,
      indicationFactorMultipliers: [1, 1.1],
    }, undefined)
    const advanced = result.types.find((type) => type.type === "active_advanced")

    expect(advanced?.params.activityRatios).toBe(4)
    expect(advanced?.evaluationConfigurations).toBe(8)
    expect(advanced?.possibleSets).toBe(16)
  })
})
