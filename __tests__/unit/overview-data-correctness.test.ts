import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isExecutedRealExchangePosition } from "@/lib/live-position-source"

const closedFilled = { id: "a", status: "closed", connectionId: "bingx-x02", executedQuantity: 0.76, totalExecutedQuantity: 0.76, closedQuantity: 0.76, orderId: "E1", exchangeData: { orderId: "E1" }, isSimulated: false, dataSource: "exchange" }
const closedNeverFilled = { id: "b", status: "closed", connectionId: "bingx-x02", executedQuantity: 0, totalExecutedQuantity: 0, closedQuantity: 0, isSimulated: false, dataSource: "exchange" }

describe("trade stats count only closed rows that actually traded", () => {
  test("a closed, filled row is an executed trade", () => {
    expect(isExecutedRealExchangePosition(closedFilled)).toBe(true)
  })
  test("a closed row that never filled is not a trade (no longer a 'break-even')", () => {
    expect(isExecutedRealExchangePosition(closedNeverFilled)).toBe(false)
  })
  test("both the stats window and the per-window build require an execution for closed rows", () => {
    const src = readFileSync(resolve(process.cwd(), "app/api/trading/stats/route.ts"), "utf8")
    expect(src).toContain('String(p?.status || "").trim().toLowerCase() === "closed" && isExecutedRealExchangePosition(p)')
    expect(src).toContain('=== "closed" && isExecutedRealExchangePosition(position))')
  })
})

describe("no permanent phantom pending entries", () => {
  test("the sync never recreates the mirror of a discarded row", () => {
    const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(live).toContain("const canonicalExists = await client.exists?.(`live_positions:${position.connectionId || connectionId}:${position.id}`)")
  })
  test("the minute cron removes only mirrors that provably never traded", () => {
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    expect(cron).toContain("if (await client.exists(`live_positions:${connectionId}:${positionId}`).catch(() => 1)) continue")
    expect(cron).toContain('if (Number(mirror?.executedQuantity || 0) > 0 || String(mirror?.orderId || "").trim()) continue')
    expect(cron).toContain("if (createdAt > 0 && Date.now() - createdAt < 10 * 60_000) continue")
  })
})
