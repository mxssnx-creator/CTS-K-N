import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"

describe("indication configuration counts", () => {
  it("matches the processor's exhaustive default, Common and Signal grids", () => {
    const result = calculateIndicationConfigurationCounts({}, undefined)

    // Fresh installations start the exhaustive Base window at the configured
    // default of 5 (then evaluate every integer through 30).
    expect(result.totalPossibleSets).toBe(39_328)
    expect(result.totalEvaluationConfigurations).toBe(13_715)
    expect(result.settings.commonTimeframes).toEqual([1, 5, 15, 30])
    expect(result.settings.enabledCommonIndicators).toBe(17)
    expect(Object.fromEntries(result.types.map((type) => [type.type, type.possibleSets]))).toEqual({
      direction: 942,
      move: 942,
      active: 9_774,
      active_advanced: 36,
      special: 520,
      optimal: 156,
      auto: 0,
      signal: 11_664,
      trend: 102,
      common: 15_192,
    })
    expect(result.types.find((type) => type.type === "active")).toMatchObject({
      params: {
        outbreakRanges: 3,
        stopLossProfiles: 3,
        marketExitSituations: 3,
        protectionProfiles: 9,
      },
    })
    expect(result.types.find((type) => type.type === "special")).toMatchObject({
      evaluationConfigurations: 130,
      params: {
        ranges: 26,
        enabledTimeframes: 4,
        individualModes: 4,
        combinedModes: 1,
        exitVariants: 2,
        maxPositionsPerDirection: 5,
        maxVolumeRatio: 3,
      },
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
        specialEnabled: false,
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

    expect(result.totalPossibleSets).toBe(11_798)
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
      possibleSets: 11_664,
      evaluationConfigurations: 36,
      params: {
        directSourceInputs: 35,
        consensusInputs: 1,
        possibleSourceInputs: 36,
        tradeConfigurations: 162,
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

  it("honours the configured Base minimum while retaining every window through 30", () => {
    const baseline = calculateIndicationConfigurationCounts({}, undefined)
    const legacyCeiling = calculateIndicationConfigurationCounts({ minStep: 30 }, undefined)

    expect(legacyCeiling.settings.indicationRangeMin).toBe(30)
    expect(legacyCeiling.settings.indicationRangeMax).toBe(30)
    expect(legacyCeiling.settings.validRangeCount).toBe(1)
    expect(legacyCeiling.totalEvaluationConfigurations).toBeLessThan(
      baseline.totalEvaluationConfigurations,
    )
    expect(legacyCeiling.totalPossibleSets).toBeLessThan(baseline.totalPossibleSets)
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
