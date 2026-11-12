import { mergeConnectionSettings } from "@/lib/connection-settings-merge"

describe("connection settings merge clamps posCountsVolumeRatio", () => {
  test("nested step edits replace stale flat values and synchronize both aliases", () => {
    const merged = mergeConnectionSettings({
      minStep: 5, trailingMinStep: 8,
      coordination_settings: { minStep: 5, trailingMinStep: 8, axes: { prev: { enabled: true } } },
    }, { coordinationSettings: { minStep: 2, trailingMinStep: 3 } })
    expect(merged).toMatchObject({ minStep: 2, trailingMinStep: 3 })
    expect(merged.coordination_settings).toBe(merged.coordinationSettings)
    expect(merged.coordination_settings).toMatchObject({
      minStep: 2, trailingMinStep: 3, axes: { prev: { enabled: true } },
    })
  })

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
