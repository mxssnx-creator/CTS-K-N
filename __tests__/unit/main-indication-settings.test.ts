import {
  applyCanonicalSettingsToMainDocument,
  mainDocumentToCanonicalSettings,
  normalizeMainIndicationSettings,
} from "@/lib/main-indication-settings"

describe("main indication settings compatibility", () => {
  it("parses the stored JSON document and fills every engine section", () => {
    const document = normalizeMainIndicationSettings(JSON.stringify({
      direction: {
        enabled: false,
        range: { from: 4, to: 8, step: 2 },
      },
    }))

    expect(document.direction).toMatchObject({
      enabled: false,
      range: { from: 4, to: 8, step: 2 },
    })
    expect(document.move.enabled).toBe(true)
    expect(document.active_advanced.activity_values).toEqual([0.5, 1, 1.5, 2, 2.5, 3])
    expect(document.coordination.direction_post_change_only).toBe(true)
  })

  it("overlays the specialized page from the canonical engine settings", () => {
    const document = applyCanonicalSettingsToMainDocument({}, {
      directionEnabled: false,
      moveEnabled: true,
      indicationSampleRanges: [2, 7, 15],
      optimalSampleRanges: [3, 9],
      activeThresholds: [0.75, 2],
      activeAdvancedActivityRatios: [0.5, 2.5],
      directionPostChangeOnly: false,
      defaultCoordinationRangeSteps: [2, 3],
    })

    expect(document.direction.enabled).toBe(false)
    expect(document.direction.sample_ranges).toEqual([2, 7, 15])
    expect(document.move.sample_ranges).toEqual([2, 7, 15])
    expect(document.optimal.sample_ranges).toEqual([3, 9])
    expect(document.active.thresholds).toEqual([0.75, 2])
    expect(document.active_advanced.activity_values).toEqual([0.5, 2.5])
    expect(document.coordination.direction_post_change_only).toBe(false)
    expect(document.coordination.range_steps).toEqual([2, 3])
  })

  it("maps specialized-page changes back to the exact canonical grids", () => {
    const canonical = mainDocumentToCanonicalSettings({
      configuration: {
        sample_ranges: "2, 5, 11",
        drawdown_ratios: "0.5, 1.25",
        last_part_ratios: [0.25],
        factor_multipliers: [1, 1.1],
        active_thresholds: [0.5, 3],
        active_time_ratios: [0.5, 1],
      },
      coordination: {
        enabled: true,
        ranges: [2, 5, 15],
        range_steps: [2, 2.5, 3],
        direction_post_change_only: true,
      },
      direction: { enabled: true },
      move: { enabled: false },
      active: { enabled: true },
      active_advanced: {
        enabled: false,
        activity_values: [0.5, 1.5, 4],
        min_positions: 5,
        continuation_ratio: 0.75,
      },
      optimal: {
        enabled: true,
        sample_ranges: [3, 6, 12],
        base_positions_limit: 375,
      },
    })

    expect(canonical).toMatchObject({
      directionEnabled: true,
      moveEnabled: false,
      activeEnabled: true,
      activeAdvancedEnabled: false,
      indicationSampleRanges: [2, 5, 11],
      optimalSampleRanges: [3, 6, 12],
      indicationDrawdownRatios: [0.5, 1.25],
      activeThresholds: [0.5, 3],
      activeAdvancedActivityRatios: [0.5, 1.5, 4],
      activeAdvancedMinPositions: 5,
      activeAdvancedContinuationRatio: 0.75,
      optimalBasePositionsLimit: 375,
      directionPostChangeOnly: true,
    })
  })
})
