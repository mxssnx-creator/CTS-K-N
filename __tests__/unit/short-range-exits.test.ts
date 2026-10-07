import { bookResearchCloses, makerRoundTripPct, rangeClass, simulateExits, simulateMakerExits, type ResearchSignal } from "@/lib/short-range-exits"

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

describe("simulateMakerExits", () => {
  const maker = { entryOffsetPct: 0.1, fillWindowMinutes: 2 }
  // Long at 100, limit 99.9.

  test("a touch of the limit is not a fill; a trade-through is, at the limit", () => {
    const touch = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.1, 99.9, 100), bar(2, 100, 100.1, 99.95, 100)]
    expect(simulateMakerExits(touch, [signal(1, "long")], fixed, maker)).toMatchObject({ closes: [], placed: 1, missed: 1 })
    const through = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.1, 99.85, 99.95), bar(2, 99.95, 101.5, 99.9, 101)]
    const result = simulateMakerExits(through, [signal(1, "long")], fixed, maker)
    expect(result.closes[0]).toMatchObject({ entryPrice: 99.9, reason: "take_profit", exitLeg: "maker", exitPrice: expect.closeTo(100.899, 9) })
  })

  test("an unfilled entry expires after the window and books nothing", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.5, 100, 100.4), bar(2, 100.4, 100.8, 100.3, 100.7), bar(3, 100.7, 100.7, 99, 99.2)]
    expect(simulateMakerExits(bars, [signal(1, "long")], fixed, maker)).toMatchObject({ closes: [], placed: 1, missed: 1 })
  })

  test("on the fill bar only the stop can trigger", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101.5, 98.5, 100)]
    expect(simulateMakerExits(bars, [signal(1, "long")], fixed, maker).closes[0]).toMatchObject({ reason: "stop_loss", exitLeg: "taker" })
  })

  test("a target touch is not a maker fill; the stop exit is a taker leg", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 99.8, 99.9), bar(2, 99.9, 100.899, 99.9, 100.5), bar(3, 100.5, 100.5, 98.7, 98.8)]
    const close = simulateMakerExits(bars, [signal(1, "long")], fixed, maker).closes[0]
    expect(close).toMatchObject({ reason: "stop_loss", exitLeg: "taker" })
  })

  test("round-trip cost per leg", () => {
    const costs = { makerPct: 0.02, takerPct: 0.07 }
    expect(makerRoundTripPct({ exitLeg: "maker" }, costs)).toBeCloseTo(0.04, 12)
    expect(makerRoundTripPct({ exitLeg: "taker" }, costs)).toBeCloseTo(0.09, 12)
  })
})
