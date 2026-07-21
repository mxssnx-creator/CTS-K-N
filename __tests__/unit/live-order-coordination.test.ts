import {
  allocateQuantityAcrossSets,
  allocateQuantityByRatios,
  decideControlOrderBarrier,
  reconcileCumulativeReduction,
  upsertPartialOrderExecution,
  type PartialOrderExecution,
} from "@/lib/live-order-coordination"

describe("Live exchange control/system action coordination", () => {
  test("waits across multiple cycles while a control order is active, then finalizes without a system double-close", () => {
    expect(decideControlOrderBarrier({
      localQuantity: 1,
      authoritativeQuantity: 1,
      authoritativeSnapshot: true,
      activeControlOrders: 1,
      unresolvedControlOrders: 0,
      pendingSubmissions: 0,
    })).toBe("wait")

    const partial = reconcileCumulativeReduction(1, 0.4, 0, 0.6)
    expect(partial).toEqual({ deltaApplied: 0.4, cumulativeApplied: 0.4, nextQuantity: 0.6 })
    expect(decideControlOrderBarrier({
      localQuantity: partial.nextQuantity,
      authoritativeQuantity: 0.6,
      authoritativeSnapshot: true,
      activeControlOrders: 1,
      unresolvedControlOrders: 0,
      pendingSubmissions: 0,
    })).toBe("wait")

    expect(decideControlOrderBarrier({
      localQuantity: partial.nextQuantity,
      authoritativeQuantity: 0,
      authoritativeSnapshot: true,
      activeControlOrders: 0,
      unresolvedControlOrders: 0,
      pendingSubmissions: 0,
    })).toBe("exchange_closed")
  })

  test("never applies the same cumulative partial fill twice", () => {
    const first = reconcileCumulativeReduction(1, 0.25, 0)
    const duplicate = reconcileCumulativeReduction(first.nextQuantity, 0.25, first.cumulativeApplied)
    const next = reconcileCumulativeReduction(duplicate.nextQuantity, 0.6, duplicate.cumulativeApplied)

    expect(first).toEqual({ deltaApplied: 0.25, cumulativeApplied: 0.25, nextQuantity: 0.75 })
    expect(duplicate).toEqual({ deltaApplied: 0, cumulativeApplied: 0.25, nextQuantity: 0.75 })
    expect(next).toEqual({ deltaApplied: 0.35, cumulativeApplied: 0.6, nextQuantity: 0.4 })
  })

  test("keeps combined Set quantities equal to every authoritative partial quantity", () => {
    for (const quantity of [1, 0.73, 0.4, 0.01, 0]) {
      const allocation = allocateQuantityAcrossSets(quantity, ["set-a", "set-b", "set-c", "set-a"])
      const sum = Object.values(allocation).reduce((total, value) => total + value, 0)
      expect(sum).toBeCloseTo(quantity, 11)
      expect(Object.keys(allocation)).toHaveLength(quantity > 0 ? 3 : 0)
    }
  })

  test("updates one bounded execution row as later partials arrive", () => {
    const row = (filled: number, remaining: number): PartialOrderExecution => ({
      id: "control:sl-1",
      source: "control_order",
      orderId: "sl-1",
      status: remaining > 0 ? "partially_filled" : "filled",
      requestedQuantity: 1,
      cumulativeFilledQuantity: filled,
      appliedQuantity: filled,
      positionQuantityBefore: 1,
      positionQuantityAfter: remaining,
      price: 99,
      setKeys: ["set-a", "set-b"],
      setQuantitiesBefore: allocateQuantityAcrossSets(1, ["set-a", "set-b"]),
      setQuantities: allocateQuantityAcrossSets(remaining, ["set-a", "set-b"]),
      setQuantityDeltas: {
        "set-a": -filled / 2,
        "set-b": -filled / 2,
      },
      updatedAt: filled * 1_000,
    })

    let ledger = upsertPartialOrderExecution([], row(0.4, 0.6))
    ledger = upsertPartialOrderExecution(ledger, row(1, 0))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      id: "control:sl-1",
      status: "filled",
      cumulativeFilledQuantity: 1,
      positionQuantityAfter: 0,
    })
  })

  test("keeps unequal strategy part ratios independent while summing exactly to the physical order", () => {
    const ratios = { "set-a": 0.05, "set-b": 0.15, "set-c": 0.3 }
    for (const quantity of [1, 0.75, 0.123456789, 0]) {
      const allocation = allocateQuantityByRatios(quantity, ratios)
      expect(Object.values(allocation).reduce((sum, value) => sum + value, 0)).toBeCloseTo(quantity, 11)
      if (quantity > 0) {
        expect(allocation["set-b"] / allocation["set-a"]).toBeCloseTo(3, 9)
        expect(allocation["set-c"] / allocation["set-a"]).toBeCloseTo(6, 9)
      }
    }
  })

  test("does not let unresolved or prepared control coordination overlap a system action", () => {
    expect(decideControlOrderBarrier({
      localQuantity: 1,
      authoritativeSnapshot: false,
      activeControlOrders: 0,
      unresolvedControlOrders: 1,
      pendingSubmissions: 0,
    })).toBe("wait")
    expect(decideControlOrderBarrier({
      localQuantity: 1,
      authoritativeSnapshot: true,
      authoritativeQuantity: 1,
      activeControlOrders: 0,
      unresolvedControlOrders: 0,
      pendingSubmissions: 1,
    })).toBe("wait")
    expect(decideControlOrderBarrier({
      localQuantity: 1,
      authoritativeSnapshot: true,
      authoritativeQuantity: 1,
      activeControlOrders: 0,
      unresolvedControlOrders: 0,
      pendingSubmissions: 0,
    })).toBe("proceed_system")
  })
})
