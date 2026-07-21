import {
  resolveCombinedPosCountDelta,
  resolveCombinedPosCountTargetQuantity,
} from "@/lib/pos-count-live-target"

describe("combined position-count live target", () => {
  test.each([
    [0, 0.05, { action: "increase", quantity: 0.05 }],
    [0.05, 0.15, { action: "increase", quantity: 0.1 }],
    [0.15, 0.05, { action: "reduce", quantity: 0.1 }],
    [0.05, 0.05, { action: "none", quantity: 0 }],
  ])("reconciles current=%s to target=%s", (current, target, expected) => {
    expect(resolveCombinedPosCountDelta(current, target)).toEqual(expected)
  })

  test("normalizes invalid and negative quantities without creating exposure", () => {
    expect(resolveCombinedPosCountDelta(Number.NaN, -1)).toEqual({ action: "none", quantity: 0 })
  })

  it("does not inflate a combined 0.05 ratio to one full exchange-minimum order", () => {
    expect(resolveCombinedPosCountTargetQuantity({
      calculatedVolume: 0.0005,
      finalVolume: 0.01,
      exchangeMinVolume: 0.01,
    })).toBe(0)
    expect(resolveCombinedPosCountTargetQuantity({
      calculatedVolume: 0.01,
      finalVolume: 0.01,
      exchangeMinVolume: 0.01,
    })).toBe(0.01)
    expect(resolveCombinedPosCountTargetQuantity({
      calculatedVolume: 0.015,
      finalVolume: 0.015,
      exchangeMinVolume: 0.01,
    })).toBe(0.015)
  })
})
