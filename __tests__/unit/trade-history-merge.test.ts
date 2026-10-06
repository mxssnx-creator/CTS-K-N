import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { mergeTradeHistoryRows } from "@/components/dashboard/trade-history-merge"
import type { TradeHistoryRow } from "@/lib/trade-history"

function row(overrides: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: "pos-1",
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 101,
    quantity: 1,
    volumeUsd: 100,
    grossPnl: 1,
    fees: 0.1,
    realizedPnl: 0.9,
    pnlPct: 0.9,
    openedAt: 1_000,
    closedAt: 2_000,
    holdMinutes: 0,
    source: "local",
    environment: "exchange",
    attribution: "cts",
    ...overrides,
  }
}

describe("dashboard trade-history accumulation", () => {
  test("a position first seen pending and later settled stays one row with the settled values", () => {
    const pending = row({ id: "pos-1", closeOrderId: undefined, accountingPending: true, realizedPnl: 0, exitPrice: 0 })
    const settled = row({ id: "pos-1", closeOrderId: "close-9", realizedPnl: 4.2, exitPrice: 104.3 })

    const afterFirstPoll = mergeTradeHistoryRows([], [pending])
    const afterSecondPoll = mergeTradeHistoryRows(afterFirstPoll, [settled])

    expect(afterSecondPoll).toHaveLength(1)
    expect(afterSecondPoll[0]).toMatchObject({ id: "pos-1", closeOrderId: "close-9", realizedPnl: 4.2 })
    expect(afterSecondPoll[0].accountingPending).toBeUndefined()
  })

  test("the newer read replaces the older version even when its close time moved earlier", () => {
    const provisional = row({ id: "pos-2", closedAt: 9_000, realizedPnl: 0 })
    const corrected = row({ id: "pos-2", closedAt: 8_500, realizedPnl: -1.5 })

    const merged = mergeTradeHistoryRows([provisional], [corrected])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ closedAt: 8_500, realizedPnl: -1.5 })
  })

  test("distinct positions sharing one venue close order stay distinct rows, newest first", () => {
    const first = row({ id: "slot-a", closeOrderId: "shared-close", closedAt: 5_000 })
    const second = row({ id: "slot-b", closeOrderId: "shared-close", closedAt: 6_000 })
    const older = row({ id: "slot-c", closeOrderId: "other", closedAt: 1_000 })

    const merged = mergeTradeHistoryRows([older], [first, second])

    expect(merged.map((entry) => entry.id)).toEqual(["slot-b", "slot-a", "slot-c"])
  })

  test("repeated polls of the same page never grow the table", () => {
    const page = [row({ id: "a", closedAt: 3 }), row({ id: "b", closedAt: 2 }), row({ id: "c", closedAt: 1 })]
    let rows = mergeTradeHistoryRows([], page)
    for (let poll = 0; poll < 5; poll++) rows = mergeTradeHistoryRows(rows, page)
    expect(rows).toHaveLength(3)
  })

  test("the statistics overview accumulates history through the position-keyed helper", () => {
    const source = readFileSync(resolve(process.cwd(), "components/dashboard/statistics-overview-v2.tsx"), "utf8")
    expect(source).toContain("mergeTradeHistoryRows(previous, collected)")
    expect(source).not.toContain("row.closeOrderId ? `close:${row.closeOrderId}`")
  })
})
