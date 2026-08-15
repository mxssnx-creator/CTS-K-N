import { analyzeSecondHistoryCoverage } from "@/lib/market-data-loader"

const denseCandles = (count: number, endMs: number) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: endMs - (count - 1 - index) * 1_000,
  }))

describe("1-second historic coverage", () => {
  test("accepts a dense recent stage window", () => {
    const now = 1_800_000_000_000
    const result = analyzeSecondHistoryCoverage(
      denseCandles(5_400, now - 1_000),
      5_400,
      now,
    )

    expect(result.complete).toBe(true)
    expect(result.uniqueSeconds).toBe(5_400)
    expect(result.densityRatio).toBe(1)
  })

  test("rejects the same nominal count when public-trade buckets span several hours", () => {
    const now = 1_800_000_000_000
    const sparse = Array.from({ length: 5_400 }, (_, index) => ({
      timestamp: now - 1_000 - (5_399 - index) * 3_000,
    }))
    const result = analyzeSecondHistoryCoverage(sparse, 5_400, now)

    expect(result.uniqueSeconds).toBe(5_400)
    expect(result.densityRatio).toBeLessThan(0.34)
    expect(result.complete).toBe(false)
  })

  test("rejects a dense cache that no longer reaches the realtime tail", () => {
    const now = 1_800_000_000_000
    const result = analyzeSecondHistoryCoverage(
      denseCandles(5_400, now - 10 * 60_000),
      5_400,
      now,
    )

    expect(result.densityRatio).toBe(1)
    expect(result.latestAgeMs).toBe(10 * 60_000)
    expect(result.complete).toBe(false)
  })
})
