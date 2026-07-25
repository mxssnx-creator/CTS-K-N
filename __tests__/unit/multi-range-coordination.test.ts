import {
  calculateMultiRangeCoordination,
  DEFAULT_MAIN_COORDINATION_SETTINGS,
} from "@/lib/multi-range-coordination"

const config = {
  ...DEFAULT_MAIN_COORDINATION_SETTINGS,
  timeframesMinutes: [2, 3, 5],
  rangeSteps: [0.5, 1],
  drawdownRatios: [1],
  higherRangeDrawdownScale: 0.5,
  minAgreement: 0.6,
  minimumSignals: 2,
  shortDifferenceRatio: 0.1,
}

describe("default indication relative-range coordination", () => {
  test("calculates every matured range only inside the new regime after a reversal", () => {
    const result = calculateMultiRangeCoordination({
      pricesOldestFirst: [
        100.3, 100.2, 100.1, 100,
        100.02, 100.04, 100.06, 100.08, 100.1, 100.12,
      ],
      positionCostPct: 0.01,
      config,
      requireDirectionChange: true,
      rangeUnit: "samples",
    })

    expect(result.rangeUnit).toBe("samples")
    expect(result.direction).toBe("long")
    expect(result.passed).toBe(true)
    expect(result.situations.map((situation) => situation.range)).toEqual([2, 3, 5])
    expect(result.situations.every((situation) =>
      situation.directionChanged &&
      situation.direction === "long" &&
      situation.valid &&
      situation.postChangeSamples === situation.range + 1,
    )).toBe(true)
  })

  test("does not create the additional post-change Direction signal without a reversal", () => {
    const result = calculateMultiRangeCoordination({
      pricesOldestFirst: [100, 100.02, 100.04, 100.06, 100.08, 100.1, 100.12],
      positionCostPct: 0.01,
      config,
      requireDirectionChange: true,
      rangeUnit: "samples",
    })

    expect(result.passed).toBe(false)
    expect(result.situations.every((situation) => !situation.directionChanged)).toBe(true)
  })

  test("keeps the original independent Direction/Move/Active calculation available", () => {
    const result = calculateMultiRangeCoordination({
      pricesOldestFirst: [100, 100.02, 100.04, 100.06, 100.08, 100.1, 100.12],
      positionCostPct: 0.01,
      config,
      requireDirectionChange: false,
      rangeUnit: "samples",
    })

    expect(result.direction).toBe("long")
    expect(result.passed).toBe(true)
    expect(result.situations.every((situation) => situation.valid)).toBe(true)
  })

  test("widens PositionCost-relative drawdown allowance for higher ranges", () => {
    const result = calculateMultiRangeCoordination({
      pricesOldestFirst: [
        101, 100.5, 100,
        100.05, 100.1, 100.15, 100.2, 100.25, 100.3,
      ],
      positionCostPct: 0.01,
      config,
      requireDirectionChange: true,
      rangeUnit: "samples",
    })

    const shortest = result.situations.find((situation) => situation.range === 2)
    const longest = result.situations.find((situation) => situation.range === 5)
    expect(shortest).toBeDefined()
    expect(longest).toBeDefined()
    expect(longest!.allowedDrawdownRatio).toBeGreaterThan(shortest!.allowedDrawdownRatio)
  })
})
