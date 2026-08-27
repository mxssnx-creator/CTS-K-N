import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AnalyticsEngine, type AnalyticsFilter } from "@/lib/analytics"
import type { TradingPosition } from "@/lib/trading"
import {
  classifyLocalTradeHistorySnapshot,
  normalizeLocalTradeHistoryRow,
  statisticsHistoryTupleToTradingPosition,
  toStatisticsHistoryTuple,
  type TradeHistoryRow,
} from "@/lib/trade-history"

const ROOT = process.cwd()
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

function position(input: {
  id: string
  strategy: string
  pnl: number
  openedAt: string
  closedAt?: string
  symbol?: string
}): TradingPosition {
  return {
    id: input.id,
    connection_id: "bingx-x02",
    exchange_position_id: `venue-${input.id}`,
    symbol: input.symbol || "BTCUSDT",
    strategy_type: input.strategy,
    volume: 1,
    entry_price: 100,
    current_price: 100,
    profit_loss: input.pnl,
    status: "closed",
    opened_at: input.openedAt,
    closed_at: input.closedAt || input.openedAt,
    unrealized_pnl: 0,
    realized_pnl: input.pnl,
    margin_used: 100,
    fees_paid: 0,
    hold_time: 0,
    max_profit: Math.max(0, input.pnl),
    max_loss: Math.min(0, input.pnl),
    position_side: "long",
  }
}

const unrestrictedFilter: AnalyticsFilter = {
  symbols: [],
  timeRange: {
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-09-01T00:00:00.000Z"),
  },
  indicationTypes: [],
  strategyTypes: [],
  trailingEnabled: undefined,
  minProfitFactor: undefined,
  maxDrawdown: undefined,
}

