import { __liveStageTest } from "@/lib/trade-engine/stages/live-stage"
import { resolveCombinedPosCountDelta } from "@/lib/pos-count-live-target"

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({})),
  getRedisBackend: jest.fn(() => "redis-network"),
  getConnection: jest.fn(async () => null),
  getAppSettings: jest.fn(async () => ({})),
  getMarketData: jest.fn(async () => null),
  persistNow: jest.fn(async () => true),
}))

function livePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "live-control-test",
    connectionId: "connection-control-test",
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 100,
    averageExecutionPrice: 100,
    quantity: 1,
    executedQuantity: 1,
    remainingQuantity: 0,
    totalExecutedQuantity: 1,
    closedQuantity: 0,
    leverage: 10,
    marginType: "cross",
    fills: [],
    status: "filled",
    orderId: "entry-1",
    stopLossOrderId: "sl-1",
    stopLossPrice: 95,
    accumulatedSetKeys: ["set-a", "set-b"],
    combinedPosCounts: true,
    posCountsSetRatios: { "set-a": 0.25, "set-b": 0.75 },
    posCountsSetQuantities: { "set-a": 0.25, "set-b": 0.75 },
    progression: [],
    ...overrides,
  } as any
}

function connector(overrides: Record<string, unknown> = {}) {
  return {
    getOrder: jest.fn(async () => ({ orderId: "sl-1", status: "open", filledQty: 0 })),
    getPosition: jest.fn(async () => ({ quantity: 1 })),
    getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: true })),
    getOpenOrders: jest.fn(async () => []),
    getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: true })),
    cancelOrder: jest.fn(async () => ({ success: true })),
    placeOrder: jest.fn(async () => ({ success: true, orderId: "must-not-run-in-barrier" })),
    ...overrides,
  } as any
}

