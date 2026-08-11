import {
  ACTIVE_MARKET_EXIT_SITUATIONS,
  buildActiveOutbreakProtectionProfiles,
} from "@/lib/active-outbreak-indication"
import { deriveProtectionFromActiveOutbreak } from "@/lib/strategy-coordinator"

describe("Active outbreak strategy protection integration", () => {
  const profiles = buildActiveOutbreakProtectionProfiles({
    metrics: {
      priceChangePct: 1.4,
      currentActivityPct: 0.42,
      previousActivityPct: 0.12,
      currentRangePct: 1.6,
      volatilityPct: 0.38,
    },
    positionCostPct: 0.1,
    volatilityWeight: 0.3,
    stopLossPositionCostRatios: [2, 3, 5],
    takeProfitMultipliers: [1.25, 1.5, 1],
    marketExitSituations: ACTIVE_MARKET_EXIT_SITUATIONS,
  })

  test("preserves every exact SL lane and adds exchange costs only to the TP target", () => {
    const costModel = {
      takerFeeBpsPerSide: 5,
      estimatedSpreadBps: 2,
      estimatedMarketSlippageBps: 3,
      fundingHoldCostBufferBps: 1,
    }

    for (const profile of profiles) {
      const protection = deriveProtectionFromActiveOutbreak(profile, costModel)
      expect(protection).not.toBeNull()
      expect(protection?.stopLossPct).toBe(profile.stopLossPct)
      expect(protection?.takeProfitPct).toBeGreaterThan(profile.takeProfitPct)
      expect(protection?.costBufferPct).toBeCloseTo(0.19, 8)
      expect(protection?.effectiveTpPct).toBeCloseTo(
        Number(protection?.takeProfitPct) - 0.19,
        8,
      )
      expect(protection?.netPF).toBeGreaterThan(1)
    }
  })

  test("keeps all market-exit situations and profile identities independent", () => {
    expect(profiles).toHaveLength(9)
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(9)
    expect(new Set(profiles.map((profile) => profile.marketExitSituation))).toEqual(
      new Set(ACTIVE_MARKET_EXIT_SITUATIONS),
    )
    expect(new Set(profiles.map((profile) => profile.stopLossPositionCostRatio))).toEqual(
      new Set([2, 3, 5]),
    )
  })

  test("rejects incomplete protection records before live or pseudo dispatch", () => {
    expect(deriveProtectionFromActiveOutbreak(null)).toBeNull()
    expect(deriveProtectionFromActiveOutbreak({ stopLossPct: 0.5 })).toBeNull()
    expect(deriveProtectionFromActiveOutbreak({ stopLossPct: -1, takeProfitPct: 1 })).toBeNull()
    expect(deriveProtectionFromActiveOutbreak({ stopLossPct: 1, takeProfitPct: Number.NaN })).toBeNull()
  })
})
