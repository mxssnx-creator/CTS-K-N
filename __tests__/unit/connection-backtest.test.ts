import {
  aggregateBacktest,
  applyBaseGate,
  backtestRoundTripPct,
  backtestTradesForSymbol,
  BACKTEST_HOURS,
  normalizeBacktestHours,
  normalizeBacktestRequest,
  type BacktestTrade,
} from "@/lib/connection-backtest"

/**
 * Connection backtest (settings dialog → Backtest): range 5–75 h in steps of
 * 5, default 15; market or maker execution; every figure of the detailed
 * statistics dialog comes from aggregateBacktest.
 */
const T0 = Date.parse("2026-10-07T00:00:00Z")
const H = 3_600_000

describe("backtest request", () => {
  test("the range is 5–75 hours in steps of 5, default 15", () => {
    expect(BACKTEST_HOURS).toEqual({ min: 5, max: 75, step: 5, default: 15 })
    expect([undefined, "x", 0, 3, 7, 8, 15, 74, 75, 200].map(normalizeBacktestHours)).toEqual([15, 15, 5, 5, 5, 10, 15, 75, 75, 75])
  })

  test("mode, execution and symbols are normalised", () => {
    // Base-gated is the default; "All signals" only when asked for.
    expect(normalizeBacktestRequest({})).toEqual({ hours: 15, mode: "gated", execution: "market" })
    expect(normalizeBacktestRequest({ mode: "signals" }).mode).toBe("signals")
    expect(normalizeBacktestRequest({ hours: 40, mode: "gated", execution: "maker", symbols: ["btcusdt", "BTCUSDT", "eth-usdt", ""] }))
      .toEqual({ hours: 40, mode: "gated", execution: "maker", symbols: ["BTCUSDT", "ETHUSDT"] })
    // The former "pipeline" choice maps to the Base-gated mode.
    expect(normalizeBacktestRequest({ mode: "pipeline" }).mode).toBe("gated")
    expect(normalizeBacktestRequest({ symbols: Array.from({ length: 50 }, (_, i) => `S${i}USDT`) }).symbols).toHaveLength(30)
  })

  test("market pays taker on both legs; maker pays maker on entry and a resting TP", () => {
    expect(backtestRoundTripPct("market", "maker")).toBeCloseTo(0.16, 12)
    expect(backtestRoundTripPct("market", "taker")).toBeCloseTo(0.16, 12)
    expect(backtestRoundTripPct("maker", "maker")).toBeCloseTo(0.04, 12)
    expect(backtestRoundTripPct("maker", "taker")).toBeCloseTo(0.1, 12)
  })
})

const trade = (overrides: Partial<BacktestTrade>): BacktestTrade => ({
  symbol: "BTCUSDT", type: "move", direction: "long", rule: "default", entryTime: T0, exitTime: T0 + 10 * 60_000,
  entryPrice: 100, exitPrice: 100.5, takeProfitPct: 0.5, stopLossPct: 0.6, grossPct: 0.5, costPct: 0.16, netPct: 0.34,
  reason: "take_profit", exitLeg: "taker", rangeClass: "short", ...overrides,
})

describe("aggregateBacktest", () => {
  const trades = [
    trade({ exitTime: T0 + 10 * 60_000, netPct: 0.34 }),
    trade({ symbol: "ETHUSDT", type: "trend", exitTime: T0 + 70 * 60_000, netPct: -0.76, grossPct: -0.6, reason: "stop_loss", direction: "short" }),
    trade({ exitTime: T0 + 130 * 60_000, netPct: 0.2, rangeClass: "general" }),
  ]
  const result = aggregateBacktest({
    connectionId: "bingx-x01", mode: "signals", execution: "market", hours: 3, fromMs: T0, toMs: T0 + 3 * H,
    positionCostPct: 0.1, trades, symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  })

  test("summary, equity and drawdown", () => {
    expect(result.summary).toMatchObject({ trades: 3, wins: 2, losses: 1, activeHours: 3, profitableHours: 2 })
    expect(result.summary.netPct).toBeCloseTo(-0.22, 12)
    expect(result.summary.profitFactor).toBeCloseTo(0.54 / 0.76, 12)
    expect(result.summary.maxDrawdownPct).toBeCloseTo(0.76, 12)
    expect(result.equity.map((point) => Number(point.equityPct.toFixed(2)))).toEqual([0, 0.34, -0.42, -0.22])
    expect(result.equity.map((point) => Number(point.drawdownPct.toFixed(2)))).toEqual([0, 0, -0.76, -0.56])
  })

  test("hours, symbols in basket order, range classes in class order", () => {
    expect(result.byHour.map((hour) => hour.trades)).toEqual([1, 1, 1])
    expect(result.bySymbol.map((row) => [row.key, row.trades])).toEqual([["BTCUSDT", 2], ["ETHUSDT", 1], ["SOLUSDT", 0]])
    expect(result.byRangeClass.map((row) => [row.key, row.trades])).toEqual([["micro", 0], ["minimum", 0], ["short", 2], ["general", 1], ["long", 0]])
    expect(result.byDirection.map((row) => [row.key, row.trades])).toEqual([["long", 2], ["short", 1]])
  })

  test("heatmaps: symbol × hour and type × hour", () => {
    expect(result.heatmapSymbolHour.rows).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"])
    expect(result.heatmapSymbolHour.cols).toEqual([T0, T0 + H, T0 + 2 * H])
    expect(result.heatmapSymbolHour.cells.map((row) => row.map((cell) => cell.trades))).toEqual([[1, 0, 1], [0, 1, 0], [0, 0, 0]])
    expect(result.heatmapTypeHour.rows).toEqual(["move", "trend"])
  })

  test("a run without losses has no finite PF; without trades nothing is invented", () => {
    const winners = aggregateBacktest({ connectionId: "c", mode: "signals", execution: "market", hours: 5, fromMs: T0, toMs: T0 + 5 * H, positionCostPct: 0.1, trades: [trade({})], symbols: ["BTCUSDT"] })
    expect(winners.summary.profitFactor).toBeNull()
    const empty = aggregateBacktest({ connectionId: "c", mode: "signals", execution: "market", hours: 5, fromMs: T0, toMs: T0 + 5 * H, positionCostPct: 0.1, trades: [], symbols: ["BTCUSDT"] })
    expect(empty.summary).toMatchObject({ trades: 0, profitFactor: null, winRate: null, maxDrawdownPct: 0 })
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty)
  })
})