describe("statistics UI correctness", () => {
  test("applies the visible classic-PF and drawdown-hour filters", () => {
    const rows = [
      position({ id: "a1", strategy: "Base", pnl: 10, openedAt: "2026-08-20T00:00:00.000Z" }),
      position({ id: "a2", strategy: "Base", pnl: -5, openedAt: "2026-08-20T01:00:00.000Z" }),
      position({ id: "a3", strategy: "Base", pnl: 6, openedAt: "2026-08-20T02:00:00.000Z" }),
      position({ id: "b1", strategy: "Main", pnl: 4, openedAt: "2026-08-20T00:00:00.000Z" }),
      position({ id: "b2", strategy: "Main", pnl: -8, openedAt: "2026-08-20T01:00:00.000Z" }),
      position({ id: "b3", strategy: "Main", pnl: -1, openedAt: "2026-08-20T03:00:00.000Z" }),
    ]
    const engine = new AnalyticsEngine(rows)

    expect(engine.generateStrategyAnalytics(unrestrictedFilter).map((row) => row.strategy_name)).toEqual([
      "Base",
      "Main",
    ])
    expect(engine.generateStrategyAnalytics({
      ...unrestrictedFilter,
      minProfitFactor: 1.1,
    }).map((row) => row.strategy_name)).toEqual(["Base"])
    expect(engine.generateStrategyAnalytics({
      ...unrestrictedFilter,
      maxDrawdown: 1.5,
    }).map((row) => row.strategy_name)).toEqual(["Base"])
    expect(engine.generateStrategyAnalytics({
      ...unrestrictedFilter,
      strategyTypes: ["base"],
    }).map((row) => row.strategy_name)).toEqual(["Base"])
  })

  test("publishes realised USD drawdown rather than a fabricated percentage", () => {
    const engine = new AnalyticsEngine([
      position({ id: "d1", strategy: "Base", pnl: 10, openedAt: "2026-08-20T00:00:00.000Z" }),
      position({ id: "d2", strategy: "Base", pnl: -15, openedAt: "2026-08-21T00:00:00.000Z" }),
      position({ id: "d3", strategy: "Base", pnl: 4, openedAt: "2026-08-22T00:00:00.000Z" }),
    ])

    expect(engine.generateTimeSeriesData(unrestrictedFilter).map((row) => row.drawdown)).toEqual([0, 15, 11])
  })

  test("represents a loss-free classic realised PF as the shared infinity sentinel", () => {
    const engine = new AnalyticsEngine([
      position({ id: "win", strategy: "Base", pnl: 10, openedAt: "2026-08-20T00:00:00.000Z" }),
      position({ id: "flat", strategy: "Base", pnl: 0, openedAt: "2026-08-20T01:00:00.000Z" }),
    ])

    const stats = engine.generateStrategyAnalytics(unrestrictedFilter)[0]
    expect(stats?.profit_factor).toBe(999)
    expect(stats?.recovery_factor).toBe(Number.POSITIVE_INFINITY)
    expect(stats?.win_rate).toBe(1)
  })

  test("selects the latest 50 trades by close chronology, not response order", () => {
    const rows = Array.from({ length: 51 }, (_, index) => position({
      id: `row-${index}`,
      strategy: "Base",
      pnl: index === 0 ? -100 : 1,
      openedAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
      closedAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
    })).reverse()

    const stats = new AnalyticsEngine(rows).generateStrategyAnalytics(unrestrictedFilter)[0]
    expect(stats?.profit_factor).toBe(0.5)
    expect(stats?.profit_factor_last_50).toBe(999)
  })

  test("filters realised statistics by close time", () => {
    const engine = new AnalyticsEngine([
      position({
        id: "opened-before-closed-inside",
        strategy: "Base",
        pnl: 4,
        openedAt: "2026-07-31T23:00:00.000Z",
        closedAt: "2026-08-02T00:00:00.000Z",
      }),
      position({
        id: "opened-inside-closed-after",
        strategy: "Base",
        pnl: 8,
        openedAt: "2026-08-31T23:00:00.000Z",
        closedAt: "2026-09-02T00:00:00.000Z",
      }),
    ])

    const stats = engine.generateStrategyAnalytics(unrestrictedFilter)[0]
    expect(stats?.total_trades).toBe(1)
    expect(stats?.total_pnl).toBe(4)
  })

  test("applies aggregate strategy filters consistently to symbols and time series", () => {
    const rows = [
      position({ id: "base-win", strategy: "Base", symbol: "BTCUSDT", pnl: 10, openedAt: "2026-08-20T00:00:00.000Z" }),
      position({ id: "base-loss", strategy: "Base", symbol: "BTCUSDT", pnl: -5, openedAt: "2026-08-20T01:00:00.000Z" }),
      position({ id: "main-win", strategy: "Main", symbol: "ETHUSDT", pnl: 4, openedAt: "2026-08-20T02:00:00.000Z" }),
      position({ id: "main-loss", strategy: "Main", symbol: "ETHUSDT", pnl: -8, openedAt: "2026-08-20T03:00:00.000Z" }),
    ]
    const engine = new AnalyticsEngine(rows)
    const filter = { ...unrestrictedFilter, minProfitFactor: 1.1 }

    expect(engine.generateSymbolAnalytics(filter).map((row) => row.symbol)).toEqual(["BTCUSDT"])
    expect(engine.generateTimeSeriesData(filter).reduce((sum, row) => sum + row.daily_pnl, 0)).toBe(5)
  })

  test("round-trips the compact complete-archive transport without changing units", () => {
    const row: TradeHistoryRow = {
      id: "close-1",
      symbol: "BTCUSDT",
      direction: "short",
      entryPrice: 100,
      exitPrice: 99,
      quantity: 2,
      volumeUsd: 200,
      grossPnl: 2,
      fees: 0.2,
      realizedPnl: 1.8,
      pnlPct: 0.9,
      openedAt: Date.parse("2026-08-20T00:00:00.000Z"),
      closedAt: Date.parse("2026-08-20T01:00:00.000Z"),
      holdMinutes: 60,
      source: "local",
      environment: "exchange",
      setVariant: "main-trailing",
      indicationType: "signal",
      presetId: "preset-1",
      trailingActive: true,
    }

    const result = statisticsHistoryTupleToTradingPosition(
      toStatisticsHistoryTuple(row),
      "bingx-x02",
    ) as TradingPosition & { trailing_enabled?: boolean }
    expect(result).toMatchObject({
      id: "close-1",
      connection_id: "bingx-x02",
      symbol: "BTCUSDT",
      strategy_type: "main-trailing",
      profit_loss: 1.8,
      margin_used: 200,
      fees_paid: 0.2,
      hold_time: 60,
      position_side: "short",
      indication_type: "signal",
      preset_id: "preset-1",
      trailing_enabled: true,
    })
  })

  test("recovers legacy closed rows from stored P&L and fill quantity", () => {
    const recovered = normalizeLocalTradeHistoryRow({
      id: "legacy-close",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "short",
      executedQuantity: 0,
      averageExecutionPrice: 100,
      currentPrice: 0,
      realizedPnl: -10,
      fills: [{ quantity: 2, price: 100, fee: 0.2 }],
      createdAt: Date.parse("2026-08-20T00:00:00.000Z"),
      closedAt: Date.parse("2026-08-20T01:00:00.000Z"),
    })

    expect(recovered).toMatchObject({
      quantity: 2,
      entryPrice: 100,
      exitPrice: 105,
      realizedPnl: -10,
      fees: 0.2,
      closedAt: Date.parse("2026-08-20T01:00:00.000Z"),
    })
  })

  test("distinguishes indexed non-trades from genuinely unresolved trades", () => {
    expect(classifyLocalTradeHistorySnapshot({
      id: "rejected",
      status: "error",
      symbol: "BTCUSDT",
    })).toMatchObject({ disposition: "excluded_non_trade", reason: "non_terminal_status" })

    expect(classifyLocalTradeHistorySnapshot({
      id: "never-filled",
      status: "closed",
      symbol: "BTCUSDT",
      executedQuantity: 0,
    })).toMatchObject({ disposition: "excluded_non_trade", reason: "no_executed_quantity" })

    expect(classifyLocalTradeHistorySnapshot({
      id: "missing-accounting",
      status: "closed",
      symbol: "BTCUSDT",
      executedQuantity: 1,
    })).toMatchObject({ disposition: "unresolved_trade", reason: "missing_entry_price" })
  })

  test("quarantines implausible live accounting until the venue close reconciles it", () => {
    const snapshot = {
      id: "legacy-minimum-retry",
      status: "closed",
      symbol: "EYEUSDT",
      direction: "short",
      executionMode: "live",
      executedQuantity: 2_278,
      averageExecutionPrice: 100.42420596734958,
      closePrice: 0.000962,
      realizedPnL: 228_764.15,
      createdAt: Date.parse("2026-08-23T13:56:06.000Z"),
      closedAt: Date.parse("2026-08-23T13:57:46.000Z"),
      partialOrderExecutions: JSON.stringify([{
        source: "system_close",
        orderId: "venue-close-1",
        positionQuantityAfter: 0,
        updatedAt: Date.parse("2026-08-23T13:57:45.000Z"),
      }]),
    }

    expect(classifyLocalTradeHistorySnapshot(snapshot)).toMatchObject({
      disposition: "unresolved_trade",
      reason: "venue_accounting_incomplete",
      row: {
        closeOrderId: "venue-close-1",
        accountingQuality: "exchange_required",
      },
    })
    expect(normalizeLocalTradeHistoryRow(snapshot)).toBeNull()
    expect(classifyLocalTradeHistorySnapshot({
      ...snapshot,
      environment: "simulated",
      executionMode: "simulation",
    })).toMatchObject({ disposition: "normalized_trade", reason: "normalized" })
  })

  test("uses the canonical PF coordinate and lightweight runtime polling contracts", () => {
    const page = read("app/statistics/page.tsx")
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    const historyRoute = read("app/api/trading/trade-history/route.ts")
    const presetStats = read("components/statistics/preset-trade-stats.tsx")
    const filters = read("components/statistics/analytics-filters.tsx")
    const adjustStats = read("components/statistics/adjust-strategy-stats.tsx")
    const blockStats = read("components/statistics/block-strategy-stats.tsx")

    expect(page).toContain("signedResultRToMainTradePfRatio(realizedPnl / positionCost)")
    expect(page).not.toContain("profit_factor: 1 + realizedPnl / positionCost")
    expect(page).toContain("/stats?view=runtime")
    expect(page).toContain("/stats?view=overview")
    expect(page).toContain("view=statistics")
    expect(route).toContain('searchParams.get("view") === "runtime"')
    expect(route).toContain('statsSearchParams.get("view") === "overview"')
    expect(route).toContain("runtimeOnlyStatsResponse")
    expect(historyRoute).toContain('view === "statistics"')
    expect(historyRoute).toContain("loadClosedPositionSnapshotArchive")
    expect(historyRoute).toContain("unresolvedTradeSnapshots === 0")
    expect(historyRoute).toContain("excludedNonTradeSnapshots")
    expect(page.match(/setPositions\(\[\]\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(page).not.toContain("const coordinationMethods =")
    expect(page).not.toContain("totalValueAtRisk * 100")
    expect(presetStats).toContain("new AnalyticsEngine(positions).filterPositions")
    expect(presetStats).not.toContain("((peak - cumulativePnl) / peak) * 100")
    expect(presetStats).toContain("formatCurrency(stat.max_drawdown_usd)")
    expect(page).toContain("availableSymbols={availableFilters.symbols}")
    expect(filters).toContain("availableSymbols = []")
    expect(filters).toContain("endOfDay(date)")
    expect(adjustStats).toContain("position.updated_at || position.created_at")
    expect(adjustStats).toContain("peakEquity - equity")
    expect(blockStats).toContain(".slice(0, comparisonWindow)\n      .reverse()")
  })
})
