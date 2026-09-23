import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { applyCloseSettlement, closeOrderCandidates, needsDeferredCloseAccounting } from "@/lib/close-accounting-backfill"

const genius = () => ({
  id: "g1", status: "closed", symbol: "GENIUS-USDT", direction: "short", environment: "exchange",
  entryPrice: 0.354, executedQuantity: 14.13, entryTradingFee: 0.0025, createdAt: 1_790_150_000_000, closedAt: 1_790_150_873_000,
  closeOrderId: "2102671278818201600", realizedPnL: 0, realizedPnlComplete: false,
  exchangeData: { clientOrderIds: [{ kind: "entry", clientOrderId: "e" }, { kind: "system_close", clientOrderId: "ctsbingxx02sysclo" }] },
})

describe("deferred close accounting", () => {
  test("the production case: the venue's settlement of the row's own close order completes it", () => {
    const row: any = genius()
    expect(needsDeferredCloseAccounting(row)).toBe(true)
    const ok = applyCloseSettlement(row, { filledQuantity: 14.13, averageFillPrice: 0.3542, grossRealizedPnl: -0.0028, tradingFee: 0.002502 }, "2102671278818201600")
    expect(ok).toBe(true)
    expect(row.exitPrice).toBe(0.3542)
    expect(row.realizedPnL).toBeCloseTo(-0.0028 - 0.0025 - 0.002502, 10)
    expect(row.realizedPnlComplete).toBe(true)
    expect(needsDeferredCloseAccounting(row)).toBe(false)
  })
  test("an order that closed only PART of the row is never applied", () => {
    const row: any = genius()
    expect(applyCloseSettlement(row, { filledQuantity: 7, averageFillPrice: 0.3542, grossRealizedPnl: -0.001, tradingFee: 0.001 }, "x")).toBe(false)
    expect(row.realizedPnlComplete).toBe(false)
  })
  test("candidates are the close order and close-side tracked client ids, never the entry", () => {
    const c = closeOrderCandidates(genius())
    expect(c.orderIds).toEqual(["2102671278818201600"])
    expect(c.clientIds).toEqual(["ctsbingxx02sysclo"])
  })
  test("open, unfilled and already-settled rows are not candidates", () => {
    expect(needsDeferredCloseAccounting({ ...genius(), status: "open" })).toBe(false)
    expect(needsDeferredCloseAccounting({ ...genius(), executedQuantity: 0 })).toBe(false)
    expect(needsDeferredCloseAccounting({ ...genius(), closeAccountingSettledAt: 1 })).toBe(false)
  })
  test("the job is bounded and scheduled", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    expect(route).toContain("const PER_RUN = 25")
    expect(route).toContain("Date.now() - started > 40_000")
    expect(readFileSync(resolve(process.cwd(), "scripts/run-minute-scheduler.mjs"), "utf8")).toContain('"/api/cron/close-accounting"')
  })

  test("the pre-filter uses only Redis-wrapper methods that exist (no hmget)", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    const wrapper = readFileSync(resolve(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(route).not.toContain("client.hmget(")
    for (const m of ["hget", "hgetall", "hset", "keys", "get", "set"]) expect(wrapper).toMatch(new RegExp(`async ${m}\\(`))
  })
})
