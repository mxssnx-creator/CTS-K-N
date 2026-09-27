import { extendSyntheticCandles, generateSyntheticCandles } from "@/lib/market-data-loader"

describe("synthetic paper market continuation", () => {
  test("continues a stale synthetic series from its last close up to now", () => {
    const now = Date.now()
    const seed = generateSyntheticCandles("BCHUSDT", 100, 600, 1_000).map((candle) => ({
      ...candle,
      timestamp: Number(candle.timestamp) - 120_000,
    }))
    const last = seed[seed.length - 1]
    const extended = extendSyntheticCandles("BCHUSDT", seed, 1_000, 600, now)

    expect(extended).toHaveLength(600)
    const tail = extended[extended.length - 1]
    expect(Number(tail.timestamp)).toBeGreaterThan(Number(last.timestamp))
    expect(Number(tail.timestamp)).toBeLessThanOrEqual(now)
    // Strictly increasing timestamps across the join.
    for (let index = 1; index < extended.length; index++) {
      expect(Number(extended[index].timestamp)).toBeGreaterThan(Number(extended[index - 1].timestamp))
    }
    const joinIndex = extended.findIndex((candle) => Number(candle.timestamp) > Number(last.timestamp))
    expect(extended[joinIndex].open).toBe(last.close)
  })

  test("returns the input unchanged when it is already current", () => {
    const seed = generateSyntheticCandles("BCHUSDT", 100, 10, 1_000)
    const lastTs = Number(seed[seed.length - 1].timestamp)
    expect(extendSyntheticCandles("BCHUSDT", seed, 1_000, 10, lastTs + 500)).toBe(seed)
  })
})
