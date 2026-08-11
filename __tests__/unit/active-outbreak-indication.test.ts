import {
  ACTIVE_MARKET_EXIT_SITUATIONS,
  buildActiveOutbreakProtectionProfiles,
  calculateActiveOutbreak,
} from "@/lib/active-outbreak-indication"

const base = {
  range: 3,
  thresholdPct: 0.5,
  previousActivityRatio: 1,
  noiseFilterPct: 0.05,
  drawdownRatio: 1,
  lastPartRatio: 0.5,
  factorMultiplier: 1,
  volatilityWeight: 0.3,
  positionCostPct: 0.1,
}

describe("Active outbreak indication", () => {
  test("detects a causal accelerating long outbreak against the previous window", () => {
    const result = calculateActiveOutbreak({
      ...base,
      pricesOldestFirst: [100, 100.05, 100, 100.1, 100.3, 100.7, 101.2],
    })

    expect(result).not.toBeNull()
    expect(result?.direction).toBe("long")
    expect(result?.metrics.activityRatio).toBeGreaterThan(1)
    expect(result?.metrics.breakoutPct).toBeGreaterThanOrEqual(base.noiseFilterPct)
    expect(result?.metrics.tailAgreement).toBe(1)
    expect(result?.protectionProfiles).toHaveLength(9)
  })

  test("detects short independently and retains direction on every calculation", () => {
    const result = calculateActiveOutbreak({
      ...base,
      pricesOldestFirst: [100, 99.98, 100.02, 99.95, 99.7, 99.25, 98.75],
    })

    expect(result?.direction).toBe("short")
    expect(result?.metrics.signedPriceChangePct).toBeLessThan(0)
    expect(result?.confidence).toBeGreaterThan(0.5)
  })

  test("rejects a fast move that does not break the previous/current reference range", () => {
    const result = calculateActiveOutbreak({
      ...base,
      pricesOldestFirst: [100, 102, 100.5, 100, 100.2, 100.5, 101],
    })

    expect(result).toBeNull()
  })

  test("rejects movement that is weaker than the configured previous-activity relationship", () => {
    const result = calculateActiveOutbreak({
      ...base,
      previousActivityRatio: 20,
      pricesOldestFirst: [100, 100.05, 100, 100.1, 100.3, 100.7, 101.2],
    })

    expect(result).toBeNull()
  })

  test("builds the complete independent SL × TP market-exit matrix", () => {
    const profiles = buildActiveOutbreakProtectionProfiles({
      metrics: {
        priceChangePct: 1.2,
        currentActivityPct: 0.35,
        previousActivityPct: 0.1,
        currentRangePct: 1.4,
        volatilityPct: 0.35,
      },
      positionCostPct: 0.1,
      volatilityWeight: 0.3,
      stopLossPositionCostRatios: [2, 3, 5],
      takeProfitMultipliers: [1.25, 1.5, 1],
      marketExitSituations: ACTIVE_MARKET_EXIT_SITUATIONS,
    })

    expect(profiles).toHaveLength(3 * ACTIVE_MARKET_EXIT_SITUATIONS.length)
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length)
    expect(new Set(profiles.map((profile) => profile.stopLossPositionCostRatio))).toEqual(
      new Set([2, 3, 5]),
    )
    expect(new Set(profiles.map((profile) => profile.marketExitSituation))).toEqual(
      new Set(ACTIVE_MARKET_EXIT_SITUATIONS),
    )
    expect(Object.fromEntries(
      profiles
        .filter((profile) => profile.stopLossPositionCostRatio === 2)
        .map((profile) => [profile.marketExitSituation, profile.takeProfitMultiplier]),
    )).toEqual({
      momentum: 1.25,
      range_extension: 1.5,
      activity_fade: 1,
    })
    expect(profiles.every((profile) =>
      profile.orderExitType === "TAKE_PROFIT_MARKET" &&
      profile.stopLossPct >= 0.2 &&
      profile.takeProfitPct <= 22 &&
      profile.rewardRisk >= 1.1,
    )).toBe(true)
  })

  test("does not mutate or reverse the caller's historical price array", () => {
    const prices = [100, 100.05, 100, 100.1, 100.3, 100.7, 101.2]
    const before = [...prices]
    calculateActiveOutbreak({ ...base, pricesOldestFirst: prices })
    expect(prices).toEqual(before)
  })
})