describe("executing Live-stage control barriers", () => {
  test("waits for an active trigger control order before allowing a system close", async () => {
    const position = livePosition()
    const exchange = connector({
      getOpenOrders: jest.fn(async () => [{ orderId: "sl-1" }]),
    })
    const result = await __liveStageTest.settleControlOrdersBeforeSystemClose(
      exchange,
      position,
      "sl_hit",
      95,
    )
    expect(result.decision).toBe("wait")
    expect(exchange.cancelOrder).not.toHaveBeenCalled()
    expect(exchange.placeOrder).not.toHaveBeenCalled()
    expect(position.pendingSystemAction?.phase).toBe("control_wait")
  })

  test("proceeds only after the owned control order is confirmed cancelled", async () => {
    const position = livePosition({
      pendingSystemAction: {
        token: "close-token",
        reason: "sl_hit",
        phase: "control_wait",
        startedAt: Date.now() - 20_000,
        updatedAt: Date.now() - 20_000,
      },
    })
    const exchange = connector()
    const result = await __liveStageTest.settleControlOrdersBeforeSystemClose(
      exchange,
      position,
      "sl_hit",
      95,
    )
    expect(result.decision).toBe("proceed_system")
    expect(exchange.cancelOrder).toHaveBeenCalledTimes(1)
    expect(position.stopLossOrderId).toBeUndefined()
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("records the control fill and suppresses a duplicate system close when exchange quantity is zero", async () => {
    const position = livePosition()
    const exchange = connector({
      getOrder: jest.fn(async () => ({ orderId: "sl-1", status: "filled", filledQty: 1, avgPrice: 95 })),
      getPosition: jest.fn(async () => null),
    })
    const result = await __liveStageTest.settleControlOrdersBeforeSystemClose(
      exchange,
      position,
      "sl_hit",
      95,
    )
    expect(result.decision).toBe("exchange_closed")
    expect(position.executedQuantity).toBe(0)
    expect(position.closedQuantity).toBe(1)
    expect(position.partialOrderExecutions).toHaveLength(1)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("settles protection independently before a position-volume change and preserves weighted parts", async () => {
    const position = livePosition()
    const exchange = connector({
      getPosition: jest.fn(async () => ({ quantity: 0.6 })),
    })
    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "poscounts_reduce"),
    ).resolves.toBe(true)
    expect(position.executedQuantity).toBeCloseTo(0.6, 12)
    expect(position.posCountsSetQuantities).toEqual({ "set-a": 0.15, "set-b": 0.45 })
    const execution = position.partialOrderExecutions?.[0]
    expect(Object.values(execution.setQuantityDeltas).reduce((sum: number, value: any) => sum + Number(value), 0)).toBeCloseTo(-0.4, 12)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("calculates the independent system delta only from the quantity left by a control partial fill", async () => {
    const position = livePosition()
    const exchange = connector({
      getOrder: jest.fn(async () => ({
        orderId: "sl-1",
        status: "filled",
        filledQty: 0.3,
        avgPrice: 97,
      })),
      getPosition: jest.fn(async () => ({ quantity: 0.7 })),
    })

    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "poscounts_reduce"),
    ).resolves.toBe(true)

    expect(position.executedQuantity).toBeCloseTo(0.7, 12)
    expect(resolveCombinedPosCountDelta(position.executedQuantity, 0.5)).toEqual({
      action: "reduce",
      quantity: 0.2,
    })
    expect(position.closedQuantity).toBeCloseTo(0.3, 12)
    expect(position.partialOrderExecutions).toHaveLength(1)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("does not allow a volume action when control cancellation is unconfirmed", async () => {
    const position = livePosition()
    const exchange = connector({ cancelOrder: jest.fn(async () => ({ success: false, error: "timeout" })) })
    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "accumulation"),
    ).resolves.toBe(false)
    expect(position.executedQuantity).toBe(1)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("keeps the quantity barrier durable until a later authoritative snapshot succeeds", async () => {
    const position = livePosition()
    const exchange = connector({
      getPosition: jest
        .fn()
        .mockRejectedValueOnce(new Error("temporary timeout"))
        .mockResolvedValueOnce({ quantity: 0.7 }),
    })

    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "poscounts_reduce"),
    ).resolves.toBe(false)
    expect(position.pendingQuantityMutation).toMatchObject({
      phase: "position_verify",
      quantityBefore: 1,
      controlOrderIds: ["sl-1"],
    })
    expect(position.stopLossOrderId).toBe("sl-1")

    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "poscounts_reduce"),
    ).resolves.toBe(true)
    expect(position.pendingQuantityMutation).toBeUndefined()
    expect(position.stopLossOrderId).toBeUndefined()
    expect(position.executedQuantity).toBeCloseTo(0.7, 12)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("synchronizes an exchange quantity change even when no control order is present", async () => {
    const position = livePosition({
      stopLossOrderId: undefined,
      stopLossPrice: 0,
      takeProfitOrderId: undefined,
      takeProfitPrice: 0,
    })
    const exchange = connector({ getPosition: jest.fn(async () => ({ quantity: 0.8 })) })

    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "accumulation"),
    ).resolves.toBe(true)
    expect(position.executedQuantity).toBeCloseTo(0.8, 12)
    expect(position.partialOrderExecutions?.[0]).toMatchObject({
      source: "exchange_reconcile",
      positionQuantityBefore: 1,
      positionQuantityAfter: 0.8,
    })
    expect(position.posCountsSetQuantities).toEqual({ "set-a": 0.2, "set-b": 0.6 })
  })

  test("uses a larger authoritative quantity as the basis for the next independent delta", async () => {
    const position = livePosition({
      stopLossOrderId: undefined,
      stopLossPrice: 0,
      takeProfitOrderId: undefined,
      takeProfitPrice: 0,
    })
    const exchange = connector({ getPosition: jest.fn(async () => ({ quantity: 1.2 })) })

    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "poscounts_increase"),
    ).resolves.toBe(true)
    expect(position.executedQuantity).toBeCloseTo(1.2, 12)
    expect(position.totalExecutedQuantity).toBeCloseTo(1.2, 12)
    expect(position.posCountsSetQuantities).toEqual({ "set-a": 0.3, "set-b": 0.9 })
    expect(position.partialOrderExecutions || []).toHaveLength(0)
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })
})
