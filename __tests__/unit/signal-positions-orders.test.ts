import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  countSignalPositionOrders,
  evaluateSignalOrderCapacity,
  normalizeSignalMaxOrders,
  signalSlotMember,
  summarizeSignalCounts,
  SIGNAL_MAX_POSITIONS_DEFAULT,
} from "@/lib/signal-position-policy"
import { normalizeSignalIndicationSettings } from "@/lib/signal-indication"
import { occupySignalSlot, releaseSignalSlotRow } from "@/lib/trade-engine/stages/live-stage"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("Signal positions and orders are separate limits", () => {
  test("positions default to 100, orders and orders per symbol to unlimited", () => {
    expect(SIGNAL_MAX_POSITIONS_DEFAULT).toBe(100)
    const settings = normalizeSignalIndicationSettings({})
    expect(settings.maxPositionsTotal).toBe(100)
    expect(settings.maxOrders).toBe(0)
    expect(settings.maxOrdersPerSymbol).toBe(0)
  })
  test("an operator position limit above 100 is kept up to 350; the orders limit is unlimited for 0, missing or invalid", () => {
    expect(normalizeSignalIndicationSettings({ maxPositionsTotal: 250 }).maxPositionsTotal).toBe(250)
    expect(normalizeSignalIndicationSettings({ maxPositionsTotal: 9999 }).maxPositionsTotal).toBe(350)
    for (const v of [undefined, null, "", "x", 0, -5]) expect(normalizeSignalMaxOrders(v)).toBe(0)
    expect(normalizeSignalMaxOrders(500)).toBe(500)
    expect(normalizeSignalMaxOrders(5_000_000)).toBe(1_000_000)
    expect(normalizeSignalIndicationSettings({ maxOrders: 800 }).maxOrders).toBe(800)
  })
  test("an unlimited orders limit never blocks, a finite one blocks at the limit", () => {
    expect(evaluateSignalOrderCapacity(10_000_000, 0)).toEqual({ allowed: true, orders: 10_000_000, ordersLimit: 0 })
    expect(evaluateSignalOrderCapacity(499, 500)).toEqual({ allowed: true, orders: 499, ordersLimit: 500 })
    expect(evaluateSignalOrderCapacity(500, 500)).toEqual({ allowed: false, orders: 500, ordersLimit: 500 })
  })
})

describe("orders: every internal position row is an order, and so is every order of it", () => {
  test("a row is an order in its own right, even before any venue order id is known", () => {
    expect(countSignalPositionOrders({})).toBe(1)
    expect(countSignalPositionOrders({ status: "pending" })).toBe(1)
    expect(countSignalPositionOrders(null)).toBe(0)
  })
  test("a bare entry is one order; entry, stop loss, take profit and security stop are four", () => {
    expect(countSignalPositionOrders({ orderId: "E1" })).toBe(1)
    expect(countSignalPositionOrders({ orderId: "E1", stopLossOrderId: "S1", takeProfitOrderId: "T1", securityStopOrderId: "X1" })).toBe(4)
  })
  test("the same id in several fields is one order; every further fill of it counts", () => {
    expect(countSignalPositionOrders({
      orderId: "E1", fills: [{ orderId: "E1" }], settledOrderIds: ["E1"], entrySettlementOrderIds: ["E1"],
      exchangeData: { clientOrderIds: [{ clientOrderId: "E1" }] },
    })).toBe(1)
    expect(countSignalPositionOrders({ orderId: "E1", settledOrderIds: ["E1"], fills: [{ orderId: "E1" }, { orderId: "E1" }] })).toBe(2)
    expect(countSignalPositionOrders({ orderId: "E1", fills: [{ orderId: "E1" }, { orderId: "E1" }, { orderId: "E1" }] })).toBe(3)
  })
  test("add-on and close orders and tracked client ids are all counted", () => {
    expect(countSignalPositionOrders({
      orderId: "E1", closeOrderId: "C1",
      fills: [{ orderId: "E1" }, { orderId: "A2" }],
      exchangeData: { clientOrderIds: [{ clientOrderId: "kt1", kind: "entry" }, { clientOrderId: "kt2", kind: "accumulation" }] },
    })).toBe(5) // E1, C1, A2, kt1, kt2
  })
})

