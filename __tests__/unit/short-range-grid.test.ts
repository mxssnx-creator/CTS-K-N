import {
  SHORT_RANGE_GRID,
  SHORT_RANGE_TRAILING_UPDATE_RATIO,
  axisValues,
  enumerateShortRangeConfigs,
  resolveShortRangeProtection,
  shortRangeConfigKey,
  shortRangeTrailingProfile,
} from "@/lib/short-range-grid"

describe("the Short Range grid matches the operator specification", () => {
  test("each axis spans its range inclusively at its step", () => {
    expect(axisValues(SHORT_RANGE_GRID.takeProfit)).toEqual([3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75, 6])
    expect(axisValues(SHORT_RANGE_GRID.stopLossRatio)).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5])
    expect(axisValues(SHORT_RANGE_GRID.trailingStart)).toEqual([1, 1.25, 1.5, 1.75, 2])
    expect(axisValues(SHORT_RANGE_GRID.trailingStop)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7])
  })

  test("float drift never drops or duplicates a value", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; the 0.1-step axis is the one
    // that would silently lose its last value to naive accumulation.
    const stops = axisValues(SHORT_RANGE_GRID.trailingStop)
    expect(stops).toHaveLength(5)
    expect(stops[stops.length - 1]).toBe(0.7)
    expect(new Set(stops).size).toBe(stops.length)
  })

  test("the full grid is 13 x 9 x 5 x 5", () => {
    expect(enumerateShortRangeConfigs()).toHaveLength(13 * 9 * 5 * 5)
    expect(enumerateShortRangeConfigs({}, 7)).toHaveLength(7)
  })

  test("every combination has a unique, stable key", () => {
    const configs = enumerateShortRangeConfigs()
    expect(new Set(configs.map(shortRangeConfigKey)).size).toBe(configs.length)
    expect(shortRangeConfigKey({ takeProfit: 4.25, stopLossRatio: 1.5, trailingStart: 1.25, trailingStop: 0.4 }))
      .toBe("tp4.25:slr1.5:ts1.25:tstop0.4")
  })

  test("protection resolves against PositionCost, and the stop is a ratio OF the take profit", () => {
    const r = resolveShortRangeProtection({ takeProfit: 4, stopLossRatio: 2.5, trailingStart: 1.5, trailingStop: 0.4 }, 0.1)
    expect(r.takeProfitPct).toBeCloseTo(0.4, 10)
    // ratio 2.5 makes the stop WIDER than the target — a different strategy,
    // not a rescaling of the same one.
    expect(r.stopLossPct).toBeCloseTo(1.0, 10)
    expect(r.trailingStartPct).toBeCloseTo(0.6, 10)
    expect(r.trailingStopRatio).toBe(0.4)
    expect(r.trailingUpdateRatio).toBe(SHORT_RANGE_TRAILING_UPDATE_RATIO)
  })

  test("a missing or invalid PositionCost falls back to 0.1 rather than producing zero protection", () => {
    for (const bad of [0, -1, Number.NaN, undefined as any]) {
      expect(resolveShortRangeProtection({ takeProfit: 3, stopLossRatio: 1, trailingStart: 1, trailingStop: 0.3 }, bad).takeProfitPct)
        .toBeCloseTo(0.3, 10)
    }
  })

  test("the trailing profile maps onto the engine's existing shape", () => {
    const p = shortRangeTrailingProfile({ takeProfit: 4, stopLossRatio: 1, trailingStart: 1.5, trailingStop: 0.4 }, 0.1)
    // The engine carries fractions, the grid carries percentages.
    expect(p.startRatio).toBeCloseTo(0.006, 12)
    expect(p.stopRatio).toBe(0.4)
    expect(p.stepRatio).toBe(0.5)
    expect(p.tag).toBe("short-range:tp4:slr1:ts1.5:tstop0.4")
  })
})
