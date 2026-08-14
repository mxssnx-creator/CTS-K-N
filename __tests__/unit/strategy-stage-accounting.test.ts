import {
  accountMainStage,
  accountRealStageInputs,
} from "@/lib/strategy-stage-accounting"

const mirror = (parent: string) => ({
  setKey: `${parent}#default`,
  parentSetKey: parent,
  variant: "default",
})

const axis = (parent: string, suffix: string, direction: "long" | "short" = "long") => ({
  setKey: `${parent}#axis:${suffix}`,
  parentSetKey: parent,
  variant: "default",
  axisWindows: { direction },
  posCountsVolumeRatio: 0.006,
})

describe("strategy stage logical accounting", () => {
  test("counts all Pos-Count rows for one Base parent as one related Main evaluation", () => {
    const parentA = "BTCUSDT:direction:long"
    const parentB = "BTCUSDT:move:short"
    const sets = [
      mirror(parentA),
      axis(parentA, "p4_l1_c0"),
      axis(parentA, "p6_l2_c1"),
      axis(parentA, "p8_l3_c2", "short"),
      mirror(parentB),
      axis(parentB, "p4_l1_c0"),
      { setKey: `${parentB}#dca`, parentSetKey: parentB, variant: "dca" },
    ]

    const accounting = accountMainStage(2, sets)

    expect(accounting).toEqual({
      baseInputs: 2,
      positionCountRelated: 2,
      otherRelated: 1,
      logicalEvaluated: 5,
      rawMaterialized: 7,
      baseMirrors: 2,
    })
  })

  test("Real logical inputs preserve one Pos-Count lineage while raw work remains visible", () => {
    const parent = "ETHUSDT:direction:long"
    const input = [
      mirror(parent),
      axis(parent, "p4_l1_c0"),
      axis(parent, "p6_l2_c1"),
      { setKey: `${parent}#dca`, parentSetKey: parent, variant: "dca" },
    ]

    expect(accountRealStageInputs(input)).toEqual({
      baseInputs: 1,
      positionCountRelated: 1,
      otherRelated: 1,
      logicalEvaluated: 3,
      rawMaterialized: 4,
      baseMirrors: 1,
    })
  })
})
