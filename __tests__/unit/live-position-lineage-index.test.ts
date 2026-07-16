import { getLivePositionSetLineageKeys } from "@/lib/live-position-lineage"

describe("live position Set-lineage index", () => {
  test("keeps primary, parent, and every confirmed accumulation active", () => {
    const keys = getLivePositionSetLineageKeys({
      setKey: "BTCUSDT:move:long#axis:p4_l1_c1",
      parentSetKey: "BTCUSDT:move:long",
      accumulatedSetKeys: [
        "BTCUSDT:move:long#axis:p4_l1_c1",
        "BTCUSDT:move:long#block:2",
        "BTCUSDT:move:long#dca:1",
      ],
    })

    expect(new Set(keys)).toEqual(new Set([
      "BTCUSDT:move:long",
      "BTCUSDT:move:long#axis:p4_l1_c1",
      "BTCUSDT:move:long#block:2",
      "BTCUSDT:move:long#dca:1",
    ]))
  })

  test("drops blank and duplicate lineage values", () => {
    expect(getLivePositionSetLineageKeys({
      setKey: "ETHUSDT:trend:short",
      parentSetKey: "ETHUSDT:trend:short",
      accumulatedSetKeys: ["", "ETHUSDT:trend:short"],
    })).toEqual(["ETHUSDT:trend:short"])
  })
})
