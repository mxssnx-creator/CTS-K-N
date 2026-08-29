import {
  auditProtectionSlotOrders,
  isConnectionOwnedProtectionOrderForSlot,
  protectionClientOrderPrefix,
} from "@/lib/protection-slot-order-audit"

const members = [
  {
    id: "row-a",
    symbol: "BTCUSDT",
    direction: "long" as const,
    executedQuantity: 0.0001,
    quantityStep: 0.0001,
    priceTick: 0.1,
    stopLossOrderId: "sl-a",
    stopLossPrice: 76_500,
    stopLossArmedQuantity: 0.0001,
    takeProfitOrderId: "tp-a",
    takeProfitPrice: 79_000,
    takeProfitArmedQuantity: 0.0001,
  },
  {
    id: "row-b",
    symbol: "BTC-USDT",
    direction: "long" as const,
    executedQuantity: 0.0001,
    quantityStep: 0.0001,
    priceTick: 0.1,
    stopLossOrderId: "sl-b",
    stopLossPrice: 76_400,
    stopLossArmedQuantity: 0.0001,
    takeProfitOrderId: "tp-b",
    takeProfitPrice: 79_200,
    takeProfitArmedQuantity: 0.0001,
    securityStopOrderId: "sec-b",
    securityStopPrice: 76_200,
    securityStopArmedQuantity: 0.0002,
  },
]

const order = (
  id: string,
  clientOrderId: string,
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  quantity: number,
  stopPrice: number,
  extra: Record<string, unknown> = {},
) => ({
  orderId: id,
  clientOrderId,
  symbol: "BTC-USDT",
  side: "SELL",
  positionSide: "LONG",
  type,
  origQty: quantity,
  stopPrice,
  ...extra,
})

const exactOrders = [
  order("sl-a", "ctsbingxx02sla", "STOP_MARKET", 0.0001, 76_500),
  order("tp-a", "ctsbingxx02tpa", "TAKE_PROFIT_MARKET", 0.0001, 79_000),
  order("sl-b", "ctsbingxx02slb", "STOP_MARKET", 0.0001, 76_400),
  order("tp-b", "ctsbingxx02tpb", "TAKE_PROFIT_MARKET", 0.0001, 79_200),
  order("sec-b", "ctsbingxx02secb", "STOP_MARKET", 0.0002, 76_200),
]

const plan = {
  venueQuantity: 0.0002,
  quantityTolerance: 0.00005,
  securityStopPrice: 76_200,
}

describe("exact protection-slot venue audit", () => {
  test("requires two exact row pairs and one full-slot security stop", () => {
    const audit = auditProtectionSlotOrders({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      members,
      plan,
      openOrders: exactOrders,
    })

    expect(audit).toMatchObject({
      expectedComplete: true,
      complete: true,
      rowCount: 2,
      expectedControlOrderCount: 5,
      observedExpectedControlOrderCount: 5,
      exactStopLossOrders: 2,
      exactTakeProfitOrders: 2,
      exactSecurityOrders: 1,
      connectionOwnedSlotControlOrders: 5,
    })
    expect(audit.orphanOrders).toHaveLength(0)
    expect(audit.violations).toEqual([])
  })

  test("isolates one duplicate CTS security stop without touching foreign controls", () => {
    const duplicate = order(
      "sec-duplicate",
      "ctsbingxx02secduplicate",
      "STOP_MARKET",
      0.0001,
      76_200,
    )
    const foreign = order(
      "external-stop",
      "another-system-control",
      "STOP_MARKET",
      0.0002,
      76_100,
    )
    const otherConnection = order(
      "other-cts-stop",
      "ctsbingxx01security",
      "STOP_MARKET",
      0.0002,
      76_000,
    )
    const audit = auditProtectionSlotOrders({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      members,
      plan,
      openOrders: [...exactOrders, duplicate, foreign, otherConnection],
    })

    expect(audit.expectedComplete).toBe(true)
    expect(audit.complete).toBe(false)
    expect(audit.connectionOwnedSlotControlOrders).toBe(6)
    expect(audit.externalOrUnknownSlotControlOrdersPreserved).toBe(2)
    expect(audit.orphanOrders.map((entry) => entry.orderId)).toEqual(["sec-duplicate"])
  })

  test("fails closed on missing, wrong-quantity, or wrong-trigger row controls", () => {
    const badOrders = exactOrders
      .filter((entry) => entry.orderId !== "tp-a")
      .map((entry) => entry.orderId === "sl-a"
        ? { ...entry, origQty: 0.0002, stopPrice: 76_499 }
        : entry)
    const audit = auditProtectionSlotOrders({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      members,
      plan,
      openOrders: badOrders,
    })

    expect(audit.expectedComplete).toBe(false)
    expect(audit.violations).toEqual(expect.arrayContaining([
      "row_stop_loss_venue_quantity_mismatch",
      "row_stop_loss_trigger_mismatch",
      "row_take_profit_not_authoritatively_open",
    ]))
  })

  test("requires the exact connection prefix and explicit hedge direction for orphan ownership", () => {
    expect(protectionClientOrderPrefix("bingx-x02")).toBe("ctsbingxx02")
    expect(isConnectionOwnedProtectionOrderForSlot(
      order("owned", "ctsbingxx02sec", "STOP_MARKET", 0.0002, 76_000),
      "bingx-x02",
      "BTCUSDT",
      "long",
    )).toBe(true)
    expect(isConnectionOwnedProtectionOrderForSlot(
      { ...order("ambiguous", "ctsbingxx02sec", "STOP_MARKET", 0.0002, 76_000), positionSide: "" },
      "bingx-x02",
      "BTCUSDT",
      "long",
    )).toBe(false)
    expect(isConnectionOwnedProtectionOrderForSlot(
      order("wrong", "ctsbingxx01sec", "STOP_MARKET", 0.0002, 76_000),
      "bingx-x02",
      "BTCUSDT",
      "long",
    )).toBe(false)
  })
})
