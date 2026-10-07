import { computeDirectIndications } from "@/lib/trade-engine/direct-indications"

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
