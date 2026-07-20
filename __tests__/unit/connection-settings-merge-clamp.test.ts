import { mergeConnectionSettings } from "@/lib/connection-settings-merge"

describe("connection settings merge clamps posCountsVolumeRatio", () => {
  test("clamps an out-of-range top-level ratio into [0.01, 0.25]", () => {
    const merged = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.05 },
      { posCountsVolumeRatio: 0.9 },
    )
    expect(merged.posCountsVolumeRatio).toBe(0.25)

    const low = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.05 },
      { posCountsVolumeRatio: 0.001 },
    )
    expect(low.posCountsVolumeRatio).toBe(0.01)
  })

  test("clamps an out-of-range nested coordination ratio", () => {
    const merged = mergeConnectionSettings(
      { coordinationSettings: { posCountsVolumeRatio: 0.05 } },
      { coordinationSettings: { posCountsVolumeRatio: 0.9 } },
    )
    expect(merged.coordinationSettings.posCountsVolumeRatio).toBe(0.25)
  })

  test("re-merging an already-clamped current value stays within range", () => {
    const merged = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.9 },
      { posCountsVolumeRatio: 0.05 },
    )
    expect(merged.posCountsVolumeRatio).toBeLessThanOrEqual(0.25)
    expect(merged.posCountsVolumeRatio).toBeGreaterThanOrEqual(0.01)
  })
})
