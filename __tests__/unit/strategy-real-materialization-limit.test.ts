import {
  limitRealRowsForMaterialization,
  strategyRowHasActiveExposure,
} from "@/lib/strategy-real-materialization-limit"

describe("Real materialization limit", () => {
  test("is unlimited when the configured ceiling is blank or zero", () => {
    const rows = [{ setKey: "base#a" }, { setKey: "base#b" }]
    expect(limitRealRowsForMaterialization(rows, 0, new Set()).rows).toBe(rows)
    expect(limitRealRowsForMaterialization(rows, Number.NaN, new Set()).rows).toBe(rows)
  })

  test("keeps quality order while preserving every exact active row", () => {
    const rows = [
      { setKey: "base#best" },
      { setKey: "base#second" },
      { setKey: "base#active-low-pf" },
      { setKey: "base#fourth" },
    ]
    const result = limitRealRowsForMaterialization(
      rows,
      2,
      new Set(["base#active-low-pf"]),
    )

    expect(result.rows).toEqual([rows[0], rows[2]])
    expect(result.activeRowsPreserved).toBe(1)
    expect(result.qualifiedBeforeLimit).toBe(4)
    expect(result.truncatedRows).toBe(2)
  })

  test("allows active exposure to exceed the ceiling instead of dropping it", () => {
    const rows = [
      { setKey: "base#a", _hasLivePositions: true },
      { setKey: "base#b", accumulatedSetKeys: ["member:b"] },
      { setKey: "base#inactive" },
    ]
    const active = new Set(["member:b"])
    const result = limitRealRowsForMaterialization(rows, 1, active)

    expect(result.rows).toEqual(rows.slice(0, 2))
    expect(result.activeRowsPreserved).toBe(2)
    expect(result.truncatedRows).toBe(1)
  })

  test("reserves Row-Real and variant families before filling by global quality", () => {
    const rows = [
      { setKey: "base#best", indicationType: "move", direction: "long", variant: "default" },
      { setKey: "base#second", indicationType: "move", direction: "long", variant: "default" },
      { setKey: "base#row", rowStage: "real", indicationType: "move", direction: "long", variant: "default" },
    ]
    const result = limitRealRowsForMaterialization(rows, 2, new Set())

    expect(result.rows).toEqual([rows[0], rows[2]])
    expect(result.familiesPreserved).toBe(2)
  })

  test("does not expand an active Base parent to every derived sibling", () => {
    const active = new Set(["base"])
    expect(strategyRowHasActiveExposure({ setKey: "base#axis:1", parentSetKey: "base" }, active)).toBe(false)
    expect(strategyRowHasActiveExposure({ setKey: "base", parentSetKey: "base" }, active)).toBe(true)
  })
})
