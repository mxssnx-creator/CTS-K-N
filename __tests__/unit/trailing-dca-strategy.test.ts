import {
  DEFAULT_DCA_PROFILE,
  adverseMovePct,
  buildDcaStepSetKey,
  calculateDcaAddQuantity,
  calculateDcaTakeProfitPrice,
  normalizeDcaProfile,
  resolveNextDcaStep,
  upsertDcaLeg,
} from "@/lib/dca-strategy"
import {
  ALL_TRAILING_VARIANTS,
  DEFAULT_TRAILING_VARIANTS,
  buildTrailingProfiles,
  normalizeTrailingVariants,
  parseStoredBoolean,
} from "@/lib/trailing-settings"

describe("bounded trailing configuration", () => {
  test("parses Redis booleans without treating the string false as enabled", () => {
    expect(parseStoredBoolean("false", true)).toBe(false)
    expect(parseStoredBoolean("true", false)).toBe(true)
    expect(parseStoredBoolean(undefined, true)).toBe(true)
  })

  test("accepts only the supported 5x5 matrix and removes duplicates", () => {
    expect(normalizeTrailingVariants('["0.3:0.1","0.3:0.1","99:99","bad"]')).toEqual(["0.3:0.1"])
    expect(normalizeTrailingVariants(ALL_TRAILING_VARIANTS)).toHaveLength(25)
    expect(DEFAULT_TRAILING_VARIANTS).toEqual(["0.3:0.1", "0.6:0.2", "0.9:0.3", "1.2:0.4", "1.5:0.5"])
  })

  test("builds stable bounded profiles and clamps the minimum step", () => {
    expect(buildTrailingProfiles(["0.3:0.1"], 100)).toEqual([
      { startRatio: 0.3, stopRatio: 0.1, stepRatio: 0.05, tag: "t30-10", minStep: 30 },
    ])
  })
})

describe("DCA profile and progression", () => {
  test("assigns a stable independent Set identity to every configured DCA step", () => {
    const base = "BTCUSDT:direction:long#dca"
    const keys = Array.from({ length: 4 }, (_, index) => buildDcaStepSetKey(base, index + 1))
    expect(keys).toEqual([
      `${base}#step:1`,
      `${base}#step:2`,
      `${base}#step:3`,
      `${base}#step:4`,
    ])
    expect(new Set(keys).size).toBe(4)
    expect(buildDcaStepSetKey(`${base}#step:1`, 2)).toBe(`${base}#step:2`)
  })

  test("normalizes detailed settings and enforces sequential trigger distances", () => {
    const profile = normalizeDcaProfile({
      dcaMaxSteps: "9",
      dcaStepVolumeMultipliers: "[1.5,9,2.3,2.5]",
      dcaStepDistancesPct: "[1,0.5,3,2]",
      dcaTakeProfitMode: "breakeven_plus",
      dcaBreakevenProfitPct: "0.35",
      dcaCooldownSeconds: "45",
    })
    expect(profile).toEqual({
      maxSteps: 4,
      stepVolumeMultipliers: [1.5, 2.5, 2.3, 2.5],
      stepDistancesPct: [1, 1, 3, 3],
      takeProfitMode: "breakeven_plus",
      breakevenProfitPct: 0.35,
      cooldownSeconds: 45,
    })
  })

  test("keeps every later trigger at or beyond the furthest earlier trigger", () => {
    expect(normalizeDcaProfile({
      dcaStepDistancesPct: [5, 1, 2, 0.5],
    }).stepDistancesPct).toEqual([5, 5, 5, 5])
  })

  test("calculates adverse moves symmetrically for long and short", () => {
    expect(adverseMovePct("long", 100, 98.5)).toBeCloseTo(1.5)
    expect(adverseMovePct("short", 100, 101.5)).toBeCloseTo(1.5)
    expect(adverseMovePct("long", 100, 101)).toBe(0)
  })

  test("runs one price-triggered step at a time and observes cooldown", () => {
    const profile = { ...DEFAULT_DCA_PROFILE, cooldownSeconds: 30 }
    const step1 = resolveNextDcaStep({
      direction: "long",
      referencePrice: 100,
      currentPrice: 99.4,
      profile,
      now: 100_000,
    })
    expect(step1?.step).toBe(1)

    const legs = upsertDcaLeg([], {
      setKey: "set#step:1",
      step: 1,
      baseQuantity: 2,
      volumeMultiplier: 1.5,
      triggerDistancePct: 0.5,
      requestedQuantity: 3,
      quantity: 3,
      referencePrice: 100,
      filledAt: 100_000,
    })
    expect(resolveNextDcaStep({
      direction: "long",
      referencePrice: 100,
      currentPrice: 98.5,
      profile,
      legs,
      now: 120_000,
    })).toBeNull()
    expect(resolveNextDcaStep({
      direction: "long",
      referencePrice: 100,
      currentPrice: 98.5,
      profile,
      legs,
      now: 131_000,
    })?.step).toBe(2)
  })

  test("sizes every step from the immutable initial quantity", () => {
    expect(calculateDcaAddQuantity(2, 1.5)).toBe(3)
    expect(calculateDcaAddQuantity(2, 2.5)).toBe(5)
    expect(calculateDcaAddQuantity(0, 2.5)).toBe(0)
  })

  test("derives average, first-entry, and breakeven-plus targets", () => {
    const base = {
      direction: "long" as const,
      initialEntryPrice: 100,
      averageEntryPrice: 95,
      takeProfitPct: 2,
    }
    expect(calculateDcaTakeProfitPrice({ ...base, profile: DEFAULT_DCA_PROFILE })).toBeCloseTo(96.9)
    expect(calculateDcaTakeProfitPrice({
      ...base,
      profile: { ...DEFAULT_DCA_PROFILE, takeProfitMode: "first_entry" },
    })).toBeCloseTo(102)
    expect(calculateDcaTakeProfitPrice({
      ...base,
      direction: "short",
      profile: { ...DEFAULT_DCA_PROFILE, takeProfitMode: "breakeven_plus", breakevenProfitPct: 0.2 },
    })).toBeCloseTo(94.81)
  })
})
