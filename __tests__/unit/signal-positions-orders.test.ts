import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  countSignalPositionOrders,
  evaluateSignalOrderCapacity,
  normalizeSignalMaxOrders,
  summarizeSignalCounts,
  SIGNAL_MAX_POSITIONS_DEFAULT,
} from "@/lib/signal-position-policy"
import { normalizeSignalIndicationSettings } from "@/lib/signal-indication"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("Signal positions and orders are separate limits", () => {
  test("positions default to 100, orders to unlimited", () => {
    expect(SIGNAL_MAX_POSITIONS_DEFAULT).toBe(100)
    const settings = normalizeSignalIndicationSettings({})
    expect(settings.maxPositionsTotal).toBe(100)
    expect(settings.maxOrders).toBe(0)
  })
  test("an operator value above 100 is kept up to 350; the orders limit is unlimited for 0, missing or invalid", () => {
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

describe("orders of a position: every order counts, partial fills included", () => {
  test("a bare entry is one order", () => {
    expect(countSignalPositionOrders({ orderId: "E1" })).toBe(1)
    expect(countSignalPositionOrders(null)).toBe(0)
    expect(countSignalPositionOrders({})).toBe(0)
  })
  test("entry, stop loss, take profit and security stop are four orders", () => {
    expect(countSignalPositionOrders({ orderId: "E1", stopLossOrderId: "S1", takeProfitOrderId: "T1", securityStopOrderId: "X1" })).toBe(4)
  })
  test("the same id in several fields is counted once", () => {
    expect(countSignalPositionOrders({
      orderId: "E1", fills: [{ orderId: "E1" }], settledOrderIds: ["E1"], entrySettlementOrderIds: ["E1"],
      exchangeData: { clientOrderIds: [{ clientOrderId: "E1" }] },
    })).toBe(1) // one order, one fill: every mention of E1 is the same order
    expect(countSignalPositionOrders({
      orderId: "E1", settledOrderIds: ["E1"], fills: [{ orderId: "E1" }, { orderId: "E1" }],
    })).toBe(2) // still one order, but it was filled twice: the second fill counts
  })
  test("each further fill of one order counts: an order filled in three parts is three", () => {
    expect(countSignalPositionOrders({ orderId: "E1", fills: [{ orderId: "E1" }, { orderId: "E1" }, { orderId: "E1" }] })).toBe(3)
  })
  test("add-on and close orders, tracked client ids and closing are all counted", () => {
    expect(countSignalPositionOrders({
      orderId: "E1", closeOrderId: "C1",
      fills: [{ orderId: "E1" }, { orderId: "A2" }],
      exchangeData: { clientOrderIds: [{ clientOrderId: "kt1", kind: "entry" }, { clientOrderId: "kt2", kind: "accumulation" }] },
    })).toBe(5) // E1, C1, A2, kt1, kt2
  })
})

describe("positions are counted independently per symbol and per direction", () => {
  const rows = [
    { symbol: "BTCUSDT", direction: "long", orders: 3 },
    { symbol: "BTC-USDT", direction: "short", orders: 2 },
    { symbol: "SOLUSDT", direction: "long", orders: 4 },
    { symbol: "SOLUSDT", direction: "long", orders: 1 },
    { symbol: "XRPUSDT", direction: "short", orders: 0 },
    { symbol: "XRPUSDT", direction: "weird", orders: 9 },
  ]
  test("a symbol held Long and Short counts twice; Long, Short, symbols and orders are separate figures", () => {
    const s = summarizeSignalCounts(rows as any)
    expect(s).toMatchObject({ positions: 5, long: 3, short: 2, symbols: 3, orders: 10 })
    expect(s.bySymbol.find((x) => x.symbol === "BTCUSDT")).toEqual({ symbol: "BTCUSDT", long: 1, short: 1, orders: 5 })
    expect(s.bySymbol.find((x) => x.symbol === "SOLUSDT")).toEqual({ symbol: "SOLUSDT", long: 2, short: 0, orders: 5 })
  })
  test("a row without a valid direction is ignored, not counted as a position or its orders", () => {
    expect(summarizeSignalCounts([{ symbol: "XRPUSDT", direction: "weird", orders: 9 }] as any)).toMatchObject({ positions: 0, orders: 0 })
  })
})

describe("wiring: enforcement, statistics and display", () => {
  const live = src("lib/trade-engine/stages/live-stage.ts")
  test("a finite order limit is checked at admission, and the unlimited default never reads any rows", () => {
    expect(live).toContain("if (maxOrders > 0) {")
    expect(live).toContain('reason: "order_limit",')
    expect(live).toContain("signalSettings.maxOrders,")
    const check = live.indexOf("if (maxOrders > 0) {")
    const read = live.indexOf("countActiveSignalOrders(client, connectionId)", check)
    expect(read).toBeGreaterThan(check)
  })
  test("the order check follows the position checks and precedes the reservation", () => {
    const symbol = live.indexOf("const symbolIndexKey = signalPositionAdmissionSymbolIndexKey(connectionId, candidate.symbol)")
    const orders = live.indexOf("if (maxOrders > 0) {", symbol)
    const reserve = live.indexOf("// Write the compact membership first.", orders)
    expect(orders).toBeGreaterThan(symbol)
    expect(reserve).toBeGreaterThan(orders)
  })
  test("statistics report positions and orders separately, with independent Long and Short", () => {
    const route = src("app/api/statistics/indications/route.ts")
    for (const f of ["openLong:", "openShort:", "openSymbols:", "openOrders:", "openBySymbol:", "maxOrders: signalSettings.maxOrders"]) expect(route).toContain(f)
  })
  test("the connection card and the analytics dashboard show Positions/Orders", () => {
    const card = src("components/dashboard/active-connection-card.tsx")
    expect(card).toContain('label: "Signal positions/orders"')
    expect(card).toContain('"∞"')
    const dash = src("components/statistics/indication-analytics-dashboard.tsx")
    expect(dash).toContain('"Positions / Orders"')
  })
  test("both limits are separate fields in the Signal settings form", () => {
    const form = src("components/settings/signal-indication-settings.tsx")
    expect(form).toContain('["maxPositionsTotal", "Max positions (Long and Short each counted; default 100)", 1, 350, 1]')
    expect(form).toContain('["maxOrders", "Max orders incl. partial fills (0 = unlimited)", 0, 1000000, 1]')
  })
})
