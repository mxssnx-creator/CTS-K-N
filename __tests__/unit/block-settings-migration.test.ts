import { normalizeAdditiveBlockSettings } from "@/lib/block-settings-migration"

describe("additive Block settings upgrade", () => {
  test("normalizes legacy settings without changing independent lower values or unrelated risk settings", () => {
    const document = { blockMaxStack: 12, blockIncrementSteps: 5, presetBlockMaxStack: 3, presetBlockIncrementSteps: 1, blockRange: [1, 12], blockVolumeRatio: 0.25, marginCallPercent: 30 }
    expect(normalizeAdditiveBlockSettings(document)).toBe(true)
    expect(document).toMatchObject({ blockMaxStack: 6, blockIncrementSteps: 2, presetBlockMaxStack: 3, presetBlockIncrementSteps: 1, blockRange: [1, 6], blockVolumeRatio: 0.25, marginCallPercent: 30 })
    expect(normalizeAdditiveBlockSettings(document)).toBe(false)
  })

  test("updates structured settings but never rewrites confirmed fills or persisted recovery levels", () => {
    const positions = [{ blockCount: 12, blockIncrementSteps: 5, quantity: 24 }]
    const document = { coordination_settings: JSON.stringify({ blockMaxStack: 12, blockIncrementSteps: 5 }), positions }
    normalizeAdditiveBlockSettings(document)
    expect(JSON.parse(document.coordination_settings)).toEqual({ blockMaxStack: 6, blockIncrementSteps: 2 })
    expect(document.positions).toBe(positions)
    expect(positions[0]).toEqual({ blockCount: 12, blockIncrementSteps: 5, quantity: 24 })
  })
})