describe("backtestTradesForSymbol", () => {
  const bar = (minute: number, open: number, high: number, low: number, close: number) =>
    ({ timestamp: T0 + minute * 60_000, open, high, low, close, volume: 1 })
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.1, 99.85, 99.95), bar(2, 99.95, 100.7, 99.9, 100.6)]
  const signals = [{ type: "move", direction: "long" as const, rule: "default", entryTime: T0 + 60_000, entryPrice: 100, profitFactor: 1.2, takeProfitPct: 0.5, stopLossPct: 0.6 }]

  test("market: the row's own TP, taker legs", () => {
    const { trades } = backtestTradesForSymbol({ symbol: "BTCUSDT", bars, signals, execution: "market", positionCostPct: 0.1, fromMs: T0 })
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ reason: "take_profit", exitPrice: expect.closeTo(100.5, 9), costPct: expect.closeTo(0.16, 12), rangeClass: "short", exitLeg: "taker" })
    expect(trades[0].netPct).toBeCloseTo(0.5 - 0.16, 9)
  })

  test("maker: filled on the trade-through, resting TP is a maker leg", () => {
    const { trades, placed, missed } = backtestTradesForSymbol({ symbol: "BTCUSDT", bars, signals, execution: "maker", positionCostPct: 0.1, fromMs: T0 })
    expect({ placed, missed }).toEqual({ placed: 1, missed: 0 })
    expect(trades[0]).toMatchObject({ reason: "take_profit", exitLeg: "maker", costPct: expect.closeTo(0.04, 12) })
  })
})

describe("applyBaseGate", () => {
  // Measured closes: gross 0.5 % at PositionCost 0.1 → net 0.4 → ratio 1.4; gross -0.6 → ratio 0.3.
  const close = (minute: number, grossPct: number, profitFactor = 1.5): BacktestTrade =>
    trade({ entryTime: T0 + minute * 60_000, exitTime: T0 + (minute + 5) * 60_000, grossPct, profitFactor })

  test("needs 5 measured closes in the bucket before the entry", () => {
    const winners = Array.from({ length: 6 }, (_, i) => close(i * 10, 0.5))
    const { admitted, measuredReady } = applyBaseGate(winners, 0.1)
    // Only the 6th entry (minute 50) sees 5 closes finished before it.
    expect(measuredReady).toBe(1)
    expect(admitted.map((t) => t.entryTime)).toEqual([T0 + 50 * 60_000])
  })

  test("min(row PF, PositionCost ratio) must reach the stage PF", () => {
    const losers = [...Array.from({ length: 5 }, (_, i) => close(i * 10, -0.6)), close(60, 0.5)]
    expect(applyBaseGate(losers, 0.1).admitted).toHaveLength(0)
    const weakRow = [...Array.from({ length: 5 }, (_, i) => close(i * 10, 0.5)), close(60, 0.5, 1.05)]
    expect(applyBaseGate(weakRow, 0.1).admitted).toHaveLength(0)
  })

  test("buckets are separate per symbol, type and direction", () => {
    const btc = Array.from({ length: 5 }, (_, i) => close(i * 10, 0.5))
    const eth = { ...close(60, 0.5), symbol: "ETHUSDT" }
    expect(applyBaseGate([...btc, eth], 0.1).admitted).toHaveLength(0)
  })
})
