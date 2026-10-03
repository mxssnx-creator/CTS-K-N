import { activeControlReferences, selectStaleOwnControlOrders, STALE_CONTROL_MIN_AGE_MS, sweepStaleOwnControlOrders } from "@/lib/trade-engine/stale-control-sweep"
import { clientOrderTypedPrefix } from "@/lib/system-order-ownership"

const CONN = "bingx-x02"
const OWN = String((clientOrderTypedPrefix as any)(CONN))
const NOW = 1_800_000_000_000
const old = NOW - STALE_CONTROL_MIN_AGE_MS - 60_000
const order = (over: Record<string, any>) => ({ symbol: "NEAR-USDT", positionSide: "SHORT", type: "STOP_MARKET", orderId: "1", clientOrderId: `${OWN}x1`, time: old, ...over })
const row = { status: "open", symbol: "NEARUSDT", direction: "short", executedQuantity: 3, stopLossOrderId: "10", takeProfitOrderId: "11", securityStopOrderId: "12" }

describe("own protection orders that no open row carries are swept (X02: 14 surplus, NEAR short 5 for 3 NEAR)", () => {
  test("the NEAR picture: the row's three controls stay, the surplus own ones are selected", () => {
    const orders = [
      order({ orderId: "10" }), order({ orderId: "11", type: "TAKE_PROFIT_MARKET" }), order({ orderId: "12" }),
      order({ orderId: "20" }), order({ orderId: "21" }), order({ orderId: "22", type: "TAKE_PROFIT_MARKET" }),
    ]
    expect(selectStaleOwnControlOrders(orders, [row], CONN, NOW).map((o) => o.orderId)).toEqual(["20", "21", "22"])
  })
  test("never another system's order, never a non-protection type, never one younger than ten minutes", () => {
    const orders = [
      order({ orderId: "30", clientOrderId: "cbx02lsemusu489fsrn4" }),
      order({ orderId: "31", clientOrderId: "ctsav2_abc" }),
      order({ orderId: "32", type: "LIMIT" }),
      order({ orderId: "33", time: NOW - 60_000 }),
      order({ orderId: "34", time: undefined }),
    ]
    expect(selectStaleOwnControlOrders(orders, [row], CONN, NOW)).toEqual([])
  })
  test("pending submissions and every *OrderId field of non-terminal rows count as active; terminal rows do not", () => {
    const rows = [
      { ...row, pendingProtectionOrders: JSON.stringify({ stopLoss: { clientOrderId: `${OWN}pend` } }) },
      { status: "open", aggregateSecurityStopOrderId: "40" },
      { status: "closed", stopLossOrderId: "41" },
    ]
    const refs = activeControlReferences(rows)
    expect(refs.ids.has("40")).toBe(true); expect(refs.ids.has("41")).toBe(false); expect(refs.clientIds.has(`${OWN}pend`)).toBe(true)
    const orders = [order({ orderId: "40" }), order({ orderId: "41" }), order({ orderId: "42", clientOrderId: `${OWN}pend` })]
    expect(selectStaleOwnControlOrders(orders, rows, CONN, NOW).map((o) => o.orderId)).toEqual(["41"])
  })
  test("the sweep cancels the selected ones and does nothing when the list is not authoritative", async () => {
    const cancelled: string[] = []
    const connector = (ok: boolean) => ({
      getOpenOrders: async () => [order({ orderId: "10" }), order({ orderId: "20" })],
      getLastOpenOrdersSnapshotStatus: () => ({ ok }),
      cancelOrder: async (_s: string, id: string) => { cancelled.push(id); return { success: true } },
    })
    const r = await sweepStaleOwnControlOrders(connector(true), CONN, [row], NOW)
    expect(cancelled).toEqual(["20"]); expect(r.cancelled).toHaveLength(1)
    cancelled.length = 0
    expect((await sweepStaleOwnControlOrders(connector(false), CONN, [row], NOW)).cancelled).toEqual([])
    expect(cancelled).toEqual([])
  })
})
