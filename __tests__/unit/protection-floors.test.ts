import {
  DEFAULT_MIN_STOP_LOSS_PCT,
  DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
  applyStopLossFloorPct,
  applyTrailingDistanceFloorPct,
  applyTrailingDistanceFloorRatio,
  getActiveProtectionFloors,
  normalizeProtectionFloorPct,
  resolveProtectionFloors,
  setActiveProtectionFloors,
  validateProtectionFloorInput,
} from "@/lib/protection-floors"
import {
  __signalIndicationTestUtils,
  effectiveSignalStopLossMinPct,
  normalizeSignalIndicationSettings,
  normalizeSignalRisk,
} from "@/lib/signal-indication"
import {
  SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR,
  buildSignalTrailingProfile,
  calculateSignalTrailingTick,
} from "@/lib/signal-trailing"
import {
  deriveProtectionFromProfitFactor,
  deriveProtectionFromSignalRisk,
} from "@/lib/strategy-coordinator"

afterEach(() => { setActiveProtectionFloors({}) })

describe("protection floor normalization", () => {
  test("defaults are 0.6 % for SL and trailing distance (raised from 0.5 % on 2026-10-06)", () => {
    expect(DEFAULT_MIN_STOP_LOSS_PCT).toBe(0.6)
    expect(DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT).toBe(0.6)
    expect(resolveProtectionFloors(undefined)).toEqual({ minStopLossPct: 0.6, minTrailingStopDistancePct: 0.6 })
    expect(getActiveProtectionFloors()).toEqual({ minStopLossPct: 0.6, minTrailingStopDistancePct: 0.6 })
  })

  test("clamps into 0.05–10 and falls back on garbage", () => {
    expect(normalizeProtectionFloorPct(0.01, 0.5)).toBe(0.05)
    expect(normalizeProtectionFloorPct(50, 0.5)).toBe(10)
    expect(normalizeProtectionFloorPct("0.75", 0.5)).toBe(0.75)
    expect(normalizeProtectionFloorPct("abc", 0.5)).toBe(0.5)
    expect(normalizeProtectionFloorPct("", 0.5)).toBe(0.5)
    expect(resolveProtectionFloors({ min_stop_loss_pct: 1, minTrailingStopDistancePct: 0.7 }))
      .toEqual({ minStopLossPct: 1, minTrailingStopDistancePct: 0.7 })
  })

  test("API validation rejects out-of-range and non-numeric values only when present", () => {
    expect(validateProtectionFloorInput({})).toEqual([])
    expect(validateProtectionFloorInput({ minStopLossPct: 0.5, minTrailingStopDistancePct: "1.2" })).toEqual([])
    expect(validateProtectionFloorInput({ minStopLossPct: 0.05, minTrailingStopDistancePct: 10 })).toEqual([])
    expect(validateProtectionFloorInput({ minStopLossPct: 0.04 })).toHaveLength(1)
    expect(validateProtectionFloorInput({ minTrailingStopDistancePct: 10.5 })).toHaveLength(1)
    expect(validateProtectionFloorInput({ minStopLossPct: "x", minTrailingStopDistancePct: "" })).toHaveLength(2)
  })

  test("floors raise tight distances and never lower wider ones", () => {
    expect(applyStopLossFloorPct(0.2)).toBe(0.6)
    expect(applyStopLossFloorPct(1.3)).toBe(1.3)
    expect(applyTrailingDistanceFloorPct(0.1)).toBe(0.6)
    expect(applyTrailingDistanceFloorPct(2)).toBe(2)
    expect(applyTrailingDistanceFloorRatio(0.001)).toBeCloseTo(0.006, 12)
    expect(applyTrailingDistanceFloorRatio(0.1)).toBeCloseTo(0.1, 12)
    setActiveProtectionFloors({ minStopLossPct: 0.8, minTrailingStopDistancePct: 0.6 })
    expect(applyStopLossFloorPct(0.5)).toBe(0.8)
    expect(applyTrailingDistanceFloorPct(0.5)).toBe(0.6)
  })
})

