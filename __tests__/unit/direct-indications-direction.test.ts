import { commonMultiRangeCoordinationFor, computeDirectIndications } from "@/lib/trade-engine/direct-indications"

/**
 * Every direct indication row must carry the side it trades: the coordinator
 * resolves a row's direction from `direction`/`metadata.direction` and drops a
 * row without one. The combined Trend signal's own metadata has no side, so
 * the row has to add it.
 */
function trendInput(pricesOldestFirst: number[]) {
  const close = pricesOldestFirst[pricesOldestFirst.length - 1]
  const open = pricesOldestFirst[pricesOldestFirst.length - 2]
  return {
    symbol: "BTCUSDT",
    candles: pricesOldestFirst.map((price, index) => ({
      timestamp: Date.UTC(2026, 9, 5) + index * 60_000,
      open: index > 0 ? pricesOldestFirst[index - 1] : price,
      high: Math.max(price, index > 0 ? pricesOldestFirst[index - 1] : price),
      low: Math.min(price, index > 0 ? pricesOldestFirst[index - 1] : price),
      close: price,
      volume: 1,
    })),
    pricesOldestFirst,
    positionCostPct: 0.1,
    indicationSettings: {},
    stepIndicators: {},
    coordinatedTimeframes: [1, 5, 15, 30],
    current: { open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 },
    now: Date.UTC(2026, 9, 5, 1, 30),
  }
}

describe("direct indication rows carry their direction", () => {
  const series: Record<string, number[]> = {
    rising: Array.from({ length: 90 }, (_, index) => 100 * (1 + 0.002 * index) * (1 + 0.0005 * Math.sin(index))),
    falling: Array.from({ length: 90 }, (_, index) => 100 * (1 - 0.002 * index) * (1 + 0.0005 * Math.sin(index))),
  }

  test.each(Object.keys(series))("%s market: every row has metadata.direction, combined Trend included", (name) => {
    const { beforeSignal, afterSignal } = computeDirectIndications(trendInput(series[name]))
    const rows = [...beforeSignal, ...afterSignal]
    const combined = rows.filter((row) => row.type === "trend" && row.metadata?.combined)
    expect(combined.length).toBeGreaterThan(0)
    for (const row of rows) expect(["long", "short"]).toContain(row.metadata?.direction)
    const expected = name === "rising" ? "long" : "short"
    for (const row of combined) expect(row.metadata.direction).toBe(expected)
  })
})

describe("Auto is gated on the Common multi-range coordination", () => {
  const aligned = (direction: "long" | "short") => Object.fromEntries([1, 5, 15, 30].map((timeframe) => [
    String(timeframe),
    { summary: { direction, agreement: 0.9, strength: 0.8, signals: 6 }, indicators: {} },
  ]))

  test("a coordination that fails suppresses Auto even with aligned step indicators", () => {
    const flat = Array.from({ length: 90 }, () => 100)
    const input = { ...trendInput(flat), stepIndicators: aligned("long") }
    expect(commonMultiRangeCoordinationFor(flat, 0.1, {}).passed).toBe(false)
    const { beforeSignal } = computeDirectIndications(input)
    expect(beforeSignal.some((row) => row.type === "auto")).toBe(false)
  })

  test("a passing coordination with aligned step indicators emits Auto", () => {
    const rising = Array.from({ length: 90 }, (_, index) => 100 * (1 + 0.002 * index))
    expect(commonMultiRangeCoordinationFor(rising, 0.1, {}).passed).toBe(true)
    const { beforeSignal } = computeDirectIndications({ ...trendInput(rising), stepIndicators: aligned("long") })
    expect(beforeSignal.filter((row) => row.type === "auto").map((row) => row.metadata.direction)).toEqual(["long"])
  })
})
