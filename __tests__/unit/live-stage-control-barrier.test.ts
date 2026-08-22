import {
  __liveStageTest,
  normalizeExchangePositionDirection,
  normalizeLiveTradeDirection,
} from "@/lib/trade-engine/stages/live-stage"
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
  test("books confirmed positions under their actual Real-stage variant", () => {
    expect(__liveStageTest.resolveConfirmedStrategyVariant({
      setVariant: "trailing",
    } as any, "BTCUSDT:signal:long#default#row_live")).toBe("trailing")

    expect(__liveStageTest.resolveConfirmedStrategyVariant({
      trailingProfile: { stopRatio: 0.01 },
    } as any, "BTCUSDT:signal:short#default#row_live")).toBe("trailing")

    // The adjustment that changed logistics/volume owns the category even
    // when it is attached to a position with a trailing Base profile.
    expect(__liveStageTest.resolveConfirmedStrategyVariant({
      setVariant: "trailing",
      trailingProfile: { stopRatio: 0.01 },
    } as any, "BTCUSDT:signal:long#block:3#row_live")).toBe("block")

    expect(__liveStageTest.resolveConfirmedStrategyVariant({
      setVariant: "default",
    } as any, "BTCUSDT:direction:long#row_live")).toBe("default")
  })

  test("shares manual, trailing and DCA absolute protection prices with system fallback", () => {
    expect(__liveStageTest.readAbsoluteProtectionPrices(livePosition({
      stopLoss: 5,
      takeProfit: 10,
      manualProtectionOverride: { stopLossPrice: 99, takeProfitPrice: 102, updatedAt: 1 },
    }))).toEqual({ desiredSl: 99, desiredTp: 102 })

    expect(__liveStageTest.readAbsoluteProtectionPrices(livePosition({
      stopLoss: 5,
      takeProfit: 10,
      trailingActive: true,
      trailingStopPrice: 101,
      dcaTakeProfitPrice: 103,
    }))).toEqual({ desiredSl: 101, desiredTp: 103 })
  })

  test("keeps explicit sub-one-percent pseudo protection values in percent units", () => {
    expect(__liveStageTest.resolvePseudoProtectionPercents({
      protection_coordinate: "absolute_pct",
      stoploss_pct: "0.8",
      takeprofit_pct: "0.5",
      // Legacy fields deliberately repeat the same sub-one-percent values.
      // They are percent values for current pseudo rows, not 80% / 50% ratios.
      stoploss_ratio: "0.8",
      takeprofit_factor: "0.5",
    })).toEqual({ slPct: 0.8, tpPct: 0.5 })

    expect(__liveStageTest.resolvePseudoProtectionPercents({
      protection_coordinate: "position_cost_ratio",
      position_cost_pct: "0.1",
      takeprofit_factor: "5",
      stoploss_ratio: "0.5",
    })).toEqual({ slPct: 0.25, tpPct: 0.5 })

    // Legacy rows without explicit coordinate fields retain their documented
    // decimal-ratio interpretation for compatibility.
    expect(__liveStageTest.resolvePseudoProtectionPercents({
      stoploss_ratio: "0.02",
      takeprofit_factor: "0.05",
    })).toEqual({ slPct: 2, tpPct: 5 })
  })

  test("rejects delayed trailing updates that would loosen exchange protection", () => {
    expect(__liveStageTest.isTrailingStopTightening(
      livePosition({ direction: "long", trailingStopPrice: 101 }),
      100.5,
    )).toBe(false)
    expect(__liveStageTest.isTrailingStopTightening(
      livePosition({ direction: "long", trailingStopPrice: 101 }),
      101.5,
    )).toBe(true)
    expect(__liveStageTest.isTrailingStopTightening(
      livePosition({ direction: "short", trailingStopPrice: 99 }),
      99.5,
    )).toBe(false)
    expect(__liveStageTest.isTrailingStopTightening(
      livePosition({ direction: "short", trailingStopPrice: 99 }),
      98.5,
    )).toBe(true)
  })

  test("keeps a just-armed trailing stop in place until its re-arm cooldown expires", async () => {
    const position = livePosition({
      stopLoss: 5,
      trailingActive: true,
      trailingStopPrice: 99,
      stopLossPrice: 98,
      stopLossLastArmedAt: Date.now(),
      protectionArmedQuantity: 1,
      exchangeData: { markPrice: 100 },
    })
    const exchange = connector({
      placeStopOrder: jest.fn(async () => ({ success: true, orderId: "replacement-sl" })),
    })

    await expect(
      __liveStageTest.updateProtectionOrders(
        exchange,
        position,
        "trailing_ratchet",
        new Set(["sl-1"]),
      ),
    ).resolves.toMatchObject({ changed: false, slPlaced: false })

    // Cancelling before the 200 ms trailing cooldown then declining to place
    // a replacement leaves an exchange position briefly unprotected. A recent
    // ratchet must therefore retain the currently armed stop unchanged.
    expect(exchange.cancelOrder).not.toHaveBeenCalled()
    expect(exchange.placeStopOrder).not.toHaveBeenCalled()
    expect(position.stopLossOrderId).toBe("sl-1")
    expect(position.stopLossPrice).toBe(98)
  })

  test("gives every Base-parent Pos-Count row its own direction-preserving slot", () => {
    const longA = __liveStageTest.liveExecutionSlot({
      combinedPosCounts: true,
      parentSetKey: "BTCUSDT:common:macd:cfg-a",
      setKey: "BTCUSDT:common:macd:cfg-a#poscounts:combined:long",
    } as any)
    const shortA = __liveStageTest.liveExecutionSlot({
      combinedPosCounts: true,
      parentSetKey: "BTCUSDT:common:macd:cfg-a",
      setKey: "BTCUSDT:common:macd:cfg-a#poscounts:combined:short",
    } as any)
    const longB = __liveStageTest.liveExecutionSlot({
      combinedPosCounts: true,
      parentSetKey: "BTCUSDT:common:macd:cfg-b",
      setKey: "BTCUSDT:common:macd:cfg-b#poscounts:combined:long",
    } as any)

    // Direction is encoded by the physical lock key outside the slot; the
    // parent slot remains stable for both sides while another config differs.
    expect(longA).toBe(shortA)
    expect(longA).not.toBe(longB)
    expect(longA).toMatch(/^poscounts-[a-z0-9]+$/)
  })

  test("does not charge virtual or zero-fill Block lanes against the physical accumulation cap", () => {
    const coveredKeys = Array.from({ length: 1_500 }, (_, index) => `signal-covered-${index}`)
    const setKeys = [
      "base-set",
      "physical-block",
      ...coveredKeys.flatMap((key, index) => [
        key,
        `block_lane:BTCUSDT:signal_source:source:s${index}:overall:3`,
      ]),
    ]
    const blockLegs = [
      {
        setKey: "physical-block",
        quantity: 0.5,
        requestedQuantity: 0.5,
      },
      ...coveredKeys.map((setKey) => ({
        setKey,
        quantity: 0,
        requestedQuantity: 0,
        targetSatisfied: true,
      })),
    ]

    expect(__liveStageTest.physicalAccumulationCount(setKeys, blockLegs)).toBe(2)
  })

  test("accepts only explicit exchange directions and never defaults malformed state", () => {
    expect(normalizeLiveTradeDirection("LONG")).toBe("long")
    expect(normalizeLiveTradeDirection(undefined, "sell")).toBe("short")
    expect(normalizeLiveTradeDirection("", "sideways", null)).toBeNull()
    expect(normalizeExchangePositionDirection("SHORT", "buy", 4)).toBe("short")
    expect(normalizeExchangePositionDirection("BOTH", undefined, -4)).toBe("short")
    expect(normalizeExchangePositionDirection("BOTH", undefined, 4)).toBe("long")
    expect(normalizeExchangePositionDirection("BOTH", undefined, 0)).toBeNull()
  })

  test("blocks every control and quantity mutation when the stored direction is invalid", async () => {
    const position = livePosition({ direction: "sideways", side: undefined, exchangeData: {} })
    const exchange = connector()

    await expect(
      __liveStageTest.settleControlOrdersBeforeSystemClose(exchange, position, "manual", 100),
    ).resolves.toMatchObject({ decision: "wait", detail: "invalid position direction" })
    await expect(
      __liveStageTest.settleControlOrdersBeforeQuantityMutation(exchange, position, "accumulation"),
    ).resolves.toBe(false)

    expect(exchange.getOrder).not.toHaveBeenCalled()
    expect(exchange.getPosition).not.toHaveBeenCalled()
    expect(exchange.getOpenOrders).not.toHaveBeenCalled()
    expect(exchange.cancelOrder).not.toHaveBeenCalled()
    expect(exchange.placeOrder).not.toHaveBeenCalled()
  })

  test("sweeps only owned protection for the matching hedge-mode direction", async () => {
    const openOrders = [
      {
        orderId: "long-sl",
        clientOrderId: "long-sl-client",
        side: "sell",
        positionSide: "LONG",
        type: "STOP_MARKET",
      },
      {
        orderId: "short-sl",
        clientOrderId: "short-sl-client",
        side: "buy",
        positionSide: "SHORT",
        type: "STOP_MARKET",
      },
      {
        orderId: "foreign-long-sl",
        clientOrderId: "manual-foreign",
        side: "sell",
        positionSide: "LONG",
        type: "STOP_MARKET",
      },
      {
        orderId: "wrong-position-side",
        clientOrderId: "long-owned-but-wrong-direction",
        side: "sell",
        positionSide: "SHORT",
        type: "STOP_MARKET",
      },
    ]
    const cancelOrder = jest.fn(async () => ({ success: true }))
    const exchange = connector({
      getOpenOrders: jest.fn(async () => openOrders),
      cancelOrder,
    })
    const long = livePosition({
      id: "long-position",
      direction: "long",
      stopLossOrderId: "long-sl",
      takeProfitOrderId: undefined,
      exchangeData: {
        clientOrderIds: [
          { kind: "stop_loss", clientOrderId: "long-sl-client" },
          { kind: "stop_loss", clientOrderId: "long-owned-but-wrong-direction" },
        ],
      },
    })
    const short = livePosition({
      id: "short-position",
      direction: "short",
      stopLossOrderId: "short-sl",
      takeProfitOrderId: undefined,
      exchangeData: {
        clientOrderIds: [{ kind: "stop_loss", clientOrderId: "short-sl-client" }],
      },
    })

    await expect(
      __liveStageTest.sweepOrphanProtectionOrders(exchange, "BTCUSDT", "sell", long),
    ).resolves.toEqual({ scanned: 4, cancelled: 1 })
    await expect(
      __liveStageTest.sweepOrphanProtectionOrders(exchange, "BTCUSDT", "buy", short),
    ).resolves.toEqual({ scanned: 4, cancelled: 1 })

    expect(cancelOrder.mock.calls.map((call) => call[1])).toEqual(["long-sl", "short-sl"])
  })

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
