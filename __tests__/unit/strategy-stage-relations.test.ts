import {
  classifyMainOpenSet,
  countOpenMainBreakdown,
  mainSetHasOpenLineage,
} from "@/lib/strategy-stage-relations"

describe("strategy stage relations", () => {
  test("resolves derived Main rows through their open Base lineage", () => {
    const active = new Set(["BTCUSDT:direction:long"])
    expect(mainSetHasOpenLineage({
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c0",
      parentSetKey: "BTCUSDT:direction:long",
    }, active)).toBe(true)
    expect(mainSetHasOpenLineage({
      setKey: "ETHUSDT:direction:long#default",
      parentSetKey: "ETHUSDT:direction:long",
    }, active)).toBe(false)
  })

  test("classifies every Main row into one category with position-count priority", () => {
    expect(classifyMainOpenSet({ variant: "default" })).toBe("standard")
    expect(classifyMainOpenSet({ variant: "trailing" })).toBe("trailing")
    expect(classifyMainOpenSet({ variant: "block", trailingProfile: {} })).toBe("block")
    expect(classifyMainOpenSet({ variant: "dca" })).toBe("dca")
    expect(classifyMainOpenSet({
      variant: "trailing",
      axisWindows: { direction: "long", axisKey: "p4_l1_c0" },
      posCountsVolumeRatio: 0.02,
    })).toBe("positionCount")
  })

  test("breakdown sum equals the complete open Main set count", () => {
    const active = new Set(["base-a", "base-b"])
    const breakdown = countOpenMainBreakdown([
      { setKey: "base-a#default", parentSetKey: "base-a", variant: "default" },
      { setKey: "base-a#trailing", parentSetKey: "base-a", variant: "trailing" },
      { setKey: "base-a#axis", parentSetKey: "base-a", posCountsVolumeRatio: 0.02 },
      { setKey: "base-b#block", parentSetKey: "base-b", variant: "block" },
      { setKey: "base-b#dca", parentSetKey: "base-b", variant: "dca" },
      { setKey: "closed#default", parentSetKey: "closed", variant: "default" },
    ], active)

    expect(breakdown).toEqual({
      standard: 1,
      trailing: 1,
      positionCount: 1,
      block: 1,
      dca: 1,
    })
    expect(Object.values(breakdown).reduce((sum, value) => sum + value, 0)).toBe(5)
  })
})