describe("Signal lane enforcement", () => {
  test("settings carry validated floors and raise the effective SL minimum", () => {
    const defaults = normalizeSignalIndicationSettings({})
    expect(defaults.minStopLossPct).toBe(0.6)
    expect(defaults.minTrailingStopDistancePct).toBe(0.6)
    // Configured stopLossMinPct 0.2 is kept but the effective minimum is 0.6.
    expect(defaults.stopLossMinPct).toBe(0.2)
    expect(effectiveSignalStopLossMinPct(defaults)).toBe(0.6)
    const wider = normalizeSignalIndicationSettings({ stopLossMinPct: 1.2, minStopLossPct: 0.5 })
    expect(effectiveSignalStopLossMinPct(wider)).toBe(1.2)
    const clamped = normalizeSignalIndicationSettings({ minStopLossPct: 99, minTrailingStopDistancePct: 0 })
    expect(clamped.minStopLossPct).toBe(10)
    expect(clamped.minTrailingStopDistancePct).toBe(0.05)
    expect(clamped.stopLossMaxPct).toBeGreaterThanOrEqual(10)
  })

  test("the pre-existing 0.8 % Signal trailing floor stays in force above the 0.6 % floor", () => {
    const settings = normalizeSignalIndicationSettings({ trailingMinStopPct: 0.1 })
    expect(settings.trailingMinStopPct).toBe(SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR)
    const higher = normalizeSignalIndicationSettings({ trailingMinStopPct: 0.1, minTrailingStopDistancePct: 1.5 })
    expect(higher.trailingMinStopPct).toBe(1.5)
    const profile = buildSignalTrailingProfile({ ...higher, trailingMinStopPct: 0.1 })
    expect(profile.minStopRatio).toBeCloseTo(0.015, 12)
    const tick = calculateSignalTrailingTick({
      entryPrice: 100, currentPrice: 100.1, side: "long", profile,
      active: false, anchor: 0, stopPrice: 0, stopRangeRatio: 0,
    })
    expect(tick.stopRangeRatio).toBeGreaterThanOrEqual(0.015)
  })

  test("consensus SL is raised to the floor, wider stops unchanged", () => {
    const settings = normalizeSignalIndicationSettings({ minimumSourceSignals: 3, minimumAgreement: 0.6 })
    const base = {
      sourceName: "s", direction: "long" as const, confidence: 0.8, strength: 0.7,
      takeProfitPct: 1.8, rewardRisk: 2, atrPct: 0.2, lastPrice: 100, weight: 1,
    }
    const tight = __signalIndicationTestUtils.lowStopConsensus([
      { ...base, sourceId: "a", stopLossPct: 0.2 },
      { ...base, sourceId: "b", stopLossPct: 0.25 },
      { ...base, sourceId: "c", stopLossPct: 0.3 },
    ] as any, settings)
    expect(tight?.risk.stopLossPct).toBe(DEFAULT_MIN_STOP_LOSS_PCT)
    const wide = __signalIndicationTestUtils.lowStopConsensus([
      { ...base, sourceId: "a", stopLossPct: 0.9 },
      { ...base, sourceId: "b", stopLossPct: 0.9 },
      { ...base, sourceId: "c", stopLossPct: 0.9 },
    ] as any, settings)
    expect(wide?.risk.stopLossPct).toBeCloseTo(0.9, 8)
  })

  test("persisted Signal risk and its live protection respect the SL floor", () => {
    const risk = normalizeSignalRisk({ stopLossPct: 0.2, takeProfitPct: 0.9, sourceIds: ["okx-swap"] })
    expect(risk?.stopLossPct).toBe(DEFAULT_MIN_STOP_LOSS_PCT)
    const kept = normalizeSignalRisk({ stopLossPct: 0.7, takeProfitPct: 0.9, sourceIds: ["okx-swap"] })
    expect(kept?.stopLossPct).toBe(0.7)
    const protection = deriveProtectionFromSignalRisk({
      stopLossPct: 0.3, takeProfitPct: 0.9, rewardRisk: 3, sourceIds: ["okx-swap"],
      agreement: 0.8, confidence: 0.8, generatedAt: Date.now(),
    })
    expect(protection?.stopLossPct).toBe(DEFAULT_MIN_STOP_LOSS_PCT)
  })
})

describe("Main lane enforcement", () => {
  const venueCosts = { takerFeeBpsPerSide: 5, estimatedSpreadBps: 2, estimatedMarketSlippageBps: 3, fundingHoldCostBufferBps: 1 }

  test("PF-derived SL is floored at the 0.6 % default and follows the configured floor", () => {
    expect(deriveProtectionFromProfitFactor(1.3, 0.1, 1, venueCosts).stopLossPct).toBe(DEFAULT_MIN_STOP_LOSS_PCT)
    expect(deriveProtectionFromProfitFactor(1.3, 0.8, 1, venueCosts).stopLossPct).toBeCloseTo(0.8, 12)
    setActiveProtectionFloors({ minStopLossPct: 1 })
    expect(deriveProtectionFromProfitFactor(1.3, 0.1, 1, venueCosts).stopLossPct).toBe(1)
    setActiveProtectionFloors({ minStopLossPct: 0.05 })
    // The legacy 0.2 % exchange minimum remains the lower bound.
    expect(deriveProtectionFromProfitFactor(1.3, 0.1, 1, venueCosts).stopLossPct).toBe(0.2)
  })
})
