import { getLivePositionSource, isSimulatedPosition } from "@/lib/live-position-source"
import {
  computePositionBookStats,
  emptyPositionBookStats,
  mergePositionBookStats,
  positionBookRowState,
  splitPositionBookStats,
} from "@/lib/position-book-stats"

const h = (hour: number) => Date.UTC(2026, 8, 27, hour, 5, 0)

function closed(pnl: number, extra: Record<string, unknown> = {}) {
  return {
    status: "closed",
    symbol: "BTCUSDT",
    executedQuantity: 1,
    totalExecutedQuantity: 1,
    entryPrice: 100,
    realizedPnL: pnl,
    closedAt: h(1),
    ...extra,
  }
}

function open(extra: Record<string, unknown> = {}) {
  return {
    status: "open",
    symbol: "ETHUSDT",
    executedQuantity: 2,
    entryPrice: 50,
    unrealizedPnL: 1.5,
    ...extra,
  }
}

describe("isSimulatedPosition predicate", () => {
  test.each([
    [{ status: "simulated" }, true],
    [{ executionMode: "simulation" }, true],
    [{ mode: "paper" }, true],
    [{ isPaper: true }, true],
    [{ exchange: "simulated", executionMode: "live" }, true],
    [{ orderId: "sim-1727000000-42", executionMode: "live" }, true],
    [{ exchangeData: { orderId: "SIM-1" } }, true],
    [{ executionMode: "live", orderId: "987654" }, false],
    [{ status: "open" }, false],
    [null, false],
  ])("%o -> %s", (position, expected) => {
    expect(isSimulatedPosition(position as any)).toBe(expected)
  })

  test("simulated-connector ids never classify as real", () => {
    expect(getLivePositionSource({ executionMode: "live", orderId: "sim-1" })).toBe("simulated")
  })
})

describe("computePositionBookStats", () => {
  test("empty set yields zeros, never NaN", () => {
    const book = emptyPositionBookStats()
    for (const [key, value] of Object.entries(book)) {
      if (typeof value === "number") expect({ key, finite: Number.isFinite(value) }).toEqual({ key, finite: true })
    }
    expect(book).toMatchObject({ total: 0, open: 0, closed: 0, winRate: 0, profitFactor: null, profitFactorUnbounded: false, maxDrawdown: 0 })
  })

  test("profit factor with zero losses is unbounded, not Infinity", () => {
    const book = computePositionBookStats([closed(3), closed(2, { closedAt: h(2) })])
    expect(book.profitFactor).toBeNull()
    expect(book.profitFactorUnbounded).toBe(true)
    expect(book.winRate).toBe(100)
    expect(JSON.stringify(book)).not.toContain("Infinity")
  })

  test("aggregates counts, PnL, fees, PF, drawdown and buckets", () => {
    const rows = [
      closed(10, { closedAt: h(1), fees: 0.5 }),
      closed(-4, { closedAt: h(2), fees: 0.25, symbol: "ETHUSDT" }),
      closed(-2, { closedAt: h(3) }),
      closed(0, { closedAt: h(4) }),
      open(),
      { status: "pending", symbol: "XRPUSDT", executedQuantity: 0, quantity: 5 },
    ]
    const book = computePositionBookStats(rows)
    expect(book).toMatchObject({
      total: 5,
      open: 1,
      closed: 4,
      settledClosed: 4,
      wins: 1,
      losses: 2,
      breakEven: 1,
      grossProfit: 10,
      grossLoss: 6,
      netPnl: 4,
      fees: 0.75,
      grossPnl: 4.75,
      unrealizedPnl: 1.5,
      totalPnl: 5.5,
      avgWin: 10,
      avgLoss: -3,
      largestWin: 10,
      largestLoss: -4,
      maxDrawdown: 6,
      openNotionalUsd: 100,
      openSymbols: 1,
    })
    expect(book.profitFactor).toBeCloseTo(10 / 6, 6)
    expect(book.winRate).toBeCloseTo(33.3333, 3)
    expect(book.bySymbol.BTCUSDT).toMatchObject({ closed: 3, wins: 1, losses: 1, netPnl: 8 })
    expect(book.bySymbol.ETHUSDT).toMatchObject({ open: 1, closed: 1, losses: 1, netPnl: -4 })
    expect(book.byHour["2"]).toMatchObject({ closed: 1, netPnl: -4 })
    expect(positionBookRowState(rows[5])).toBeNull()
  })
})

describe("splitPositionBookStats keeps real and simulated independent", () => {
  const real = [
    closed(5, { executionMode: "live", orderId: "111" }),
    closed(-1, { executionMode: "live", orderId: "112", closedAt: h(2) }),
    open({ executionMode: "live", orderId: "113" }),
  ]
  const simulated = [
    closed(100, { status: "closed", executionMode: "simulation" }),
    closed(-50, { executionMode: "live", orderId: "sim-1", closedAt: h(3) }),
    open({ status: "simulated" }),
    open({ status: "simulated", symbol: "SOLUSDT" }),
  ]

  test("mixed fixtures produce separate correct numbers", () => {
    const split = splitPositionBookStats([...real, ...simulated])
    expect(split.real).toMatchObject({ open: 1, closed: 2, wins: 1, losses: 1, netPnl: 4, profitFactor: 5 })
    expect(split.simulated).toMatchObject({ open: 2, closed: 2, wins: 1, losses: 1, netPnl: 50, profitFactor: 2, openSymbols: 2 })
    expect(split.unknown.total).toBe(0)
  })

  test("merge sums books and tolerates missing entries", () => {
    const a = computePositionBookStats(simulated)
    const merged = mergePositionBookStats([a, undefined, null, a])
    expect(merged).toMatchObject({ open: 4, closed: 4, wins: 2, losses: 2, netPnl: 100, profitFactor: 2 })
    expect(mergePositionBookStats([])).toEqual(emptyPositionBookStats())
  })
})
