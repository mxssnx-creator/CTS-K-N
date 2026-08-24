import { reconcileExchangeQuantityAdjustments } from "@/lib/exchange-quantity-ledger"

describe("exchange quantity adjustment ledger", () => {
  test("removes a provisional adjustment once exact fills cover the lifetime quantity", () => {
    const result = reconcileExchangeQuantityAdjustments({
      positionId: "live-1",
      orderId: "entry-1",
      targetQuantity: 2,
      entryPrice: 100,
      fills: [{ quantity: 2 }],
      adjustments: [{
        id: "live-1:legacy",
        source: "legacy_reconciliation",
        quantity: 2,
        price: 100,
        timestamp: 1,
      }],
      timestamp: 2,
    })

    expect(result).toMatchObject({
      changed: true,
      fillQuantity: 2,
      previousManagedAdjustmentQuantity: 2,
      expectedManagedAdjustmentQuantity: 0,
      adjustments: [],
    })
  })

  test("shrinks the provisional gap instead of adding a second execution", () => {
    const result = reconcileExchangeQuantityAdjustments({
      positionId: "live-2",
      targetQuantity: 3,
      entryPrice: 50,
      fills: [{ quantity: 2 }],
      adjustments: [{
        id: "live-2:legacy",
        source: "legacy_reconciliation",
        quantity: 3,
        price: 50,
        timestamp: 1,
      }],
      timestamp: 2,
    })

    expect(result.changed).toBe(true)
    expect(result.adjustments).toEqual([
      expect.objectContaining({ source: "exchange_reconcile", quantity: 1, price: 50 }),
    ])
  })

  test("preserves unrelated adjustment sources and only manages the reconciliation gap", () => {
    const result = reconcileExchangeQuantityAdjustments({
      positionId: "live-3",
      targetQuantity: 4,
      entryPrice: 25,
      fills: [{ quantity: 2 }],
      adjustments: [{
        id: "external-audit",
        source: "external_audit",
        quantity: 1,
        price: 25,
        timestamp: 1,
      }],
      timestamp: 2,
    })

    expect(result.adjustments).toEqual([
      expect.objectContaining({ id: "external-audit", quantity: 1 }),
      expect.objectContaining({ source: "exchange_reconcile", quantity: 1 }),
    ])
  })
})
