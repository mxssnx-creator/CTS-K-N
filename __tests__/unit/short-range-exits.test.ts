import { bookResearchCloses, rangeClass, simulateExits, type ResearchSignal } from "@/lib/short-range-exits"

/**
 * The research exit evaluator follows the per-type measurement's rules
 * (lib/trade-engine/prehistoric-type-replay.ts settleExits) so a
 * configuration's research result is what the measurement would book.
 */
const T0 = Date.parse("2026-09-22T00:00:00Z")
const bar = (minute: number, open: number, high: number, low: number, close: number) =>
  ({ timestamp: T0 + minute * 60_000, open, high, low, close, volume: 1 })
const signal = (minute: number, direction: "long" | "short", price = 100): ResearchSignal =>
  ({ type: "move", direction, rule: "default", entryTime: T0 + minute * 60_000, entryPrice: price, profitFactor: 1.2 })
const fixed = { takeProfitPct: 1, stopLossPct: 1, maxHoldMs: 240 * 60_000 }

describe("simulateExits", () => {
  test("the entry bar never exits; the next bar does, at the level", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101.5, 99.8, 101)]
    // Signal at the close of bar 0 (minute 1).
    expect(simulateExits(bars, [signal(1, "long")], fixed)).toEqual([
      expect.objectContaining({ reason: "take_profit", exitPrice: 101, grossPct: expect.closeTo(1, 9) }),
    ])
  })

  test("a bar touching both levels is a stop", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101.5, 98.5, 100)]
    expect(simulateExits(bars, [signal(1, "long")], fixed)[0]).toMatchObject({ reason: "stop_loss", exitPrice: 99 })
  })

  test("a bar opening beyond the stop exits at its open", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 98, 98.5, 97, 98)]
    expect(simulateExits(bars, [signal(1, "long")], fixed)[0]).toMatchObject({ reason: "stop_loss", exitPrice: 98 })
  })

  test("one open position per type, direction and rule", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.2, 99.9, 100), bar(2, 100, 101.2, 99.9, 101)]
    const closes = simulateExits(bars, [signal(1, "long"), signal(2, "long"), signal(2, "short")], fixed)
    expect(closes.filter((close) => close.direction === "long")).toHaveLength(1)
  })

  test("max hold closes at the bar close", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.2, 99.9, 100.1), bar(2, 100.1, 100.2, 99.9, 100.05)]
    expect(simulateExits(bars, [signal(1, "short")], { ...fixed, maxHoldMs: 2 * 60_000 })[0])
      .toMatchObject({ reason: "max_hold", exitPrice: 100.05 })
  })

  test("trailing arms at the start move and gives back the configured share", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 102, 99.9, 101.9), bar(2, 101.9, 101.95, 100.9, 101)]
    const closes = simulateExits(bars, [signal(1, "long")], { ...fixed, trailingStartPct: 1, trailingStopRatio: 0.5 })
    // Best 102 → trail 101; bar 2 trades through it.
    expect(closes[0]).toMatchObject({ reason: "trailing_stop", exitPrice: 101 })
  })

  test("books net after the round-trip cost and classifies ranges", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101.5, 99.8, 101)]
    const book = bookResearchCloses(simulateExits(bars, [signal(1, "long")], fixed), 0.1)
    expect(book).toMatchObject({ trades: 1, wins: 1, profitFactor: Number.POSITIVE_INFINITY })
    expect(book.netPct).toBeCloseTo(0.9, 9)
    expect([0.15, 0.25, 0.4, 0.8, 1.6].map((tp) => rangeClass(tp, 0.1))).toEqual(["micro", "minimum", "short", "general", "long"])
  })
})
