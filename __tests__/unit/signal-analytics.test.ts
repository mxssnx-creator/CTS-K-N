import {
  buildSignalAnalyticsWindows,
  buildSignalSymbolRankings,
  calculateSignalWindowMetric,
  type SignalAnalyticsTrade,
} from "@/lib/signal-analytics"

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0)

function trade(
  id: string,
  symbol: string,
  pnl: number,
  hoursAgo: number,
  lane: "default" | "signal_trailing" = "default",
): SignalAnalyticsTrade {
  return {
    id,
    connectionId: "conn-a",
    symbol,
    direction: "long",
    sourceIds: ["binance-usdm"],
    openedAt: NOW - hoursAgo * 60 * 60 * 1000 - 15 * 60 * 1000,
    closedAt: NOW - hoursAgo * 60 * 60 * 1000,
    realizedPnl: pnl,
    stopLossPct: lane === "signal_trailing" ? 0.8 : 0.4,
    takeProfitPct: lane === "signal_trailing" ? 1.6 : 1.2,
    executionLane: lane,
    setVariant: lane === "signal_trailing" ? "trailing" : "default",
  }
}

describe("Signal analytics windows", () => {
  test("calculates PF, DDT and TP/SL ratios from the same closed-position sample", () => {
    const metric = calculateSignalWindowMetric([
      trade("peak", "BTCUSDT", 10, 10),
      trade("drop", "BTCUSDT", -5, 8, "signal_trailing"),
      trade("recovery", "BTCUSDT", 6, 4),
    ], NOW)

    expect(metric).toMatchObject({
      trades: 3,
      wins: 2,
      losses: 1,
      grossProfit: 16,
      grossLoss: 5,
      netPnl: 11,
      profitFactor: 3.2,
      drawdown: {
        episodes: 1,
        maxDepth: 5,
        maxDurationHours: 4,
        inDrawdown: false,
      },
      protection: {
        standardTrades: 2,
        trailingTrades: 1,
        stopLossPct: { samples: 3, minimum: 0.4, maximum: 0.8 },
        takeProfitPct: { samples: 3, minimum: 1.2, maximum: 1.6 },
      },
    })
    expect(metric.protection.takeProfitStopLossRatio.average).toBeCloseTo(8 / 3, 6)
  })

  test("uses exactly last 12/50 positions and 8h/48h closed-time windows", () => {
    const trades = Array.from({ length: 60 }, (_, index) =>
      trade(`position-${index}`, "BTCUSDT", index % 3 === 0 ? -1 : 2, index),
    )
    const windows = buildSignalAnalyticsWindows(trades, NOW)

    expect(windows.positions12.trades).toBe(12)
    expect(windows.positions50.trades).toBe(50)
    expect(windows.hours8.trades).toBe(9)
    expect(windows.hours48.trades).toBe(49)
  })

  test("returns at most 12 best and worst symbols for every requested window", () => {
    const trades = Array.from({ length: 20 }, (_, index) =>
      trade(
        `rank-${index}`,
        `SYM${String(index).padStart(2, "0")}USDT`,
        index - 10,
        1,
      ),
    )
    const rankings = buildSignalSymbolRankings(trades, NOW)

    for (const window of ["positions12", "positions50", "hours8", "hours48"] as const) {
      expect(rankings[window].top.length).toBeLessThanOrEqual(12)
      expect(rankings[window].worst.length).toBeLessThanOrEqual(12)
    }
    expect(rankings.hours48.top[0].symbol).toBe("SYM19USDT")
    expect(rankings.hours48.worst[0].symbol).toBe("SYM00USDT")
  })
})
