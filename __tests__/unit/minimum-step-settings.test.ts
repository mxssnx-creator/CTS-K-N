import { normalizeTrailingMinStep } from "@/lib/constants"
import { resolveMinimumStepSettings } from "@/lib/minimum-step-settings"
import { buildTrailingProfiles } from "@/lib/trailing-settings"

describe("minimum steps shared by simulation and live settings", () => {
  test.each([undefined, null, {}, "{}"])("missing settings use Base 2 and trailing 3: %p", raw => {
    expect(resolveMinimumStepSettings(raw)).toEqual({ minStep: 2, trailingMinStep: 3 })
    expect(buildTrailingProfiles(["0.3:0.1"])[0].minStep).toBe(3)
  })

  test.each([
    [{ minStep: 5, trailingMinStep: 8 }, 5, 8],
    [{ min_step: "2", trailing_min_step: "3" }, 2, 3],
    [{ coordination_settings: { minStep: 7, trailingMinStep: 11 } }, 7, 11],
    [{ coordinationSettings: '{"minStep":4,"trailingMinStep":9}' }, 4, 9],
    [{ minStep: 6, trailingMinStep: 2 }, 6, 6],
    [{ minStep: 2, trailingMinStep: 2 }, 2, 2],
    [{ minStep: 2, trailingMinStep: "invalid" }, 2, 3],
    [{ minStep: 99, trailingMinStep: 99 }, 30, 30],
    [{ minStep: 3, coordination_settings: { minStep: 9, trailingMinStep: 12 } }, 3, 12],
  ])("preserves valid overrides and clamps the same pair: %p", (raw, minStep, trailingMinStep) => {
    expect(resolveMinimumStepSettings(raw)).toEqual({ minStep, trailingMinStep })
  })

  test.each([undefined, null, "", 0, -1, NaN, Infinity, "bad"])("invalid trailing minimum falls back to 3: %p", raw => {
    expect(normalizeTrailingMinStep(raw)).toBe(3)
    expect(normalizeTrailingMinStep(raw, 8)).toBe(8)
  })

  test("the complete Base/trailing range uses identical profile admission in sim and live", () => {
    for (let base = 2; base <= 30; base++) {
      for (let trail = 2; trail <= 30; trail++) {
        const live = resolveMinimumStepSettings({ minStep: base, trailingMinStep: trail })
        const simulated = buildTrailingProfiles(["0.3:0.1"], trail, base)[0]
        expect(simulated.minStep).toBe(live.trailingMinStep)
        const windows = Array.from({ length: 31 - base }, (_, index) => index + base)
        expect(windows.filter(step => step >= simulated.minStep))
          .toEqual(windows.filter(step => step >= live.trailingMinStep))
      }
    }
  })
})
