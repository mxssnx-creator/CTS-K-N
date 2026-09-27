import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  aggregateHourly,
  applyHourlyStopRule,
  causalCandleWindow,
  lastCompleteUtcDayEnd,
  negativeHoursOfDayFromTrades,
  simulateSignalExit,
  summarizeHours,
  summarizeNetResults,
  walkForwardSplit,
} from "@/lib/signal-historic-eval"
import type { SignalCandle } from "@/lib/signal-source-registry"

const T0 = Date.UTC(2026, 8, 13)
const bar = (i: number, o: number, h: number, l: number, c: number): SignalCandle => ({
  timestamp: T0 + i * MINUTE_MS, open: o, high: h, low: l, close: c, volume: 1,
})

describe("historic signal eval: no lookahead", () => {
  test("causal window ends at the index and skips missing minutes", () => {
    const grid = [bar(0, 1, 1, 1, 1), null, bar(2, 2, 2, 2, 2), bar(3, 3, 3, 3, 3), bar(4, 9, 9, 9, 9)]
    const window = causalCandleWindow(grid, 3, 10)
    expect(window.map((c) => c.close)).toEqual([1, 2, 3])
    expect(window.every((c) => c.timestamp <= grid[3]!.timestamp)).toBe(true)
  })

  test("exit ignores bars after the exit and future data does not change earlier exits", () => {
    const grid = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.5, 99.9, 100.2), bar(2, 100.2, 101.2, 100, 101), bar(3, 101, 101, 90, 90)]
    const a = simulateSignalExit({ grid, entryIndex: 0, direction: "long", stopLossPct: 1, takeProfitPct: 1, maxHoldBars: 10 })
    const mutated = [...grid.slice(0, 3), bar(3, 101, 200, 1, 150)]
    const b = simulateSignalExit({ grid: mutated, entryIndex: 0, direction: "long", stopLossPct: 1, takeProfitPct: 1, maxHoldBars: 10 })
    expect(a).toEqual({ exitIndex: 2, exitPrice: 101, reason: "target" })
    expect(b).toEqual(a)
  })

  test("a bar touching both stop and target is booked as a stop", () => {
    const grid = [bar(0, 100, 100, 100, 100), bar(1, 100, 102, 98, 100)]
    const exit = simulateSignalExit({ grid, entryIndex: 0, direction: "short", stopLossPct: 1, takeProfitPct: 1, maxHoldBars: 5 })
    expect(exit).toEqual({ exitIndex: 1, exitPrice: 101, reason: "stop" })
  })

  test("gap through the stop fills at the open", () => {
    const grid = [bar(0, 100, 100, 100, 100), bar(1, 97, 97.5, 96, 97)]
    const exit = simulateSignalExit({ grid, entryIndex: 0, direction: "long", stopLossPct: 1, takeProfitPct: 5, maxHoldBars: 5 })
    expect(exit?.exitPrice).toBe(97)
  })

  test("timeout exits at the last close inside the hold window", () => {
    const grid = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.1, 99.9, 100.05), bar(2, 100, 100.1, 99.9, 99.95), bar(3, 100, 100, 50, 50)]
    const exit = simulateSignalExit({ grid, entryIndex: 0, direction: "long", stopLossPct: 1, takeProfitPct: 1, maxHoldBars: 2 })
    expect(exit).toEqual({ exitIndex: 2, exitPrice: 99.95, reason: "timeout" })
  })
})

describe("historic signal eval: aggregation", () => {
  test("summarizeNetResults computes PF, drawdown and loss streak", () => {
    const s = summarizeNetResults([1, -0.5, -0.5, 2])
    expect(s).toMatchObject({ trades: 4, wins: 2, netPct: 2, profitFactor: 3, maxDrawdownPct: 1, maxLossStreak: 2 })
  })

  test("hourly aggregation includes empty hours and attributes by exit time", () => {
    const buckets = aggregateHourly(
      [{ exitTs: T0 + 5 * MINUTE_MS, netPct: 0.3 }, { exitTs: T0 + 50 * MINUTE_MS, netPct: -0.1 }, { exitTs: T0 + 2 * HOUR_MS + 1, netPct: -0.2 }],
      T0,
      T0 + 3 * HOUR_MS,
    )
    expect(buckets.map((b) => [b.trades, b.netPct])).toEqual([[2, 0.2], [0, 0], [1, -0.2]])
    expect(summarizeHours(buckets)).toMatchObject({ hours: 3, activeHours: 2, positiveHours: 1, negativeHours: 1, positiveShareOfActive: 0.5 })
  })

  test("negative hours-of-day require a minimum trade count", () => {
    const trades = [0, 1, 2].map((i) => ({ exitTs: T0 + 3 * HOUR_MS + i, netPct: -0.1 }))
    expect(negativeHoursOfDayFromTrades(trades, 3)).toEqual([3])
    expect(negativeHoursOfDayFromTrades(trades, 4)).toEqual([])
  })
})

describe("historic signal eval: walk-forward split", () => {
  test("splits complete UTC days without overlap", () => {
    const end = Date.UTC(2026, 8, 27)
    const split = walkForwardSplit(end, 14, 7)
    expect(split.all.startMs).toBe(Date.UTC(2026, 8, 13))
    expect(split.train.endMs).toBe(split.test.startMs)
    expect(split.test.startMs).toBe(Date.UTC(2026, 8, 20))
    expect(split.test.endMs - split.test.startMs).toBe(7 * DAY_MS)
  })

  test("rejects a non-midnight end and invalid splits", () => {
    expect(() => walkForwardSplit(Date.UTC(2026, 8, 27, 1), 14, 7)).toThrow()
    expect(() => walkForwardSplit(Date.UTC(2026, 8, 27), 14, 14)).toThrow()
  })

  test("last complete UTC day end is the most recent midnight", () => {
    expect(lastCompleteUtcDayEnd(Date.UTC(2026, 8, 27, 13, 5))).toBe(Date.UTC(2026, 8, 27))
  })
})

describe("historic signal eval: hourly stop rule is causal", () => {
  const t = (entryMin: number, exitMin: number, netPct: number) => ({ entryTs: T0 + entryMin * MINUTE_MS, exitTs: T0 + exitMin * MINUTE_MS, netPct })

  test("stops the hour after the realized profit target, resumes next hour", () => {
    const kept = applyHourlyStopRule([t(0, 5, 0.3), t(10, 15, 0.2), t(61, 65, 0.1)], { profitTargetPct: 0.25 })
    expect(kept.map((x) => x.netPct)).toEqual([0.3, 0.1])
  })

  test("only trades closed before the entry count (no lookahead)", () => {
    // First trade closes after the second one opens, so its loss is unknown then.
    const kept = applyHourlyStopRule([t(0, 20, -1), t(10, 15, 0.1), t(30, 35, 0.1)], { lossLimitPct: 0.5 })
    expect(kept.map((x) => x.entryTs)).toEqual([T0, T0 + 10 * MINUTE_MS])
  })

  test("blocked hours-of-day are skipped", () => {
    const kept = applyHourlyStopRule([t(0, 5, 0.1), t(60, 65, 0.1)], { blockedHoursUtc: [1] })
    expect(kept).toHaveLength(1)
  })
})
