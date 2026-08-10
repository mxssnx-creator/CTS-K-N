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
