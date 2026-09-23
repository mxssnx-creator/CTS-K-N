import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("own trades with unresolved accounting are listed, never counted", () => {
  const route = read("app/api/trading/trade-history/route.ts")
  test("own exchange_required rows are kept and marked; foreign ones stay out", () => {
    expect(route).toContain('.filter((row) => row.accountingQuality !== "exchange_required" || isAttributedTradeHistoryRow(row))')
    expect(route).toContain("accountingPending: true")
  })
  test("summary and analytics use resolved own rows only", () => {
    expect(route).toContain("const resolvedOwnRows = rows.filter((row) => isAttributedTradeHistoryRow(row) && !(row as any).accountingPending)")
    expect(route).toContain("summarizeTradeHistory(resolvedOwnRows)")
    expect(route).toContain("for (const row of resolvedOwnRows.filter((row) => row.environment === mode))")
  })
  test("both tables show pending instead of a 0.00 PnL, and exclude it from totals", () => {
    expect(read("components/live-trading/trade-history-panel.tsx")).toContain("PnL pending")
    const table = read("components/dashboard/trade-history-table.tsx")
    expect(table).toContain("if ((trade as any).accountingPending) continue")
    expect(table).toContain(">pending</span>")
  })
})

describe("history table header stays pinned while scrolling", () => {
  test("the table's own wrapper no longer creates a second scroll container", () => {
    expect(read("components/ui/table.tsx")).toContain("cn('relative w-full overflow-x-auto', containerClassName)")
    expect(read("components/live-trading/trade-history-panel.tsx")).toContain('containerClassName="overflow-visible"')
    // The open-positions table had the same nested scroll container.
    expect(read("components/live-trading/live-position-table.tsx")).toContain('containerClassName="overflow-visible"')
  })
})

describe("a filled venue trade without a resolved exit is listed as pending", () => {
  const { classifyLocalTradeHistorySnapshot } = require("@/lib/trade-history")
  const base = { id: "p1", status: "closed", symbol: "JUGGERNAUTUSDT", direction: "short", executedQuantity: 1007,
    entryPrice: 0.00699, createdAt: 1_790_000_000_000, closedAt: 1_790_000_600_000, environment: "exchange" }
  test("exchange trade, no exit, no close order id -> pending row with entry, quantity and times", () => {
    const k = classifyLocalTradeHistorySnapshot(base)
    expect(k.disposition).toBe("unresolved_trade")
    expect(k.row).toMatchObject({ symbol: "JUGGERNAUTUSDT", direction: "short", quantity: 1007, exitPrice: 0, realizedPnl: 0, accountingQuality: "exchange_required" })
    expect(k.row.holdMinutes).toBe(10)
  })
  test("a simulated trade without an exit still yields no row", () => {
    const k = classifyLocalTradeHistorySnapshot({ ...base, environment: "simulated", mode: "simulated" })
    expect(k.row).toBeNull()
  })
})
