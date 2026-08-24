import {
  deriveProtectionFromProfitFactor,
  sanitizeLiveProfitFactor,
} from "@/lib/strategy-coordinator"

describe("Live-stage PositionCost ratio contract", () => {
  const venueCosts = {
    takerFeeBpsPerSide: 8,
    estimatedSpreadBps: 6,
    estimatedMarketSlippageBps: 10,
    fundingHoldCostBufferBps: 4,
  }

  test("uses the configured PositionCost exactly once for Main-stage targets", () => {
    expect(deriveProtectionFromProfitFactor(1.0, 0.1, 1, venueCosts).takeProfitPct).toBeCloseTo(0.2, 12)
    // The exchange's 0.20% minimum still protects a neutral 1.00 target;
    // 1.10 is exactly two PositionCost units gross, not a reward/risk multiple.
    expect(deriveProtectionFromProfitFactor(1.1, 0.1, 1, venueCosts).takeProfitPct).toBeCloseTo(0.2, 12)
    expect(deriveProtectionFromProfitFactor(1.2, 0.1, 1, venueCosts).takeProfitPct).toBeCloseTo(0.3, 12)
    expect(deriveProtectionFromProfitFactor(1.2, 0.2, 1, venueCosts).takeProfitPct).toBeCloseTo(0.6, 12)
  })

  test("never turns a legacy signed 0.x result into a negative live target", () => {
    expect(sanitizeLiveProfitFactor(0.6)).toBe(1)
    expect(sanitizeLiveProfitFactor(1.0)).toBe(1)
    expect(sanitizeLiveProfitFactor(1.01)).toBeCloseTo(1.01, 12)
    expect(sanitizeLiveProfitFactor(2.35)).toBe(2.3)
    expect(deriveProtectionFromProfitFactor(0.6, 0.1, 1, venueCosts).takeProfitPct).toBeGreaterThanOrEqual(0.2)
  })
})
