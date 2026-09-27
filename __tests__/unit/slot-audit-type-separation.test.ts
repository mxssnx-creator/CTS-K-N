import { auditProtectionSlotOrders } from "@/lib/protection-slot-order-audit"
import { clientOrderSystemTypePrefix } from "@/lib/system-order-ownership"

const conn = "bingx-x02"
const main = (s: string) => `${clientOrderSystemTypePrefix(conn, "main")}${s}`
const direct = (s: string) => `${clientOrderSystemTypePrefix(conn, "direct")}${s}`
const order = (id: string, clientOrderId: string, type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", quantity: number, stopPrice: number) =>
  ({ orderId: id, clientOrderId, symbol: "BTC-USDT", side: "SELL", positionSide: "LONG", type, origQty: quantity, stopPrice })
const mainRow = {
  id: "row-a", symbol: "BTC-USDT", direction: "long" as const, executionIntent: "main",
  executedQuantity: 0.0001, quantityStep: 0.0001, priceTick: 0.1,
  stopLossOrderId: "sl-a", stopLossPrice: 76_500, stopLossArmedQuantity: 0.0001,
  takeProfitOrderId: "tp-a", takeProfitPrice: 79_000, takeProfitArmedQuantity: 0.0001,
  securityStopOrderId: "sec-a", securityStopPrice: 76_200, securityStopArmedQuantity: 0.0001,
}
const own = [
  order("sl-a", main("sla"), "STOP_MARKET", 0.0001, 76_500),
  order("tp-a", main("tpa"), "TAKE_PROFIT_MARKET", 0.0001, 79_000),
  order("sec-a", main("seca"), "STOP_MARKET", 0.0001, 76_200),
]
const plan = { venueQuantity: 0.0001, quantityTolerance: 0.00005, securityStopPrice: 76_200 }
const audit = (openOrders: any[]) =>
  auditProtectionSlotOrders({ connectionId: conn, symbol: "BTCUSDT", direction: "long", members: [mainRow] as any, plan, openOrders } as any)

describe("a slot audited for one engine type ignores another type's controls", () => {
  test("baseline: the main row's own controls are complete and nothing is orphaned", () => {
    expect(audit(own).orphanOrders).toHaveLength(0)
  })
  test("a direct-trade stop on the same slot is not an orphan of the main rows", () => {
    const withDirect = audit([...own, order("dt-9", direct("sl9"), "STOP_MARKET", 0.0001, 76_000)])
    expect(withDirect.orphanOrders.map((o: any) => o.orderId)).not.toContain("dt-9")
  })
  test("an unmapped control of the SAME type is still an orphan", () => {
    const withStray = audit([...own, order("m-8", main("sl8"), "STOP_MARKET", 0.0001, 76_000)])
    expect(withStray.orphanOrders.map((o: any) => o.orderId)).toContain("m-8")
  })
})
