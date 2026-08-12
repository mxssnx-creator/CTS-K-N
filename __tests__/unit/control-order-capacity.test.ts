import {
  BINGX_CONTROL_ORDER_LIMIT,
  ControlOrderCapacityBudget,
  countUniqueBingXControlOrders,
  planProtectionOrderBatches,
  type ProtectionOrderIntent,
} from "@/lib/control-order-capacity"

describe("BingX control-order capacity and batching", () => {
  test.each([
    { observed: 198, expected: [true, true, false], available: 0 },
    { observed: 199, expected: [true, false, false], available: 0 },
    { observed: 200, expected: [false, false, false], available: 0 },
  ])("coordinates the 200-order boundary at $observed", ({ observed, expected, available }) => {
    const budget = new ControlOrderCapacityBudget(observed)
    expect([
      budget.reserve("position-a:stop_loss"),
      budget.reserve("position-a:take_profit"),
      budget.reserve("position-b:stop_loss"),
    ]).toEqual(expected)
    expect(budget.snapshot()).toMatchObject({
      limit: BINGX_CONTROL_ORDER_LIMIT,
      observedOpen: observed,
      available,
      exhausted: true,
    })
  })

  test("is idempotent, credits confirmed cancellations once, and releases failed submissions", () => {
    const budget = new ControlOrderCapacityBudget(199)
    expect(budget.reserve("same-leg")).toBe(true)
    expect(budget.reserve("same-leg")).toBe(true)
    expect(budget.reserve("other-leg")).toBe(false)
    budget.releaseReservation("same-leg")
    expect(budget.reserve("other-leg")).toBe(true)
    budget.noteCancellation("venue-1")
    budget.noteCancellation("venue-1")
    expect(budget.reserve("third-leg")).toBe(true)
    expect(budget.snapshot()).toMatchObject({ observedOpen: 198, reserved: 2, available: 0 })
  })

  test("counts unique TP/SL venue rows without double-counting client IDs or ordinary entries", () => {
    expect(countUniqueBingXControlOrders([
      { orderId: "1", clientOrderId: "sl-a", type: "STOP_MARKET" },
      { orderId: "1", clientOrderId: "sl-a-duplicate", type: "STOP_MARKET" },
      { orderId: "2", type: "TAKE_PROFIT_MARKET" },
      { orderId: "3", type: "LIMIT" },
      { orderId: "4", type: "MARKET", triggerPrice: "123" },
    ])).toBe(3)
  })

  test("combines only economically identical intents and sends overflow to system handling", () => {
    const base = {
      connectionId: "bingx-x02",
      symbol: "BTC-USDT",
      direction: "long" as const,
      quantity: 0.01,
    }
    const intents: ProtectionOrderIntent[] = [
      { ...base, leg: "stop_loss", triggerPrice: 90, strategyId: "main-a" },
      { ...base, leg: "stop_loss", triggerPrice: 90, quantity: 0.02, strategyId: "signal-b" },
      { ...base, leg: "stop_loss", triggerPrice: 89, strategyId: "preset-c" },
      { ...base, leg: "take_profit", triggerPrice: 110, strategyId: "main-a" },
    ]
    const plan = planProtectionOrderBatches({
      intents,
      observedOpenControlOrders: 198,
    })

    expect(plan).toMatchObject({
      sourceIntentCount: 4,
      combinedOrderCount: 3,
      avoidedOrderCount: 1,
    })
    expect(plan.venueBatches).toHaveLength(2)
    expect(plan.systemBatches).toHaveLength(1)
    expect(plan.venueBatches.every((batch) => batch.leg === "stop_loss")).toBe(true)
    expect(plan.systemBatches[0]).toMatchObject({
      leg: "take_profit",
      handling: "system_close",
    })
    expect(plan.batches.find((batch) => batch.triggerPrice === 90)).toMatchObject({
      quantity: 0.03,
      sourceIntentCount: 2,
      strategyIds: ["main-a", "signal-b"],
    })
  })
})
