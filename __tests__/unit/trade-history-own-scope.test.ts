import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isAttributedTradeHistoryRow, mergeTradeHistory } from "@/lib/trade-history"

const route = readFileSync(resolve(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")

describe("trade history shows CTS-K-N's own trades, never crowded out by foreign venue trades", () => {
  test("scope=own filters to attributed rows BEFORE the page is cut", () => {
    expect(route).toContain('searchParams.get("scope") === "all" ? "all" : "own"')
    const filterAt = route.indexOf("mergedAll.filter(isAttributedTradeHistoryRow)")
    const sliceAt = route.indexOf(".slice(0, limit)", filterAt)
    expect(filterAt).toBeGreaterThan(0)
    expect(sliceAt).toBeGreaterThan(filterAt)
    expect(route).toContain("foreignExcluded")
  })
  test("foreign venue rows are marked unattributed and never counted as ours", () => {
    const exchange = Array.from({ length: 5 }, (_, i) => ({ id: `exchange:${i}`, symbol: `F${i}USDT`, closedAt: 2000 + i, source: "exchange" } as any))
    const merged = mergeTradeHistory(exchange, [])
    expect(merged.every((row) => row.attribution === "unattributed")).toBe(true)
    expect(merged.filter(isAttributedTradeHistoryRow)).toHaveLength(0)
  })
  test("/live-trading can load older archive pages without losing them on refresh", () => {
    const page = readFileSync(resolve(process.cwd(), "app/live-trading/page.tsx"), "utf8")
    const panel = readFileSync(resolve(process.cwd(), "components/live-trading/trade-history-panel.tsx"), "utf8")
    expect(page).toContain("const [olderHistoryRows, setOlderHistoryRows]")
    expect(page).toContain("[...historyRows, ...olderHistoryRows]")
    expect(panel).toContain("Load older trades")
  })
})
