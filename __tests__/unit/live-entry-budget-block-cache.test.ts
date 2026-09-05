import { LiveEntryBudgetBlockCache } from "@/lib/live-entry-budget-block-cache"
import { VolumeCalculator } from "@/lib/volume-calculator"

describe("fresh-entry budget admission", () => {
  const proof = {
    marketType: "crypto", finalQuantity: 0, ceiling: 0.57,
    universalMinimum: 5, balanceIsFallback: false, reason: "Budget below minimum",
  }

  test("a measured 300-position budget stays blocked even for a large variant", () => {
    const result = VolumeCalculator.calculatePositionVolume({
      accountBalance: 34_200, currentPrice: 60_000, positionCostPercent: 0.1,
      positionsAverage: 300, leverage: 1, exchangeMinVolume: 0,
      tradeMode: "main", mainVolumeFactor: 10, sizeMultiplier: 500,
      allowUnboundedVariantMultiplier: true,
    })
    expect(result.maxExecutionNotionalUsd).toBeCloseTo(0.57, 10)
    expect(result.exchangeMinNotionalUsd).toBeGreaterThanOrEqual(5)
    expect(result.finalVolume).toBe(0)
    const cache = new LiveEntryBudgetBlockCache()
    expect(cache.remember("x02:settings1", {
      ...proof, ceiling: result.maxExecutionNotionalUsd!, finalQuantity: result.finalVolume!,
    }, 100)).toBe(true)
    expect(cache.get("x02:settings1", 1099)?.ceiling).toBeCloseTo(0.57, 10)
    expect(cache.get("x02:settings1", 1100)).toBeNull()
    expect(cache.get("x01:settings1", 101)).toBeNull()
    expect(cache.get("x02:settings2", 101)).toBeNull()
  })

  test.each([
    { marketType: "forex" }, { balanceIsFallback: true }, { finalQuantity: 1 },
    { ceiling: 5 }, { ceiling: 10 }, { ceiling: 0 }, { ceiling: Number.NaN },
  ])("does not cache a non-authoritative or price-dependent refusal: %j", (override) => {
    const cache = new LiveEntryBudgetBlockCache()
    expect(cache.remember("scope", { ...proof, ...override })).toBe(false)
    expect(cache.get("scope")).toBeNull()
  })

  test("retained refusals are bounded without admitting any new order", () => {
    const cache = new LiveEntryBudgetBlockCache(1000, 2)
    for (const key of ["a", "b", "c"]) cache.remember(key, proof, 100)
    expect(cache.get("a", 101)).toBeNull()
    expect(cache.get("b", 101)).not.toBeNull()
    expect(cache.get("c", 101)).not.toBeNull()
  })
})
