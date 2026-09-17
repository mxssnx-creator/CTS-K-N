import {
  LIVE_STATISTICS_FAMILIES,
  buildLiveFamilyStatistics,
  resolveLiveStatisticsFamily,
  rowSignedResultR,
} from "@/lib/live-family-statistics"
import type { TradeHistoryRow } from "@/lib/trade-history"

const row = (over: Partial<TradeHistoryRow> = {}): TradeHistoryRow => ({
  symbol: "BTCUSDT",
  entryPrice: 100,
  exitPrice: 101,
  volumeUsd: 1000,
  realizedPnl: 1,
  openedAt: 1_000,
  closedAt: 2_000,
  holdMinutes: 10,
  source: "local",
  attribution: "cts",
  setVariant: "standard",
  ...over,
}) as TradeHistoryRow

describe("per-family statistics over realised trades", () => {
  test("the family comes from the Set variant the engine dispatched", () => {
    expect(resolveLiveStatisticsFamily(row({ setVariant: "block" }))).toBe("block")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "block:row_live:2" }))).toBe("block")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "dca" }))).toBe("dca")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "trailing" }))).toBe("trailing")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "axis" }))).toBe("axis")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "signal" }))).toBe("signal")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "standard" }))).toBe("normal")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "" }))).toBe("normal")
    expect(resolveLiveStatisticsFamily(row({ setVariant: "something-new" }))).toBe("other")
  })

  test("results land on the PositionCost coordinate, the same axis the Historic Test uses", () => {
    // 1000 USD notional, +1 USD = +0.1% = exactly one PositionCost at 0.1.
    expect(rowSignedResultR(row({ volumeUsd: 1000, realizedPnl: 1 }), 0.1)).toBeCloseTo(1, 10)
    expect(rowSignedResultR(row({ volumeUsd: 1000, realizedPnl: 3 }), 0.1)).toBeCloseTo(3, 10)
    // Without a usable notional the row contributes nothing rather than a fabricated ratio.
    expect(rowSignedResultR(row({ volumeUsd: 0, realizedPnl: 5 }), 0.1)).toBe(0)
    const stats = buildLiveFamilyStatistics([row({ volumeUsd: 1000, realizedPnl: 1 })], 0.1)
    expect(stats.overall.profitFactor).toBeCloseTo(1.1, 10)
  })

  test("foreign rows are reported separately and never mixed into a family", () => {
    const rows = [
      row({ realizedPnl: 5 }),
      row({ attribution: "unattributed", source: "exchange", realizedPnl: -100 }),
    ]
    const stats = buildLiveFamilyStatistics(rows, 0.1)
    expect(stats.overall.trades).toBe(1)
    expect(stats.overall.netPnl).toBe(5)
    expect(stats.foreign).toEqual({ trades: 1, netPnl: -100 })
    for (const family of stats.families) expect(family.netPnl).toBeGreaterThanOrEqual(0)
  })

  test("every family is reported, so 'traded nothing' stays distinguishable from 'traded at a loss'", () => {
    const stats = buildLiveFamilyStatistics([row({ setVariant: "block", realizedPnl: -2 })], 0.1)
    expect(stats.families.map((f) => f.family)).toEqual([...LIVE_STATISTICS_FAMILIES])
    const untouched = stats.families.find((f) => f.family === "dca")!
    expect(untouched).toMatchObject({ trades: 0, profitFactor: 1, netPnl: 0 })
    const block = stats.families.find((f) => f.family === "block")!
    expect(block.trades).toBe(1)
    expect(block.profitFactor).toBeLessThan(1)
  })

  test("drawdown time is measured over losing trades only", () => {
    const stats = buildLiveFamilyStatistics([
      row({ realizedPnl: 5, holdMinutes: 5 }),
      row({ realizedPnl: -1, holdMinutes: 30 }),
      row({ realizedPnl: -1, holdMinutes: 90 }),
    ], 0.1)
    expect(stats.overall.wins).toBe(1)
    expect(stats.overall.losses).toBe(2)
    expect(stats.overall.averageDrawdownTimeMin).toBeCloseTo(60, 6)
    expect(stats.overall.maxDrawdownTimeMin).toBeCloseTo(90, 6)
  })

  test("an empty history reports neutral rows rather than failing", () => {
    const stats = buildLiveFamilyStatistics([], 0.1)
    expect(stats.overall).toMatchObject({ trades: 0, profitFactor: 1 })
    expect(stats.foreign).toEqual({ trades: 0, netPnl: 0 })
  })
})
