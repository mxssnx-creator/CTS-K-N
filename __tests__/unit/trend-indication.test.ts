import {
  buildAdaptiveTrendTpRange,
  calculateAverageOneMinuteChangePct,
  calculateTrendSignal,
  DEFAULT_TREND_TIMEFRAMES_MINUTES,
} from "@/lib/trend-indication"

describe("Trend indication coordination", () => {
  test("keeps the requested calculation windows in ascending order", () => {
    expect([...DEFAULT_TREND_TIMEFRAMES_MINUTES]).toEqual([1, 3, 5, 10, 15, 30])
  })

  test("coordinates overall, recent and active movement for long and short trends", () => {
    const long = calculateTrendSignal([100, 100.03, 100.06, 100.09], {
      timeframeMinutes: 3,
      drawdownFactor: -1,
      lastSituationRatio: 0.5,
      activeSituationRatio: 0.5,
      positionCostPct: 0.01,
      minAgreement: 0.6,
    })
    const short = calculateTrendSignal([100.09, 100.06, 100.03, 100], {
      timeframeMinutes: 3,
      drawdownFactor: -1,
      lastSituationRatio: 0.5,
      activeSituationRatio: 0.5,
      positionCostPct: 0.01,
      minAgreement: 0.6,
    })

    expect(long?.direction).toBe("long")
    expect(short?.direction).toBe("short")
    expect(long?.metadata.activeMarketChangePct).toBeGreaterThan(0)
    expect(short?.metadata.activeMarketChangePct).toBeLessThan(0)
    expect(long?.signalScore).toBeGreaterThan(1)
    expect(short?.signalScore).toBeGreaterThan(1)
  })

  test("rejects an excessive adverse drawdown but accepts a wider independent config", () => {
    const prices = [100, 102, 100, 103]
    const strict = calculateTrendSignal(prices, {
      timeframeMinutes: 3,
      drawdownFactor: -1,
      lastSituationRatio: 0.5,
      activeSituationRatio: 0.5,
      positionCostPct: 1,
      minAgreement: 0.6,
    })
    const wide = calculateTrendSignal(prices, {
      timeframeMinutes: 3,
      drawdownFactor: -3,
      lastSituationRatio: 0.5,
      activeSituationRatio: 0.5,
      positionCostPct: 1,
      minAgreement: 0.6,
    })

    expect(strict).toBeNull()
    expect(wide?.direction).toBe("long")
    expect(wide?.metadata.adverseDrawdownFactor).toBeLessThan(-1)
  })

  test("rejects a stale overall trend when the active market change points the other way", () => {
    expect(calculateTrendSignal([100, 101, 102, 101.5], {
      timeframeMinutes: 3,
      drawdownFactor: -3,
      lastSituationRatio: 0.1,
      activeSituationRatio: 0.1,
      positionCostPct: 0.1,
      minAgreement: 0.6,
    })).toBeNull()
  })

  test("builds the requested adaptive TP example from average 1m change and PositionCost", () => {
    // Each close is exactly +0.03%; 0.03 / 0.01 PositionCost = ratio 3.
    const prices = [100, 100.03, 100.060009, 100.0900270027]
    expect(calculateAverageOneMinuteChangePct(prices)).toBeCloseTo(0.03, 8)

    const range = buildAdaptiveTrendTpRange({
      pricesOldestFirst: prices,
      positionCostPct: 0.01,
      minMultiplier: 2,
      maxFactor: 10,
      step: 1,
    })

    expect(range.marketChangePositionCostRatio).toBeCloseTo(3, 6)
    expect(range.calculatedMinFactor).toBeCloseTo(6, 6)
    expect(range.factors).toEqual([6, 7, 8, 9, 10])
  })

  test("clamps a calculated minimum above the configured maximum to one safe max factor", () => {
    const range = buildAdaptiveTrendTpRange({
      pricesOldestFirst: [100, 101, 102],
      positionCostPct: 0.01,
      minMultiplier: 2,
      maxFactor: 10,
      step: 1,
    })
    expect(range.factors).toEqual([10])
    expect(range.appliedMinFactor).toBe(10)
  })
})