describe("a position is ONE symbol + direction: rows on it are orders", () => {
  const rows = [
    { symbol: "BTCUSDT", direction: "long", orders: 3 },
    { symbol: "BTC-USDT", direction: "long", orders: 2 },   // same symbol + direction: the same position
    { symbol: "BTCUSDT", direction: "short", orders: 2 },  // other direction: a second position
    { symbol: "SOLUSDT", direction: "long", orders: 4 },
    { symbol: "SOLUSDT", direction: "long", orders: 1 },
    { symbol: "XRPUSDT", direction: "short", orders: 1 },
    { symbol: "XRPUSDT", direction: "weird", orders: 9 },
  ]
  test("rows on one symbol and direction count as one position, Long and Short of a symbol as two", () => {
    const s = summarizeSignalCounts(rows as any)
    expect(s).toMatchObject({ positions: 4, long: 2, short: 2, symbols: 3, rows: 6, orders: 13 })
    expect(s.bySymbol.find((x) => x.symbol === "BTCUSDT")).toEqual({ symbol: "BTCUSDT", long: 1, short: 1, rows: 3, orders: 7 })
    expect(s.bySymbol.find((x) => x.symbol === "SOLUSDT")).toEqual({ symbol: "SOLUSDT", long: 1, short: 0, rows: 2, orders: 5 })
  })
  test("a row without a valid direction is neither a position nor an order", () => {
    expect(summarizeSignalCounts([{ symbol: "XRPUSDT", direction: "weird", orders: 9 }] as any)).toMatchObject({ positions: 0, rows: 0, orders: 0 })
  })
  test("the slot member is the same for every spelling of a symbol", () => {
    expect(signalSlotMember("BTC-USDT", "long")).toBe("BTCUSDT:long")
    expect(signalSlotMember("btcusdt", "short")).toBe("BTCUSDT:short")
  })
})

/** Minimal in-memory set store: exactly the calls the slot helpers make. */
function fakeRedis() {
  const sets = new Map<string, Set<string>>()
  const get = (k: string) => sets.get(k) || new Set<string>()
  return {
    sets,
    async sadd(k: string, ...m: string[]) { const s = sets.get(k) || new Set<string>(); m.forEach((x) => s.add(x)); sets.set(k, s); return m.length },
    async srem(k: string, ...m: string[]) { const s = sets.get(k); if (!s) return 0; let n = 0; m.forEach((x) => { if (s.delete(x)) n++ }); return n },
    async scard(k: string) { return get(k).size },
    async persist() { return 1 },
  }
}
describe("the position lifecycle at the index: the last row leaving ends the position", () => {
  const conn = "bingx-x02"
  const slots = `signal:positions:${conn}:slots`
  test("three rows on one slot are one position; it ends only when the LAST row leaves", async () => {
    const r = fakeRedis()
    await occupySignalSlot(r, conn, "SOLUSDT", "long", "row-1")
    await occupySignalSlot(r, conn, "SOL-USDT", "long", "row-2")
    await occupySignalSlot(r, conn, "SOLUSDT", "long", "row-3")
    expect(await r.scard(slots)).toBe(1)
    expect(await r.scard(`${slots}:long`)).toBe(1)
    await releaseSignalSlotRow(r, conn, "SOLUSDT", "long", "row-1")
    await releaseSignalSlotRow(r, conn, "SOLUSDT", "long", "row-2")
    expect(await r.scard(slots)).toBe(1) // one row left: still a position
    await releaseSignalSlotRow(r, conn, "SOLUSDT", "long", "row-3")
    expect(await r.scard(slots)).toBe(0)
    expect(await r.scard(`${slots}:long`)).toBe(0)
  })
  test("Long and Short of one symbol are two independent positions", async () => {
    const r = fakeRedis()
    await occupySignalSlot(r, conn, "BTCUSDT", "long", "a")
    await occupySignalSlot(r, conn, "BTCUSDT", "short", "b")
    expect(await r.scard(slots)).toBe(2)
    expect(await r.scard(`${slots}:long`)).toBe(1)
    expect(await r.scard(`${slots}:short`)).toBe(1)
    await releaseSignalSlotRow(r, conn, "BTCUSDT", "long", "a")
    expect(await r.scard(slots)).toBe(1)
    expect(await r.scard(`${slots}:short`)).toBe(1)
    expect(await r.scard(`${slots}:long`)).toBe(0)
  })
  test("releasing a row that was never indexed leaves every position as it was", async () => {
    const r = fakeRedis()
    await occupySignalSlot(r, conn, "ETHUSDT", "long", "x")
    await releaseSignalSlotRow(r, conn, "ETHUSDT", "short", "ghost")   // the other direction, never occupied
    expect(await r.scard(slots)).toBe(1)
  })
  test("different symbols are different positions", async () => {
    const r = fakeRedis()
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT"]) await occupySignalSlot(r, conn, s, "long", `row-${s}`)
    expect(await r.scard(slots)).toBe(3)
  })
})

