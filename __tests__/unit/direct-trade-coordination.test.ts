import {
  buildTimeframeCombinations,
  buildDirectTradeTakeProfitPositionCostRatios,
  directTradeTakeProfitPercent,
  calculateDirectTradeProfitFactor,
  averageDirectTradeTakeProfitRatio,
  evaluateDirectTradeSets,
  normaliseDirectTradeTakeProfitRatioRange,
  normaliseDirectTradeTakeProfitRatioStep,
  normaliseDirectTradeStrategyTypes,
  normaliseDirectTradeTimeframes,
  resampleCandles,
  type DirectTradeCandle,
} from "@/lib/direct-trade-coordination"

function upwardMinuteSeries(size = 80): DirectTradeCandle[] {
  return Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.35
    return {
      time: index * 60_000,
      open: close - 0.1,
      high: close + 0.15,
      low: close - 0.2,
      close,
      volume: 100 + index,
    }
  })
}

describe("Direct-Trade independent historical coordination", () => {
  test("uses the 2–22 PositionCost TP contract with a 4–14 default and sparse Set stride", () => {
    expect(normaliseDirectTradeTakeProfitRatioRange(undefined)).toEqual([4, 14])
    expect(normaliseDirectTradeTakeProfitRatioRange([0, 99])).toEqual([2, 22])
    expect(normaliseDirectTradeTakeProfitRatioStep(undefined)).toBe(4)
    expect(normaliseDirectTradeTakeProfitRatioStep(0)).toBe(1)
    expect(buildDirectTradeTakeProfitPositionCostRatios([2, 5], 1)).toEqual([2, 3, 4, 5])
    expect(buildDirectTradeTakeProfitPositionCostRatios([4, 14])).toEqual([4, 8, 12, 14])
    expect(directTradeTakeProfitPercent(0.1, 4)).toBe(0.4)
    expect(directTradeTakeProfitPercent(0.1, 22)).toBe(2.2)
    expect(averageDirectTradeTakeProfitRatio([4, 8, 12, 14])).toBe(9.5)
    expect(averageDirectTradeTakeProfitRatio([4, 8, 12, 14].map((ratio) => directTradeTakeProfitPercent(0.1, ratio))) ).toBe(0.95)
  })

  test("calculates aggregate PF from summed net ratio components, not averages", () => {
    expect(calculateDirectTradeProfitFactor(30, 10)).toEqual({
      profit: 30,
      loss: 10,
      profitFactor: 3,
      profitFactorInfinite: false,
    })
    // Row PFs 10 and 1 average to 5.5, but the portfolio PF is 11/2 = 5.5
    // only when the row losses are equal; this explicit unequal example proves
    // the denominator is summed rather than a range/row mean.
    const aggregate = calculateDirectTradeProfitFactor(10 + 2, 1 + 2)
    expect(aggregate.profitFactor).toBe(4)
    expect(aggregate.profitFactor).not.toBe((10 / 1 + 2 / 2) / 2)
  })

  test("migrates 5m without pretending it is a 15m candle and creates every selected combination", () => {
    expect(normaliseDirectTradeTimeframes(["1m", "5m", "15m"]).sort()).toEqual(["10m", "15m", "1m"].sort())
    expect(buildTimeframeCombinations(["1m", "10m", "15m"])).toHaveLength(7)

    const candles = upwardMinuteSeries(20)
    const tenMinute = resampleCandles(candles, 10)
    expect(tenMinute).toHaveLength(2)
    expect(tenMinute[0]).toMatchObject({ open: candles[0].open, close: candles[9].close })
    expect(tenMinute[0].high).toBe(candles[9].high)
    // Persisted temporary and former names retain their intended independent
    // lineage after the operator-facing rename.
    expect(normaliseDirectTradeStrategyTypes(["trailing_auto_combination", "complex"]))
      .toEqual(["trailing_auto", "combination"])
  })

  test("materialises independent TP/SL/trailing keys and keeps hindsight best exits analytical only", () => {
    const candles = upwardMinuteSeries()
    const sets = evaluateDirectTradeSets({
      symbol: "BTCUSDT",
      direction: "long",
      candlesByTimeframe: { "1m": candles, "10m": resampleCandles(candles, 10), "15m": resampleCandles(candles, 15) },
      timeframeSet: ["1m"],
      historyHours: 60,
      volumeRatio: 0.1,
      tpRange: [0.3, 0.5],
      slRatios: [0.25],
      trailOptions: [
        { trailing: false, trailStart: 0, trailStop: 0 },
        { trailing: true, trailStart: 0.3, trailStop: 0.2 },
      ],
      entryTactics: ["breakout"],
      exitTactics: ["bracket"],
      entryTiming: "current",
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      blockRange: [1, 12],
      minProfitFactor: 0.8,
      maxDrawdownTimeMin: 60,
    })

    expect(sets).toHaveLength(4)
    expect(new Set(sets.map((set) => set.setKey)).size).toBe(4)
    expect(sets.every((set) => set.timeframe === "1m" && set.historyHours === 60)).toBe(true)
    expect(sets.every((set) => set.bestMarketExitAnalysisOnly)).toBe(true)
    expect(sets.every((set) => typeof set.activeEntry === "boolean")).toBe(true)
    expect(sets.some((set) => set.bestMarketExitPnl > set.totalPnl)).toBe(true)
    expect(sets.every((set) => set.recentPositionCount >= 0 && set.recentPositionCount <= 12)).toBe(true)
    expect(sets.every((set) => set.recentPositionCount === 0 || set.lastPositionExitReason !== null)).toBe(true)
    expect(sets.every((set) =>
      set.recentProfitFactorInfinite || typeof set.recentProfitFactor === "number",
    )).toBe(true)
    expect(sets.every((set) => set.valid || set.deactivationReason !== null)).toBe(true)
  })

  test("keeps Auto Trailing, Combination, inverse and high-protection as independent order lineages", () => {
    const candles = upwardMinuteSeries(180)
    const common = {
      symbol: "BTCUSDT",
      direction: "long" as const,
      candlesByTimeframe: { "1m": candles, "10m": resampleCandles(candles, 10), "15m": resampleCandles(candles, 15) },
      timeframeSet: ["1m"] as const,
      historyHours: 60,
      volumeRatio: 0.1,
      entryTactics: ["breakout"] as const,
      exitTactics: ["bracket"] as const,
      entryTiming: "current" as const,
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      blockRange: [1, 12] as [number, number],
      minProfitFactor: 0.8,
      maxDrawdownTimeMin: 60,
    }
    const auto = evaluateDirectTradeSets({
      ...common,
      strategyType: "trailing_auto",
      tpRange: [1],
      slRatios: [0.75],
      trailOptions: [{ trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "auto", autoTrailSensitivity: 1 }],
    })
    const combination = evaluateDirectTradeSets({
      ...common,
      strategyType: "combination",
      tpRange: [1],
      slRatios: [0.75],
      trailOptions: [
        { trailing: false, trailStart: 0, trailStop: 0, mode: "none" },
        { trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "fixed" },
        { trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "auto", autoTrailSensitivity: 1 },
      ],
    })
    const inverse = evaluateDirectTradeSets({
      ...common,
      strategyType: "inverse",
      signalDirection: "short",
      tpRange: [1],
      slRatios: [1.25],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
    })
    const highProtection = evaluateDirectTradeSets({
      ...common,
      strategyType: "high_protection",
      tpRange: [4],
      slRatios: [0.75],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
    })
    const relativeCombination = evaluateDirectTradeSets({
      ...common,
      strategyType: "combination",
      entryTactics: ["relative"],
      exitTactics: ["relative"],
      tpRange: [1],
      slRatios: [0.75],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
    })

    expect(auto).toHaveLength(1)
    expect(auto[0]).toMatchObject({ strategyType: "trailing_auto", trailingMode: "auto", autoTrailSensitivity: 1 })
    expect(combination).toHaveLength(3)
    expect(new Set(combination.map((set) => set.trailingMode))).toEqual(new Set(["none", "fixed", "auto"]))
    expect(inverse).toHaveLength(1)
    expect(inverse[0]).toMatchObject({ direction: "long", signalDirection: "short", strategyType: "inverse", stoploss: 1.25 })
    expect(inverse[0].stoploss).toBeLessThanOrEqual(inverse[0].takeprofit * 1.25)
    expect(highProtection).toHaveLength(1)
    expect(highProtection[0]).toMatchObject({ strategyType: "high_protection", takeprofit: 4, stoploss: 3 })
    expect(relativeCombination).toHaveLength(1)
    expect(relativeCombination[0]).toMatchObject({ strategyType: "combination", entryTactic: "relative", exitTactic: "relative" })
    expect(new Set([...auto, ...combination, ...inverse, ...highProtection, ...relativeCombination].map((set) => set.setKey)).size).toBe(7)
  })

  test("requires a finite high-PF recent closed-position window for a new eligible config", () => {
    const candles = upwardMinuteSeries(220)
    const sets = evaluateDirectTradeSets({
      symbol: "BTCUSDT",
      direction: "long",
      candlesByTimeframe: { "1m": candles },
      timeframeSet: ["1m"],
      historyHours: 90,
      volumeRatio: 0.1,
      tpRange: [0.3],
      slRatios: [0.25],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
      entryTactics: ["breakout"],
      exitTactics: ["bracket"],
      entryTiming: "current",
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      blockRange: [0, 0],
      minProfitFactor: 0.8,
      minRecentProfitFactor: 10,
      recentPositionWindow: 12,
      minRecentPositions: 12,
      maxDrawdownTimeMin: 60,
    })

    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({
      recentPositionCount: 12,
      recentProfitFactorInfinite: true,
      valid: false,
      deactivationReason: "recent_pf",
    })
  })

  test("deducts the configured position cost once from each closed historical result", () => {
    const candles = upwardMinuteSeries(180)
    const common = {
      symbol: "BTCUSDT",
      direction: "long" as const,
      candlesByTimeframe: { "1m": candles },
      timeframeSet: ["1m"] as const,
      historyHours: 90,
      volumeRatio: 0.1,
      tpRange: [0.3],
      slRatios: [0.25],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
      entryTactics: ["breakout"] as const,
      exitTactics: ["bracket"] as const,
      entryTiming: "current" as const,
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      blockRange: [1, 12] as [number, number],
      minProfitFactor: 0.8,
      minRecentProfitFactor: 0.8,
      recentPositionWindow: 3,
      minRecentPositions: 3,
      maxDrawdownTimeMin: 60,
    }
    const lowCost = evaluateDirectTradeSets({ ...common, positionCostPercent: 0.02 })[0]
    const defaultCost = evaluateDirectTradeSets({ ...common, positionCostPercent: 0.1 })[0]

    expect(defaultCost.positionCostPercent).toBe(0.1)
    expect(defaultCost.totalPnl).toBeCloseTo(lowCost.totalPnl - lowCost.totalTrades * 0.08, 3)
    expect(defaultCost.recentTotalPnl).toBeCloseTo(lowCost.recentTotalPnl - lowCost.recentPositionCount * 0.08, 3)
  })

  test("keeps the configured PositionCost TP multiplier in each exact set identity", () => {
    const candles = upwardMinuteSeries(180)
    const sets = evaluateDirectTradeSets({
      symbol: "BTCUSDT",
      direction: "long",
      candlesByTimeframe: { "1m": candles },
      timeframeSet: ["1m"],
      historyHours: 60,
      volumeRatio: 1.5,
      tpRange: [0.4, 0.5],
      takeProfitPositionCostRatios: [4, 5],
      slRatios: [0.5],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" }],
      entryTactics: ["breakout"],
      exitTactics: ["bracket"],
      entryTiming: "current",
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      positionCostPercent: 0.1,
      blockRange: [3, 3],
      minProfitFactor: 0.8,
      maxDrawdownTimeMin: 60,
    })

    expect(sets.map((set) => set.takeProfitPositionCostRatio)).toEqual([4, 5])
    expect(sets.map((set) => set.takeprofit)).toEqual([0.4, 0.5])
    expect(sets.every((set) => set.blockVolumeRatio === 1.5 && set.blockCount === 3)).toBe(true)
    expect(new Set(sets.map((set) => set.setKey)).size).toBe(2)
  })

  test("keeps Block Count 1..N PF/volume ledgers independent from the Base row", () => {
    const candles = upwardMinuteSeries(180)
    const common = {
      symbol: "BTCUSDT",
      direction: "long" as const,
      candlesByTimeframe: { "1m": candles },
      timeframeSet: ["1m"] as const,
      historyHours: 48,
      volumeRatio: 0.5,
      tpRange: [0.3],
      takeProfitPositionCostRatios: [3],
      slRatios: [0.5],
      trailOptions: [{ trailing: false, trailStart: 0, trailStop: 0, mode: "none" as const }],
      entryTactics: ["breakout"] as const,
      exitTactics: ["bracket"] as const,
      entryTiming: "current" as const,
      activityVolumeRatio: 0,
      maxHoldMinutes: 20,
      minProfitFactor: 0.8,
      blockProfitFactorRatio: 0.8,
      minRecentProfitFactor: 0.8,
      recentPositionWindow: 3,
      minRecentPositions: 3,
      maxDrawdownTimeMin: 60,
    }
    const withBlock = evaluateDirectTradeSets({ ...common, blockRange: [1, 3] })[0]
    const withoutBlock = evaluateDirectTradeSets({ ...common, blockRange: [0, 0] })[0]

    expect(withBlock.blockEvaluations.map((entry) => entry.blockCount)).toEqual([1, 2, 3])
    expect(new Set(withBlock.blockEvaluations.map((entry) => entry.blockSetKey)).size).toBe(3)
    expect(withBlock.blockEvaluations.every((entry) => entry.blockSetKey.endsWith(`#block:${entry.blockCount}`))).toBe(true)
    expect(withBlock.blockEvaluations.map((entry) => entry.blockVolumeIncrementRatio)).toEqual([0.5, 1, 1.5])
    expect(withBlock.blockEvaluations.map((entry) => entry.blockCalculatedVolumeMultiplier)).toEqual([1.5, 2, 2.5])
    expect(withBlock.blockEvaluations.map((entry) => entry.blockConfiguredMinimumProfitFactor)).toEqual([0.32, 0.64, 0.96])
    expect(withBlock.blockEvaluations.every((entry) => entry.blockProfitFactorWindow === 3)).toBe(true)
    expect(withBlock.blockCount).toBe(3)
    expect(withBlock.blockTotalPnl).not.toBeCloseTo(withBlock.totalPnl * 2.5, 3)
    expect(withBlock.blockGrossProfit).toBeGreaterThanOrEqual(0)
    expect(withBlock.blockGrossLoss).toBeGreaterThanOrEqual(0)
    expect(withBlock.netProfit).toBe(withBlock.grossProfit)
    expect(withBlock.netLoss).toBe(withBlock.grossLoss)
    expect(withBlock.blockNetProfit).toBe(withBlock.blockGrossProfit)
    expect(withBlock.blockNetLoss).toBe(withBlock.blockGrossLoss)
    expect(withBlock.blockProfitFactorToMinimumDifference).not.toBe(withBlock.blockConfiguredMinimumProfitFactor)
    expect(withoutBlock.blockEvaluations).toEqual([])
    expect(withoutBlock.blockCount).toBe(0)
    expect(withoutBlock.blockCalculatedVolumeMultiplier).toBe(1)
  })
})
