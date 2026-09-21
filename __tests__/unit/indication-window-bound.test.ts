import { MAX_BASE_STEP, MAX_INDICATION_WINDOW } from "@/lib/constants"
import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"

describe("the indication window grid has its own bound", () => {
  test("the window grid reaches 48; the trailing clamp stays at 30", () => {
    expect(MAX_INDICATION_WINDOW).toBe(48)
    // MAX_BASE_STEP also clamps the trailing step in buildTrailingProfiles.
    // Sharing one constant made an indication change move trailing behaviour.
    expect(MAX_BASE_STEP).toBe(30)
    expect(MAX_INDICATION_WINDOW).toBeGreaterThan(MAX_BASE_STEP)
  })

  test("the configuration counter reports the widened grid, not the old ceiling", () => {
    const counts = calculateIndicationConfigurationCounts({}, undefined)
    expect(counts.settings.indicationRangeMax).toBe(MAX_INDICATION_WINDOW)
    // 18 further integer windows per symbol and indication.
    expect(counts.settings.validRangeCount).toBe(MAX_INDICATION_WINDOW - counts.settings.indicationRangeMin + 1)
  })

  test("the operator's Base minimum still narrows the grid from below", () => {
    // The ceiling is the constant; the operator moves the FLOOR via minStep.
    const narrowed = calculateIndicationConfigurationCounts({ minStep: 30 }, undefined)
    expect(narrowed.settings.indicationRangeMin).toBe(30)
    expect(narrowed.settings.validRangeCount).toBe(MAX_INDICATION_WINDOW - 30 + 1)
  })
})
