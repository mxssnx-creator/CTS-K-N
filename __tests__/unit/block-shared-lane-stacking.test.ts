import {
  BLOCK_SHARED_RELATIONS,
  BLOCK_SHARED_RELATIONS_DEFAULT,
  BLOCK_SHARED_VOLUME_RATIO_DEFAULT,
  BLOCK_VOLUME_RATIO_DEFAULT,
  BLOCK_VOLUME_RATIO_MAX,
  BLOCK_VOLUME_RATIO_MIN,
  BLOCK_VOLUME_RATIO_STEP,
  clampBlockVolumeRatio,
  normalizeBlockSharedRelations,
  stackBlockSharedLanes,
} from "@/lib/block-volume-ratio-bounds"

describe("Block volume ratio bounds follow the operator specification", () => {
  test("0.1 to 2.0 in steps of 0.1, default 0.2", () => {
    expect([BLOCK_VOLUME_RATIO_MIN, BLOCK_VOLUME_RATIO_MAX, BLOCK_VOLUME_RATIO_STEP, BLOCK_VOLUME_RATIO_DEFAULT])
      .toEqual([0.1, 2.0, 0.1, 0.2])
  })

  test("clamping keeps a value inside the range and never yields zero", () => {
    expect(clampBlockVolumeRatio(0.05)).toBe(0.1)
    expect(clampBlockVolumeRatio(5)).toBe(2.0)
    expect(clampBlockVolumeRatio(1.3)).toBe(1.3)
    for (const bad of [0, -1, Number.NaN, "", null, undefined]) {
      expect(clampBlockVolumeRatio(bad)).toBe(BLOCK_VOLUME_RATIO_DEFAULT)
    }
  })

  test("the shared ratio is its own, larger default", () => {
    expect(BLOCK_SHARED_VOLUME_RATIO_DEFAULT).toBe(1.5)
    expect(BLOCK_SHARED_VOLUME_RATIO_DEFAULT).toBeGreaterThan(BLOCK_VOLUME_RATIO_DEFAULT)
  })
})

describe("shared Block stacks additively across independent relations", () => {
  const lanes = [
    { relation: "symbol" as const, validCount: 2 },
    { relation: "direction" as const, validCount: 3 },
    { relation: "indication" as const, validCount: 5 },
  ]

  test("enabled relations add; disabled ones contribute nothing", () => {
    const out = stackBlockSharedLanes(lanes, ["symbol", "direction"], 1.5)
    expect(out.totalValid).toBe(5)
    expect(out.multiplier).toBeCloseTo(1 + 5 * 1.5, 10)
    expect(out.contributions.map((c) => c.relation)).toEqual(["symbol", "direction"])
  })

  test("it adds rather than taking a maximum or a product", () => {
    const out = stackBlockSharedLanes(lanes, ["symbol", "direction", "indication"], 1)
    // max() would give 5, a product would give 30; additive gives 10.
    expect(out.totalValid).toBe(10)
  })

  test("no valid Blocks leaves the base size untouched, never zero", () => {
    const out = stackBlockSharedLanes([{ relation: "symbol", validCount: 0 }], ["symbol"], 1.5)
    expect(out.totalValid).toBe(0)
    expect(out.multiplier).toBe(1)
  })

  test("the defaults are symbol and direction — independent in every configuration", () => {
    expect([...BLOCK_SHARED_RELATIONS_DEFAULT]).toEqual(["symbol", "direction"])
    expect(BLOCK_SHARED_RELATIONS).toContain("indication")
    expect(BLOCK_SHARED_RELATIONS).toContain("lane")
  })

  test("an unrecognised or empty selection falls back rather than disabling stacking", () => {
    expect(normalizeBlockSharedRelations([])).toEqual(["symbol", "direction"])
    expect(normalizeBlockSharedRelations("nonsense")).toEqual(["symbol", "direction"])
    expect(normalizeBlockSharedRelations("direction,symbol,direction")).toEqual(["direction", "symbol"])
    expect(normalizeBlockSharedRelations(["LANE", " indication "])).toEqual(["lane", "indication"])
  })

  test("a negative or fractional count cannot inflate the stack", () => {
    const out = stackBlockSharedLanes(
      [{ relation: "symbol", validCount: 2.9 }, { relation: "direction", validCount: -4 }],
      ["symbol", "direction"], 1,
    )
    expect(out.totalValid).toBe(2)
  })
})

describe("the UI cannot drift from the canonical bounds", () => {
  const { readFileSync } = require("node:fs")
  const { resolve } = require("node:path")
  const surfaces = [
    "components/settings/direct-trade-settings.tsx",
    "app/presets/page.tsx",
  ]

  test("every Block volume-ratio control reads the shared constants", () => {
    for (const path of surfaces) {
      const src = readFileSync(resolve(process.cwd(), path), "utf8")
      expect([path, src.includes("block-volume-ratio-bounds")]).toEqual([path, true])
      expect([path, src.includes("min={BLOCK_VOLUME_RATIO_MIN}")]).toEqual([path, true])
      expect([path, src.includes("max={BLOCK_VOLUME_RATIO_MAX}")]).toEqual([path, true])
      expect([path, src.includes("step={BLOCK_VOLUME_RATIO_STEP}")]).toEqual([path, true])
    }
  })

  test("no hardcoded bound survives on those controls", () => {
    for (const path of surfaces) {
      const src = readFileSync(resolve(process.cwd(), path), "utf8")
      for (const line of src.split("\n")) {
        if (!line.includes("blockVolumeRatio")) continue
        // The old bounds were 0.25/3 and 0.1/10 — both are now wrong.
        expect([path, /min=\{0\.\d+\}/.test(line)]).toEqual([path, false])
        expect([path, /max=\{\d+\}/.test(line)]).toEqual([path, false])
      }
    }
  })
})

describe("the shared stack is wired into the Real overlay builder", () => {
  const { readFileSync } = require("node:fs")
  const { resolve } = require("node:path")
  const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

  test("shared mode replaces the per-direction candidate, it does not add a second one", () => {
    expect(src).toContain("if (this._coordinationSettings.blockSharedVolumeAdjustEnabled) {")
    // The per-direction loop survives as the else branch — exactly one of the
    // two paths runs, so a Set can never be sized twice.
    expect(src).toContain("addCandidate(source, stacked.totalValid, \"global\")")
    expect(src).toContain("addCandidate(source, activeCount, \"global\")")
  })

  test("the operator's relation selection is normalised before use", () => {
    expect(src).toContain("normalizeBlockSharedRelations(this._coordinationSettings.blockSharedRelations)")
  })

  test("an empty stack falls through to no candidate rather than a zero-sized one", () => {
    expect(src).toContain("if (stacked.totalValid > 0) {")
  })

  test("count 1 stays the base entry in shared mode too", () => {
    const block = src.slice(src.indexOf("if (this._coordinationSettings.blockSharedVolumeAdjustEnabled) {"))
    expect(block).toContain("activeCombinedByDir[dir] <= 1")
    expect(block).toContain("Math.max(0, activeCombinedByDir.long - 1)")
  })
})
