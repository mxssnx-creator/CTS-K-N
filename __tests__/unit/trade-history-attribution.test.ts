import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  isAttributedTradeHistoryRow,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  normalizeLocalTradeHistoryRow,
  summarizeTradeHistory,
  toStatisticsHistoryTuple,
  UNATTRIBUTED_EXCHANGE_STRATEGY,
} from "@/lib/trade-history"

function venueClose(symbol: string, orderId: string, positionId: string, side: "BUY" | "SELL", positionSide: "LONG" | "SHORT", qty: string, profit: string, t: number) {
  return normalizeBingXClosedOrder({
    symbol, orderId, positionID: positionId, side, positionSide, status: "FILLED",
    executedQty: qty, avgPrice: "100", profit, commission: "0.1", updateTime: t,
  })!
}

describe("trade history attribution on a shared exchange account", () => {
  const ours = normalizeLocalTradeHistoryRow({
    id: "live:conn:btc:1", status: "closed", symbol: "BTCUSDT", direction: "long",
    executedQuantity: 2, averageExecutionPrice: 98, closePrice: 109, realizedPnL: 22,
    createdAt: 1_700_000_000_000, closedAt: 1_700_000_061_000,
    exchangeData: { exchangePositionId: "venue-pos-1" },
  })!
  const matchingVenue = venueClose("BTCUSDT", "close-1", "venue-pos-1", "SELL", "LONG", "2", "20", 1_700_000_060_000)
  // Another actor's trades on the same account: different symbols, no lineage.
  const foreignA = venueClose("RABBITUSDT", "f-1", "venue-pos-9", "BUY", "SHORT", "19212", "-3.2", 1_700_000_070_000)
  const foreignB = venueClose("TOADUSDT", "f-2", "venue-pos-8", "BUY", "SHORT", "822", "1.1", 1_700_000_080_000)

  test("merge tags matched venue rows and local rows as ours, unmatched venue rows as unattributed", () => {
    const rows = mergeTradeHistory([matchingVenue, foreignA, foreignB], [ours], 0)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get("live:conn:btc:1")?.attribution).toBe("cts")
    expect(rows.filter((row) => row.attribution === "unattributed").map((row) => row.symbol).sort()).toEqual(["RABBITUSDT", "TOADUSDT"])
    expect(rows.filter(isAttributedTradeHistoryRow)).toHaveLength(1)
  })

  test("statistics tuples type unattributed venue rows distinctly; ours keep their strategy", () => {
    const rows = mergeTradeHistory([matchingVenue, foreignA], [ours], 0)
    const types = Object.fromEntries(rows.map((row) => [row.symbol, toStatisticsHistoryTuple(row)[2]]))
    expect(types.RABBITUSDT).toBe(UNATTRIBUTED_EXCHANGE_STRATEGY)
    expect(types.BTCUSDT).not.toBe(UNATTRIBUTED_EXCHANGE_STRATEGY)
  })

  test("summaries over attributed rows exclude other actors' PnL and counts", () => {
    const rows = mergeTradeHistory([matchingVenue, foreignA, foreignB], [ours], 0)
    const all = summarizeTradeHistory(rows)
    const own = summarizeTradeHistory(rows.filter(isAttributedTradeHistoryRow))
    expect(all.total ?? all.count ?? Object.values(all)[0]).not.toEqual(own.total ?? own.count ?? Object.values(own)[0])
    expect(rows.filter(isAttributedTradeHistoryRow).map((row) => row.symbol)).toEqual(["BTCUSDT"])
  })

  test("rows created before attribution existed default by source", () => {
    expect(isAttributedTradeHistoryRow({ source: "local" })).toBe(true)
    expect(isAttributedTradeHistoryRow({ source: "exchange" })).toBe(false)
    expect(isAttributedTradeHistoryRow({ source: "exchange", attribution: "cts" })).toBe(true)
  })

  test("route and statistics page compute figures from attributed rows only, listing unattributed rows separately", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")
    expect(route).toContain("analytics: buildLiveTradingAnalytics(attributedRows, analyticsNowStatistics)")
    expect(route).toContain("unattributedExchange: {")
    // Summary counts attributed rows only — and, since unresolved own trades
    // are now listed, only those whose close accounting is resolved.
    expect(route).toContain("const resolvedOwnRows = rows.filter((row) => isAttributedTradeHistoryRow(row) && !(row as any).accountingPending)")
    expect(route).toContain("summarizeTradeHistory(resolvedOwnRows)")
    const page = readFileSync(resolve(process.cwd(), "app/statistics/page.tsx"), "utf8")
    expect(page).toContain("if (tuple[2] === UNATTRIBUTED_EXCHANGE_STRATEGY) continue")
    expect(page).toContain("&& isAttributedTradeHistoryRow(row)) {")
  })
})
