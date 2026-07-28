import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"

describe("indication configuration counts", () => {
  it("matches the processor's exhaustive default, Common and Signal grids", () => {
    const result = calculateIndicationConfigurationCounts({}, undefined)

    expect(result.totalPossibleSets).toBe(41_298)
    expect(result.totalEvaluationConfigurations).toBe(8_989)
    expect(result.settings.commonTimeframes).toEqual([1, 5, 15, 30])
    expect(result.settings.enabledCommonIndicators).toBe(17)
    expect(Object.fromEntries(result.types.map((type) => [type.type, type.possibleSets]))).toEqual({
      direction: 1_050,
      move: 1_050,
      active: 366,
      active_advanced: 36,
      optimal: 174,
      auto: 0,
      signal: 23_328,
      trend: 102,
      common: 15_192,
    })
  })

  it("keeps Trend and Common 1/5/15/30-minute windows independent", () => {
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
    expect(result.settings.commonTimeframes).toEqual([1, 5, 15, 30])
    expect(common?.params.timeframes).toBe("1/5/15/30")
  })

  it("reports Auto runtime work separately from durable Common and Signal Long/Short sets", () => {
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

    expect(result.totalPossibleSets).toBe(23_462)
    expect(result.types.find((type) => type.type === "auto")).toMatchObject({
      storage: "runtime",
      possibleSets: 0,
      evaluationConfigurations: 1,
    })
    expect(result.types.find((type) => type.type === "common")).toMatchObject({
      storage: "independent_set",
      possibleSets: 98,
      evaluationConfigurations: 49,
    })
    expect(result.types.find((type) => type.type === "signal")).toMatchObject({
      storage: "independent_set",
      possibleSets: 23_328,
      evaluationConfigurations: 11,
      params: {
        directSourceInputs: 10,
        consensusInputs: 1,
        possibleSourceInputs: 36,
        tradeConfigurations: 324,
        sourcePerformanceLookback: 12,
        symbolDirectionPerformanceLookback: 10,
      },
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

  it("does not let the legacy minStep setting truncate the exhaustive 2..30 grid", () => {
    const baseline = calculateIndicationConfigurationCounts({}, undefined)
    const legacyCeiling = calculateIndicationConfigurationCounts({ minStep: 30 }, undefined)

    expect(legacyCeiling.settings.indicationRangeMin).toBe(2)
    expect(legacyCeiling.settings.indicationRangeMax).toBe(30)
    expect(legacyCeiling.settings.validRangeCount).toBe(29)
    expect(legacyCeiling.totalEvaluationConfigurations).toBe(
      baseline.totalEvaluationConfigurations,
    )
    expect(legacyCeiling.totalPossibleSets).toBe(baseline.totalPossibleSets)
  })

  it("keeps every Signal source Set when PF bootstrap bypass is disabled", () => {
    const directBootstrap = calculateIndicationConfigurationCounts({}, undefined, {
      directExecutionEnabled: true,
    })
    const pfGatedBootstrap = calculateIndicationConfigurationCounts({}, undefined, {
      directExecutionEnabled: false,
    })

    expect(
      pfGatedBootstrap.types.find((type) => type.type === "signal")?.possibleSets,
    ).toBe(
      directBootstrap.types.find((type) => type.type === "signal")?.possibleSets,
    )
  })
})
