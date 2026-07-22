import {
  buildLiveTradingAnalytics,
  calculateDrawdownTime,
  calculateProfitFactorMetric,
} from "@/lib/live-trading-analytics"
import type { TradeHistoryRow } from "@/lib/trade-history"

const NOW = Date.UTC(2026, 6, 23, 12, 0, 0)

function row(id: string, pnl: number, hoursAgo: number): TradeHistoryRow {
  return {
    id,
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 100 + pnl,
    quantity: 1,
    volumeUsd: 100,
    grossPnl: pnl,
    fees: 0,
    realizedPnl: pnl,
    pnlPct: pnl,
    openedAt: NOW - hoursAgo * 60 * 60 * 1000 - 60_000,
    closedAt: NOW - hoursAgo * 60 * 60 * 1000,
    holdMinutes: 1,
    source: "local",
  }
}

describe("live trading analytics", () => {
  test("calculates standard gross-profit / gross-loss profit factor", () => {
    expect(calculateProfitFactorMetric([row("a", 12, 1), row("b", -4, 2), row("c", 8, 3)])).toMatchObject({
      trades: 3,
      wins: 2,
      losses: 1,
      grossProfit: 20,
      grossLoss: 4,
      netPnl: 16,
      profitFactor: 5,
      infinite: false,
    })
  })

  test("keeps loss-free profit factor JSON-safe", () => {
    expect(calculateProfitFactorMetric([row("a", 2, 1)])).toMatchObject({
      profitFactor: null,
      infinite: true,
    })
  })

  test("builds the requested time and last-position windows", () => {
    const rows = [
      row("1", 3, 1),
      row("2", -1, 3),
      row("3", 5, 8),
      row("4", -2, 20),
      row("5", 4, 40),
      row("old", 10, 60),
    ]
    const analytics = buildLiveTradingAnalytics(rows, NOW)

    expect(analytics.timeWindows["4h"].trades).toBe(2)
    expect(analytics.timeWindows["12h"].trades).toBe(3)
    expect(analytics.timeWindows["48h"].trades).toBe(5)
    expect(analytics.orderWindows).toEqual({ "4h": 2, "24h": 4, "48h": 5 })
    expect(analytics.positionWindows["25"].trades).toBe(6)
    expect(analytics.positionWindows["75"].trades).toBe(6)
    expect(analytics.positionWindows["150"].trades).toBe(6)
  })

  test("reports recovered and current drawdown durations inside five days", () => {
    const recovered = calculateDrawdownTime([
      row("peak", 10, 10),
      row("drop", -5, 8),
      row("recovery", 6, 4),
    ], NOW, 5)
    expect(recovered).toMatchObject({
      episodes: 1,
      inDrawdown: false,
      currentDurationMs: 0,
      maxDurationMs: 4 * 60 * 60 * 1000,
      maxDepth: 5,
    })

    const current = calculateDrawdownTime([
      row("peak", 10, 10),
      row("drop", -7, 2),
    ], NOW, 5)
    expect(current).toMatchObject({
      episodes: 1,
      inDrawdown: true,
      currentDurationMs: 2 * 60 * 60 * 1000,
      currentDepth: 7,
    })
  })
})
