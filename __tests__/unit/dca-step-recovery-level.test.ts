import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveDcaStepRecoveryLevel } from "@/lib/trade-engine/stages/live-stage"
import { calculateDcaStepVolumeRatio, DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"

describe("per-step DCA recovery level in the live execution path", () => {
  test("without lifecycle state the level is 1, so the quantity is unchanged", () => {
    expect(resolveDcaStepRecoveryLevel(undefined, 1)).toBe(1)
    expect(resolveDcaStepRecoveryLevel(null, 1)).toBe(1)
    expect(resolveDcaStepRecoveryLevel({ dcaLegs: [] }, 1)).toBe(1)
    expect(resolveDcaStepRecoveryLevel({ dcaLegs: [{ step: 2, recoveryLevel: 4 }] }, 1)).toBe(1)
    // Identity: level 1 reproduces the plain configured multiplier.
    expect(calculateDcaStepVolumeRatio(1.5, resolveDcaStepRecoveryLevel(null, 1), DEFAULT_DCA_PROFILE.incrementSteps))
      .toBeCloseTo(1.5, 10)
  })

  test("each step carries its own level and never inherits from another step", () => {
    const position = { dcaLegs: [{ step: 1, recoveryLevel: 1 }, { step: 2, recoveryLevel: 3 }, { step: 3, recoveryLevel: 6 }] }
    expect(resolveDcaStepRecoveryLevel(position, 1)).toBe(1)
    expect(resolveDcaStepRecoveryLevel(position, 2)).toBe(3)
    expect(resolveDcaStepRecoveryLevel(position, 3)).toBe(6)
    // The add-on scales with that step's level against the ORIGINAL base.
    expect(calculateDcaStepVolumeRatio(0.5, resolveDcaStepRecoveryLevel(position, 2), 6)).toBeCloseTo(1.5, 10)
    expect(calculateDcaStepVolumeRatio(0.5, resolveDcaStepRecoveryLevel(position, 3), 6)).toBeCloseTo(3, 10)
  })

  test("malformed or legacy state degrades to no escalation", () => {
    for (const leg of [{ step: 1 }, { step: 1, recoveryLevel: 0 }, { step: 1, recoveryLevel: -2 }, { step: 1, recoveryLevel: "x" }]) {
      expect(resolveDcaStepRecoveryLevel({ dcaLegs: [leg] }, 1)).toBe(1)
    }
    // The legacy field name is accepted.
    expect(resolveDcaStepRecoveryLevel({ dcaLegs: [{ step: 1, incrementStep: 2 }] }, 1)).toBe(2)
  })

  test("the live step target multiplies the configured multiplier by that step's level", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    // The persisted per-step lane wins, with the leg value as the fallback.
    expect(src).toContain("readDcaStepRecoveryLevel(dcaStepStored, existing.symbol, existing.setKey, next.step)")
    expect(src).toContain("resolveDcaStepRecoveryLevel(existing, next.step),")
    expect(src).toContain("const dcaTargetQuantity = baseQuantity * calculateDcaStepVolumeRatio(")
    expect(src).not.toContain("const dcaTargetQuantity = baseQuantity * next.volumeMultiplier")
    // The max-position ceiling still bounds the result.
    expect(src).toContain("dcaProfile.maxPositionVolumeRatio,")
  })
})
