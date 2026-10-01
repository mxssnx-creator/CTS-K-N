import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ledgerEntryToHistoryRow, toLedgerEntry, tradeHistoryFromLedger, type ResultLedger } from "@/lib/results/ledger"
import { buildResultsBookResponse, stopOrLiquidationFirst, RESULT_GROUPS } from "@/lib/results/response"
import { summarizeTradeHistory } from "@/lib/trade-history"

const NOW = 1_800_000_000_000
let n = 0
const row = (o: Record<string, any> = {}): Record<string, any> => ({
  status: "closed", executionMode: "live", orderId: `o${++n}`, closeOrderId: `c${n}`, symbol: "SOLUSDT", direction: "long",
  executedQuantity: "10", closedQuantity: "10", averageExecutionPrice: "100", entryPrice: "100", closePrice: "101", leverage: "50",
  stopLoss: "0.5", takeProfit: "0.5", realizedPnL: "0.05", realizedPnlComplete: "true", tradingFees: "0.01",
  createdAt: String(NOW - 7_200_000), closedAt: String(NOW - 3_600_000), closeReason: "take_profit", indicationType: "direction",
  executionLane: "signal_trailing", setVariant: "default", executionIntent: "signal", parentSetKey: `SOL:direction:${n}`, ...o,
})
const ledgerOf = (rows: Array<Record<string, any>>, funnel: Record<string, number> = {}, complete = true): ResultLedger => ({
  connectionId: "bingx-x02", entries: rows.map((r, i) => toLedgerEntry(`id${i}`, r)), funnel,
  meta: { updatedAt: NOW, keys: rows.length + 50, remaining: complete ? 0 : 9, complete },
})

describe("fees are the total, not entry plus entry", () => {
  test("tradingFees already holds the entry and the close fee (X02: 0.005 = 0.0025 + 0.0025)", () => {
    expect(toLedgerEntry("a", row({ tradingFees: "0.005", entryTradingFee: "0.0025" })).fees).toBeCloseTo(0.005)
    expect(toLedgerEntry("b", row({ tradingFees: "", entryTradingFee: "0.0025" })).fees).toBeCloseTo(0.0025)
  })
  test("the entry keeps the exit price, order ids and set key the history table needs", () => {
    expect(toLedgerEntry("a", row({ closePrice: "99.5" }))).toMatchObject({ exit: 99.5, oid: expect.stringMatching(/^o/), coid: expect.stringMatching(/^c/), setKey: expect.stringContaining("SOL:direction") })
  })
})

describe("the trade history from the ledger", () => {
  test("every closed filled row, newest first; pending rows listed, marked and not counted; the summary covers ALL of them", () => {
    const rows = [
      row({ closedAt: String(NOW - 5_000), realizedPnL: "0.2" }),
      row({ closedAt: String(NOW - 9_000), realizedPnL: "-0.1" }),
      row({ closedAt: String(NOW - 1_000), realizedPnlComplete: "false", realizedPnL: "0" }),
      row({ status: "open", closedAt: "", realizedPnL: "", realizedPnlComplete: "" }),
    ]
    const h = tradeHistoryFromLedger(ledgerOf(rows))
    expect(h.rows).toHaveLength(3) // the open row is not history yet
    expect(h.rows.map((r) => r.closedAt)).toEqual([NOW - 1_000, NOW - 5_000, NOW - 9_000])
    expect(h.pending).toBe(1); expect(h.rows[0].accountingPending).toBe(true)
    const summary = summarizeTradeHistory(h.settled as any)
    expect(summary).toMatchObject({ total: 2, wins: 1, losses: 1, flat: 0 })
    expect(summary.netPnl).toBeCloseTo(0.1)
  })
  test("a row carries what the table shows: prices, volume, pnl, fees, hold time, ids, set and type", () => {
    const h = ledgerEntryToHistoryRow(toLedgerEntry("id", row({ realizedPnL: "0.5", tradingFees: "0.02" })))
    expect(h).toMatchObject({ symbol: "SOLUSDT", direction: "long", entryPrice: 100, exitPrice: 101, quantity: 10, volumeUsd: 1000, realizedPnl: 0.5, fees: 0.02, source: "local", attribution: "cts", environment: "exchange", executionIntent: "signal", indicationType: "direction", leverage: 50, closeReason: "take_profit" })
    expect(h.grossPnl).toBeCloseTo(0.52); expect(h.pnlPct).toBeCloseTo(0.05); expect(h.holdMinutes).toBeCloseTo(60)
    expect(h.accountingPending).toBeUndefined()
  })
  test("the route lists the ledger when it is complete and keeps its old sources otherwise, with offset paging", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")
    expect(route).toContain('const resultLedger = mode === "exchange" && scope !== "all" ? await readResultLedger(client, connectionId).catch(() => null) : null')
    expect(route).toContain("const ledgerHistory = resultLedger && resultLedger.meta.complete ? tradeHistoryFromLedger(resultLedger) : null")
    expect(route).toContain("ledgerHistory.rows.slice(offset, offset + limit)".replace("ledgerHistory.rows", "historyRows"))
    expect(route).toContain('historySource: ledgerHistory ? "results-ledger" : "position-index"')
    expect(route).toContain("totalIndexed: ledgerHistory ? ledgerHistory.rows.length : localPage.totalIndexed")
  })
})