describe("wiring: admission, statistics and display", () => {
  const live = src("lib/trade-engine/stages/live-stage.ts")
  test("the index is v3 with slot sets, and the obsolete per-symbol row sets are removed on rebuild", () => {
    expect(live).toContain('const SIGNAL_POSITION_ADMISSION_INDEX_VERSION = "3"')
    expect(live).toContain("`${indexKey}:symbol:*`")
    expect(live).toContain("await releaseSignalSlotRow(client, position.connectionId, position.symbol, \"long\", position.id)")
    expect(live).toContain("await occupySignalSlot(client, position.connectionId, position.symbol, direction, position.id)")
  })
  test("only a NEW slot meets the position limit; another row on an active slot counts as an order", () => {
    expect(live).toContain("const slotActive = Number(await client.scard(candidateSlotKey).catch(() => 0)) > 0")
    expect(live).toContain("if (!slotActive && !capacity.allowed) {")
    expect(live).toContain("const addedPosition = slotActive ? 0 : 1")
    expect(live).toContain("total: capacity.total + addedPosition,")
  })
  test("orders limits are checked only when finite, after the position check and before the reservation", () => {
    const slot = live.indexOf("if (!slotActive && !capacity.allowed) {")
    const perSymbol = live.indexOf("if (symbolOrdersLimit > 0) {", slot)
    const total = live.indexOf("if (maxOrders > 0) {", perSymbol)
    const reserve = live.indexOf("// Write the compact membership first.", total)
    expect(slot).toBeGreaterThan(0)
    expect(perSymbol).toBeGreaterThan(slot)
    expect(total).toBeGreaterThan(perSymbol)
    expect(reserve).toBeGreaterThan(total)
    expect(live).toContain('reason: "symbol_limit",')
    expect(live).toContain('reason: "order_limit",')
  })
  test("statistics report positions (slots), rows and orders separately", () => {
    const route = src("app/api/statistics/indications/route.ts")
    for (const f of ["openPositions: signalOpenSummary.positions", "openRows: signalOpenSummary.rows", "openLong:", "openShort:", "openOrders:", "openBySymbol:", "maxOrders: signalSettings.maxOrders", "maxOrdersPerSymbol: signalSettings.maxOrdersPerSymbol"]) expect(route).toContain(f)
  })
  test("the connection card and the analytics dashboard show Positions/Orders", () => {
    expect(src("components/dashboard/active-connection-card.tsx")).toContain('label: "Signal positions/orders"')
    expect(src("components/statistics/indication-analytics-dashboard.tsx")).toContain('"Positions / Orders"')
  })
  test("the form has separate fields for positions and orders", () => {
    const form = src("components/settings/signal-indication-settings.tsx")
    expect(form).toContain('["maxPositionsTotal", "Max positions (one per symbol + direction; default 100)", 1, 350, 1]')
    expect(form).toContain('["maxOrders", "Max orders incl. position rows and partial fills (0 = unlimited)", 0, 1000000, 1]')
  })
})

describe("the slot index never breaks a position's lifecycle", () => {
  test("a client without a readable count keeps the slot instead of throwing", async () => {
    const calls: string[] = []
    const client = { async srem(k: string) { calls.push(`srem ${k}`); return 1 } } as any // no scard at all
    await expect(releaseSignalSlotRow(client, "bingx-x02", "SOLUSDT", "long", "row-1")).resolves.toBeUndefined()
    expect(calls).toEqual(["srem signal:positions:bingx-x02:slot:SOLUSDT:long"]) // the slot member was NOT removed
  })
  test("a count that fails keeps the slot as well", async () => {
    const client = { async srem() { return 1 }, scard() { return Promise.reject(new Error("redis down")) }, sadd: jest.fn() } as any
    await releaseSignalSlotRow(client, "bingx-x02", "SOLUSDT", "long", "row-1")
    expect(client.sadd).not.toHaveBeenCalled()
  })
})
