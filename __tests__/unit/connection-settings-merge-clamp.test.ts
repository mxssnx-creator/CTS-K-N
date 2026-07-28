import { mergeConnectionSettings } from "@/lib/connection-settings-merge"

describe("connection settings merge clamps posCountsVolumeRatio", () => {
  test("clamps an out-of-range top-level ratio into the canonical [0.1, 10] grid", () => {
    const merged = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.05 },
      { posCountsVolumeRatio: 0.9 },
    )
    expect(merged.posCountsVolumeRatio).toBe(0.9)

    const low = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.05 },
      { posCountsVolumeRatio: 0.001 },
    )
    expect(low.posCountsVolumeRatio).toBe(0.1)

    const high = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.05 },
      { posCountsVolumeRatio: 99 },
    )
    expect(high.posCountsVolumeRatio).toBe(10)
  })

  test("clamps an out-of-range nested coordination ratio", () => {
    const merged = mergeConnectionSettings(
      { coordinationSettings: { posCountsVolumeRatio: 0.05 } },
      { coordinationSettings: { posCountsVolumeRatio: 0.9 } },
    )
    expect(merged.coordinationSettings.posCountsVolumeRatio).toBe(0.9)
  })

  test("re-merging an already-clamped current value stays within range", () => {
    const merged = mergeConnectionSettings(
      { posCountsVolumeRatio: 0.9 },
      { posCountsVolumeRatio: 0.05 },
    )
    expect(merged.posCountsVolumeRatio).toBeLessThanOrEqual(10)
    expect(merged.posCountsVolumeRatio).toBeGreaterThanOrEqual(0.1)
  })
})