describe("the results answer", () => {
  const rows = [
    row({ realizedPnL: "0.3", indicationType: "direction", leverage: "50", stopLoss: "0.5" }),
    row({ realizedPnL: "-0.4", indicationType: "move", leverage: "500", stopLoss: "0.5" }),
    row({ realizedPnL: "-0.1", indicationType: "move", leverage: "300", stopLoss: "0.5", closedAt: String(NOW - 10 * 86_400_000) }),
  ]
  test("windows, the funnel and the coverage; the old trade is outside 24 h and 7 d but inside all", () => {
    const r: any = buildResultsBookResponse(ledgerOf(rows, { simulated: 10491, "never:closed/placement_stuck_no_venue_handle": 5517, foreign: 2 }), { window: "24h" }, NOW)
    expect(r).toMatchObject({ success: true, ready: true, window: "24h" })
    expect(r.book).toMatchObject({ closed: 2, wins: 1, losses: 1 })
    expect(r.windows["24h"].closed).toBe(2); expect(r.windows["7d"].closed).toBe(2); expect(r.windows.all.closed).toBe(3); expect(r.windows["30d"].closed).toBe(3)
    expect(r.funnel).toMatchObject({ executed: 3, neverTraded: 5517, simulated: 10491, foreign: 2, neverTradedByReason: { "closed/placement_stuck_no_venue_handle": 5517 } })
    expect(r.coverage).toMatchObject({ complete: true, entries: 3 })
    expect(r.definition).toContain("filled, real, own")
  })
  test("groups for the live-against-simulation evaluation, including liquidation before the stop", () => {
    const r: any = buildResultsBookResponse(ledgerOf(rows), { group: "risk" }, NOW)
    expect(Object.keys(r.groups).sort()).toEqual(["liquidation_before_stop", "stop_first"])
    expect(r.groups.liquidation_before_stop.closed).toBe(2); expect(r.groups.stop_first.net).toBeCloseTo(0.3)
    expect(buildResultsBookResponse(ledgerOf(rows), { group: "type" }, NOW).groups).toMatchObject({ direction: { closed: 1 }, move: { closed: 2 } })
    expect(stopOrLiquidationFirst(toLedgerEntry("a", row({ leverage: "100", stopLoss: "0.5" })))).toBe("stop_first")
    expect(stopOrLiquidationFirst(toLedgerEntry("a", row({ leverage: "300", stopLoss: "0.5" })))).toBe("liquidation_before_stop")
    expect(stopOrLiquidationFirst(toLedgerEntry("a", row({ leverage: "", stopLoss: "0.5" })))).toBe("unknown")
    expect(RESULT_GROUPS).toEqual(expect.arrayContaining(["type", "lane", "variant", "symbol", "reason", "risk", "leverage", "stop"]))
  })
  test("no ledger, or an incomplete one, says so instead of showing zeros as results", () => {
    expect(buildResultsBookResponse(null, {}, NOW)).toMatchObject({ ready: false, book: null })
    expect((buildResultsBookResponse(ledgerOf(rows, {}, false), {}, NOW) as any).ready).toBe(false)
  })
  test("functional-overview counts executed positions and marks the set profit factors as qualification", () => {
    const f = readFileSync(resolve(process.cwd(), "app/api/trade-engine/functional-overview/route.ts"), "utf8")
    expect(f).toContain("liveOpen: executedLive ? executedLive.open : finite(liveOpen)")
    expect(f).toContain('scope: "executed-real-orders"')
    expect(f).toContain("qualification: { profitFactors:")
  })
})
