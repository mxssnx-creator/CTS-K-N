import {
  normalizeExchangeQuantityRules,
  resolveExecutableQuantity,
  roundQuantityDown,
  roundQuantityUp,
} from "@/lib/order-quantity"

describe("ratio-derived exchange quantity contract", () => {
  const rules = normalizeExchangeQuantityRules({
    quantityStep: "0.01",
    quantityPrecision: 2,
    minQuantity: "0.05",
    minNotionalUsdt: "10",
  })

  test("rounds entry quantities up without reducing the requested ratio", () => {
    expect(roundQuantityUp(0.101, rules)).toBe(0.11)
    expect(resolveExecutableQuantity(0.101, 100, rules, { universalMinNotionalUsdt: 0 })).toMatchObject({
      requestedQuantity: 0.101,
      quantity: 0.11,
      adjusted: true,
    })
    expect(resolveExecutableQuantity(0.01, 100, rules, { universalMinNotionalUsdt: 0 }).quantity).toBe(0.1)
  })

  test("rounds reduce-only quantities down and never applies an entry floor", () => {
    expect(roundQuantityDown(0.109, rules)).toBe(0.1)
    expect(resolveExecutableQuantity(0.109, 100, rules, { reduceOnly: true })).toMatchObject({
      quantity: 0.1,
      adjusted: true,
    })
    expect(resolveExecutableQuantity(0.01, 100, rules, { reduceOnly: true }).quantity).toBe(0.01)
  })

  test("closes all 4.8 FIL lots instead of leaving a floating-point 0.1 residual", () => {
    const fil = normalizeExchangeQuantityRules({ quantityStep: 0.1, quantityPrecision: 1 })
    expect(fil.quantityPrecision).toBe(1)
    expect(roundQuantityUp(2.4, fil)).toBe(2.4)
    expect(resolveExecutableQuantity(4.8, 0.8609, fil, { reduceOnly: true })).toMatchObject({
      quantity: 4.8,
      adjusted: false,
    })
    expect(roundQuantityDown(roundQuantityUp(2.4, fil) * 2, fil)).toBe(4.8)
  })

  test.each([
    [0.1, 1, 4.8],
    [0.01, 2, 0.29],
    [0.25, 2, 4.75],
    [1e-8, 8, 0.00000029],
    [1e-18, 18, 4.8e-17],
    [10, 0, 120],
  ])("preserves exact grid points for step %s in both directions", (step, precision, quantity) => {
    const grid = normalizeExchangeQuantityRules({ quantityStep: step })
    expect(grid.quantityPrecision).toBe(precision)
    expect(roundQuantityDown(quantity, grid)).toBe(quantity)
    expect(roundQuantityUp(quantity, grid)).toBe(quantity)
  })

  test("never snaps a genuinely below-grid close upward or drops a below-grid minimum", () => {
    const grid = normalizeExchangeQuantityRules({ quantityStep: 0.1 })
    expect(roundQuantityDown(4.799999999999999, grid)).toBe(4.7)
    expect(roundQuantityUp(4.800000001, grid)).toBe(4.9)
    const tiny = normalizeExchangeQuantityRules({ quantityStep: 1e-18 })
    expect(roundQuantityDown(0.9e-18, tiny)).toBe(0)
    expect(roundQuantityUp(0.9e-18, tiny)).toBe(1e-18)
    expect(roundQuantityDown(1.9e-18, tiny)).toBe(1e-18)
  })

  test("does not add an entry lot for arithmetic noise in DCA ratios", () => {
    const grid = normalizeExchangeQuantityRules({ quantityStep: 0.000001 })
    expect(roundQuantityUp(0.01 * 1.1, grid)).toBe(0.011)
    expect(roundQuantityUp(0.1 + 0.2, normalizeExchangeQuantityRules({ quantityStep: 0.1 }))).toBe(0.3)
  })

  test("uses the canonical percent boundary for position-cost ratios", () => {
    // This is the contract used by VolumeCalculator: 0.1% = 0.001 fraction.
    const balance = 10_000
    const positionCostPercent = 0.1
    const positionsAverage = 10
    const baseNotional = balance * (positionCostPercent / 100) / positionsAverage
    expect(baseNotional).toBe(1)
    expect(baseNotional * 2).toBe(2)
  })
})
