import { dedupeCanonicalStrategySets } from "@/lib/strategy-coordinator"

describe("MAIN canonical Set deduplication", () => {
  it("collapses retry clones by their complete set key before variant fan-out", () => {
    const first = { setKey: "BTCUSDT:trend:long:cfg:fast", marker: "canonical" }
    const retryClone = { setKey: "BTCUSDT:trend:long:cfg:fast", marker: "retry" }
    const independent = { setKey: "BTCUSDT:trend:long:cfg:slow", marker: "independent" }

    const result = dedupeCanonicalStrategySets([first, retryClone, independent])

    expect(result.collapsed).toBe(1)
    expect(result.sets).toEqual([first, independent])
  })

  it("preserves distinct derived axis identities and unkeyed invalid rows", () => {
    const defaultSet = { setKey: "BTCUSDT:trend:long:cfg:fast#default" }
    const axisOne = { setKey: "BTCUSDT:trend:long:cfg:fast#axis:p4_l1_c1_olong" }
    const axisTwo = { setKey: "BTCUSDT:trend:long:cfg:fast#axis:p6_l1_c1_olong" }
    const invalid = { setKey: "" }

    const result = dedupeCanonicalStrategySets([defaultSet, axisOne, axisTwo, invalid])

    expect(result.collapsed).toBe(0)
    expect(result.sets).toEqual([defaultSet, axisOne, axisTwo, invalid])
  })
})
