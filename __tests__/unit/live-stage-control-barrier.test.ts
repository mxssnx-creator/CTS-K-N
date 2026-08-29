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
    getTicker: jest.fn(async () => ({ bid: 99.9, ask: 100.1, last: 100 })),
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
  test("keeps closing and partially-closing exposure in the occupied execution slot", () => {
    expect(__liveStageTest.isActiveLiveSlotStatus("closing")).toBe(true)
    expect(__liveStageTest.isActiveLiveSlotStatus(" CLOSING_PARTIAL ")).toBe(true)
    expect(__liveStageTest.isActiveLiveSlotStatus("closed")).toBe(false)
  })

  test("keeps observing the same timed-out protection write and accepts its late acknowledgement", async () => {
    const placementPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ success: true, orderId: 123456 }), 10)
    })
    const exchange = connector({
      getOrderDetails: jest.fn(async () => null),
      getOpenOrder: jest.fn(async () => null),
    })

    await expect(__liveStageTest.reconcileAmbiguousProtectionWrite({
      connector: exchange,
      symbol: "BTCUSDT",
      clientOrderId: "cts-sl-late-ack",
      placementPromise,
      initialError: "Timeout after 8000ms",
      graceMs: 100,
    })).resolves.toMatchObject({
      success: true,
      orderId: "123456",
      recoveredFromAmbiguousWrite: "late_acknowledgement",
    })
    expect(exchange.getOrderDetails).not.toHaveBeenCalled()
  })

  test("recovers a response-lost protection write by client ID without resubmission", async () => {
    const getOrderDetails = jest.fn(async (_symbol: string, _orderId: string | undefined, clientOrderId: string) => ({
      orderId: "venue-stop-1",
      clientOrderId,
      status: "open",
    }))
    const exchange = connector({ getOrderDetails })

    await expect(__liveStageTest.reconcileAmbiguousProtectionWrite({
      connector: exchange,
      symbol: "BTCUSDT",
      clientOrderId: "cts-sl-response-lost",
      placementPromise: Promise.resolve({ success: false, error: "socket reset" }),
      initialError: "socket reset",
      graceMs: 1,
    })).resolves.toMatchObject({
      success: true,
      orderId: "venue-stop-1",
      clientOrderId: "cts-sl-response-lost",
      recoveredFromAmbiguousWrite: "client_order_id",
    })
    expect(getOrderDetails).toHaveBeenCalledWith(
      "BTCUSDT",
      undefined,
      "cts-sl-response-lost",
    )
  })

  test("does not reconcile a definite venue rejection as an ambiguous write", async () => {
    const exchange = connector({ getOrderDetails: jest.fn(async () => null) })
    await expect(__liveStageTest.reconcileAmbiguousProtectionWrite({
      connector: exchange,
      symbol: "BTCUSDT",
      clientOrderId: "cts-sl-rejected",
      placementPromise: Promise.resolve({ success: false, error: "invalid quantity" }),
      initialError: "BingX stop order error (code=100400): invalid quantity",
      graceMs: 1,
    })).resolves.toBeNull()
    expect(exchange.getOrderDetails).not.toHaveBeenCalled()
  })

  test("selects side-aware authoritative venue ticker prices", () => {
    const ticker = __liveStageTest.normalizeVenueTicker({
      bidPrice: "0.0099",
      askPrice: "0.0101",
      lastPrice: "0.01",
    })
    expect(ticker).toEqual({ bid: 0.0099, ask: 0.0101, last: 0.01 })
    expect(__liveStageTest.selectVenueTickerPrice(ticker, "long")).toBe(0.0101)
    expect(__liveStageTest.selectVenueTickerPrice(ticker, "short")).toBe(0.0099)
    expect(__liveStageTest.selectVenueTickerPrice({ bid: 0, ask: 0, last: 0.01 }, "long")).toBe(0.01)
  })

  test("rounds row TP/SL to venue ticks without loosening the strategy boundary", () => {
    expect(__liveStageTest.normalizeProtectionTriggerPrice(95.11, 0.1, "long", "stop_loss")).toBe(95.2)
    expect(__liveStageTest.normalizeProtectionTriggerPrice(105.19, 0.1, "long", "take_profit")).toBe(105.1)
    expect(__liveStageTest.normalizeProtectionTriggerPrice(105.19, 0.1, "short", "stop_loss")).toBe(105.1)
    expect(__liveStageTest.normalizeProtectionTriggerPrice(95.11, 0.1, "short", "take_profit")).toBe(95.2)
  })

  test("projects pseudo trailing stops into the live fill price domain", () => {
    expect(__liveStageTest.translatePseudoTrailingStopPrice(98, 100, 0.01)).toBeCloseTo(0.0098, 12)
    expect(__liveStageTest.translatePseudoTrailingStopPrice(0.0098, 0, 0.01)).toBeCloseTo(0.0098, 12)
    expect(__liveStageTest.translatePseudoTrailingStopPrice(98, 0, 0.01)).toBeUndefined()
    expect(__liveStageTest.translatePseudoTrailingStopPrice(1_500, 100, 0.01)).toBeUndefined()
  })

  test("repairs unmistakable historic/live price-domain corruption and rebases automatic trailing", () => {
    const position = livePosition({
      entryPrice: 100,
      averageExecutionPrice: 0.01,
      initialEntryPrice: 0.01,
      trailingActive: true,
      trailingStopPrice: 98,
    })
    expect(__liveStageTest.repairLiveEntryPriceDomain(position, 0.01)).toBe(true)
    expect(position.entryPrice).toBe(0.01)
    expect(position.averageExecutionPrice).toBe(0.01)
    expect(position.initialEntryPrice).toBe(0.01)
    expect(position.trailingStopPrice).toBeCloseTo(0.0098, 12)
  })

  test("preserves explicit operator protection while repairing only the corrupted entry domain", () => {
    const position = livePosition({
      entryPrice: 100,
      averageExecutionPrice: 0.01,
      initialEntryPrice: 0.01,
      trailingActive: true,
      trailingStopPrice: 98,
      manualProtectionOverride: {
        stopLossPrice: 95,
        takeProfitPrice: 105,
        updatedAt: 1,
        source: "operator",
      },
    })
    expect(__liveStageTest.repairLiveEntryPriceDomain(position, 0.01)).toBe(true)
    expect(position.entryPrice).toBe(0.01)
    expect(position.trailingStopPrice).toBe(98)
    expect(position.manualProtectionOverride).toMatchObject({ stopLossPrice: 95, takeProfitPrice: 105 })
  })

  test("does not misclassify a legitimate DCA average as cross-domain corruption", () => {
    const position = livePosition({
      entryPrice: 100,
      initialEntryPrice: 100,
      averageExecutionPrice: 60,
      trailingActive: true,
      trailingStopPrice: 98,
    })
    expect(__liveStageTest.repairLiveEntryPriceDomain(position, 60)).toBe(false)
    expect(position.entryPrice).toBe(100)
    expect(position.initialEntryPrice).toBe(100)
    expect(position.averageExecutionPrice).toBe(60)
    expect(position.trailingStopPrice).toBe(98)
  })

  test("finalizes only zero-fill pre-entry rows that have no exchange handle", () => {
    for (const status of ["placed", "pending", "pending_fill", "placed_unconfirmed"] as const) {
      expect(__liveStageTest.isPreFillWithoutExchangeHandle(
        { executedQuantity: 0 },
        status,
        false,
      )).toBe(true)
    }
    expect(__liveStageTest.isPreFillWithoutExchangeHandle(
      { executedQuantity: 0.01 },
      "placed_unconfirmed",
      false,
    )).toBe(false)
    expect(__liveStageTest.isPreFillWithoutExchangeHandle(
      { executedQuantity: 0 },
      "placed_unconfirmed",
      true,
    )).toBe(false)
    expect(__liveStageTest.isPreFillWithoutExchangeHandle(
      { executedQuantity: 0 },
      "open",
      false,
    )).toBe(false)
  })

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

    expect(__liveStageTest.readAbsoluteProtectionPrices(livePosition({
      stopLoss: 5,
      takeProfit: 10,
      manualProtectionOverride: { stopLossPrice: null, takeProfitPrice: null, updatedAt: 1 },
    }))).toEqual({ desiredSl: 95, desiredTp: 110.00000000000001 })
  })

  test("fails closed instead of treating an unknown protection direction as short", () => {
    expect(__liveStageTest.readAbsoluteProtectionPrices(livePosition({
      direction: "sideways",
      side: "unknown",
      stopLoss: 5,
      takeProfit: 10,
    }))).toEqual({ desiredSl: 0, desiredTp: 0 })

    expect(__liveStageTest.readAbsoluteProtectionPrices(livePosition({
      direction: "unknown",
      side: "SELL",
      stopLoss: 5,
      takeProfit: 10,
    }))).toEqual({ desiredSl: 105, desiredTp: 90 })
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

  test("records the actual BingX quantity after a 110424 protection retry", async () => {
    const placeStopOrder = jest
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "BingX stop order error (code=110424): The order size must be less than the available amount of 0.4 BTC",
      })
      .mockResolvedValueOnce({ success: true, orderId: "adjusted-sl" })
    const exchange = connector({ placeStopOrder })

    await expect(__liveStageTest.placeProtectionOrder(
      exchange,
      "BTCUSDT",
      "sell",
      1,
      95,
      "StopLoss",
      "long",
      "cts-sl-adjusted",
    )).resolves.toEqual({ orderId: "adjusted-sl", armedQuantity: 0.4 })

    expect(placeStopOrder).toHaveBeenNthCalledWith(
      1,
      "BTCUSDT",
      "sell",
      1,
      95,
      "stop_loss",
      expect.objectContaining({ clientOrderId: "cts-sl-adjusted", positionSide: "LONG", reduceOnly: true }),
    )
    expect(placeStopOrder).toHaveBeenNthCalledWith(
      2,
      "BTCUSDT",
      "sell",
      0.4,
      95,
      "stop_loss",
      expect.objectContaining({ clientOrderId: "cts-sl-adjusted", positionSide: "LONG", reduceOnly: true }),
    )
  })

  test("places security as one exact aggregate-quantity hedge-side stop", async () => {
    const placeStopOrder = jest.fn(async () => ({ success: true, orderId: "slot-security" }))
    const exchange = connector({ placeStopOrder })

    await expect(__liveStageTest.placeProtectionOrder(
      exchange,
      "BTCUSDT",
      "sell",
      1.25,
      94,
      "SecurityStop",
      "long",
      "cts-security-slot",
    )).resolves.toEqual({ orderId: "slot-security", armedQuantity: 1.25 })

    expect(placeStopOrder).toHaveBeenCalledTimes(1)
    expect(placeStopOrder).toHaveBeenCalledWith(
      "BTCUSDT",
      "sell",
      1.25,
      94,
      "stop_loss",
      expect.objectContaining({
        clientOrderId: "cts-security-slot",
        reduceOnly: true,
        hedgeMode: true,
        positionSide: "LONG",
      }),
    )
    expect(placeStopOrder.mock.calls[0][5]).not.toHaveProperty("closePosition")

    placeStopOrder.mockReset()
    placeStopOrder.mockResolvedValueOnce({
      success: false,
      error: "BingX stop order error (code=110424): available amount of 0.4 BTC",
    }).mockResolvedValueOnce({ success: true, orderId: "slot-security-adjusted" })
    await expect(__liveStageTest.placeProtectionOrder(
      exchange,
      "BTCUSDT",
      "sell",
      1.25,
      94,
      "SecurityStop",
      "long",
      "cts-security-quantity-retry",
    )).resolves.toEqual({ orderId: "slot-security-adjusted", armedQuantity: 0.4 })
    expect(placeStopOrder).toHaveBeenCalledTimes(2)
    expect(placeStopOrder.mock.calls[1][2]).toBe(0.4)
  })

  test("detects aggregate security quantity drift at venue-step tolerance", () => {
    expect(__liveStageTest.securityStopQuantityDrifted(2, 2, 0.0005)).toBe(false)
    expect(__liveStageTest.securityStopQuantityDrifted(1.9996, 2, 0.0005)).toBe(false)
    expect(__liveStageTest.securityStopQuantityDrifted(1.9994, 2, 0.0005)).toBe(true)
    expect(__liveStageTest.securityStopQuantityDrifted(0, 2, 0.0005)).toBe(true)
    expect(__liveStageTest.securityStopQuantityDrifted(Number.NaN, 2, 0.0005)).toBe(true)
  })

  test("defers only price-only security rearm through the BingX duplicate-order window", () => {
    const now = 10_000
    const position = livePosition({
      securityStopOrderId: "security-live",
      securityStopLastArmedAt: now - 1_249,
    })

    expect(__liveStageTest.securityStopPriceRearmDeferred(position, true, false, now)).toBe(true)
    expect(__liveStageTest.securityStopPriceRearmDeferred(
      { ...position, securityStopLastArmedAt: now - 1_250 },
      true,
      false,
      now,
    )).toBe(false)
    expect(__liveStageTest.securityStopPriceRearmDeferred(position, true, true, now)).toBe(false)
    expect(__liveStageTest.securityStopPriceRearmDeferred(position, false, false, now)).toBe(false)
    expect(__liveStageTest.securityStopPriceRearmDeferred(
      { ...position, securityStopOrderId: undefined },
      true,
      false,
      now,
    )).toBe(false)
  })

  test("tracks stop-loss and take-profit armed quantities independently", () => {
    const position = livePosition({
      takeProfitOrderId: "tp-1",
      takeProfitPrice: 110,
      protectionArmedQuantity: 1,
      stopLossArmedQuantity: undefined,
      takeProfitArmedQuantity: undefined,
    })

    __liveStageTest.setProtectionLegArmedQuantity(position, "stop_loss", 0.4)
    __liveStageTest.setProtectionLegArmedQuantity(position, "take_profit", 1)

    expect(__liveStageTest.protectionLegArmedQuantity(position, "stop_loss")).toBe(0.4)
    expect(__liveStageTest.protectionLegArmedQuantity(position, "take_profit")).toBe(1)
    expect(position.protectionArmedQuantity).toBe(0.4)

    // An explicit zero means this venue leg is not armed. It must not inherit
    // the sibling leg's quantity from the legacy aggregate field.
    __liveStageTest.setProtectionLegArmedQuantity(position, "stop_loss", 0)
    expect(__liveStageTest.protectionLegArmedQuantity(position, "stop_loss")).toBe(0)
    expect(position.protectionArmedQuantity).toBe(0)

    __liveStageTest.setProtectionLegArmedQuantity(position, "stop_loss", 1)
    expect(position.protectionArmedQuantity).toBe(1)
  })

  test("requires two authoritative absences before clearing protection ids and quantities", () => {
    const position = livePosition({
      takeProfitOrderId: "tp-1",
      takeProfitPrice: 110,
      stopLossArmedQuantity: 0.4,
      takeProfitArmedQuantity: 1,
      protectionArmedQuantity: 0.4,
    })
    const result = { changed: false }

    __liveStageTest.clearMissingProtectionOrderIds(position, new Set(["tp-1"]), result)

    expect(result.changed).toBe(true)
    expect(position.stopLossOrderId).toBe("sl-1")
    expect(position.stopLossAbsenceConfirmations).toBe(1)
    expect(position.stopLossArmedQuantity).toBe(0.4)

    result.changed = false
    __liveStageTest.clearMissingProtectionOrderIds(position, new Set(["tp-1"]), result)
    expect(result.changed).toBe(true)
    expect(position.stopLossOrderId).toBeUndefined()
    expect(position.stopLossPrice).toBe(0)
    expect(position.stopLossArmedQuantity).toBe(0)
    expect(position.takeProfitOrderId).toBe("tp-1")
    expect(position.takeProfitArmedQuantity).toBe(1)
    expect(position.protectionArmedQuantity).toBe(1)

    result.changed = false
    __liveStageTest.clearMissingProtectionOrderIds(position, new Set(), result)
    expect(result.changed).toBe(true)
    expect(position.takeProfitOrderId).toBe("tp-1")
    expect(position.takeProfitAbsenceConfirmations).toBe(1)

    result.changed = false
    __liveStageTest.clearMissingProtectionOrderIds(position, new Set(), result)
    expect(result.changed).toBe(true)
    expect(position.takeProfitOrderId).toBeUndefined()
    expect(position.takeProfitArmedQuantity).toBe(0)
    expect(position.protectionArmedQuantity).toBe(0)
  })

  test("does not cancel-replace a drifted row control after only one missing snapshot", async () => {
    const position = livePosition({
      stopLoss: 4,
      takeProfit: 0,
      stopLossOrderId: "possibly-filled-sl",
      stopLossPrice: 95,
      stopLossArmedQuantity: 1,
      stopLossLastArmedAt: 0,
      priceTick: 0.1,
    })
    const exchange = connector({
      placeStopOrder: jest.fn(async () => ({ success: true, orderId: "must-not-duplicate" })),
    })

    await expect(__liveStageTest.updateProtectionOrders(
      exchange,
      position,
      "first_absence",
      new Set(),
    )).resolves.toMatchObject({ changed: true, slPlaced: false })

    expect(position.stopLossOrderId).toBe("possibly-filled-sl")
    expect(position.stopLossAbsenceConfirmations).toBe(1)
    expect(exchange.cancelOrder).not.toHaveBeenCalled()
    expect(exchange.placeStopOrder).not.toHaveBeenCalled()
  })

  test("keeps every non-empty venue and client id alias in the liveness snapshot", async () => {
    const exchange = connector({
      getOpenOrders: jest.fn(async () => [{
        id: "",
        orderId: "venue-sl-alias",
        clientOrderId: "",
        clientOrderID: "client-sl-alias",
        type: "STOP_MARKET",
      }]),
    })

    const ids = await __liveStageTest.fetchLiveOrderIdSet(exchange)

    expect(ids).not.toBeNull()
    expect([...ids!]).toEqual(expect.arrayContaining(["venue-sl-alias", "client-sl-alias"]))
    expect(ids?.observedOrderCount).toBe(1)
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

  test("keeps DCA and Special quantity independent from additive Block targets", async () => {
    const plan = await __liveStageTest.resolveAccumulationPlan(
      "connection-control-test",
      livePosition({
        initialExecutedQuantity: 1,
        blockBaseQuantity: 1,
        // Two units were added by a non-Block lane.
        executedQuantity: 3,
        quantity: 3,
        blockLegs: [],
      }),
      {
        setVariant: "block",
        setKey: "BTCUSDT:signal:long#block:2#independent",
        blockVolumeRatio: 0.5,
      },
      100,
    )

    expect(plan).toMatchObject({
      variant: "block",
      blockCount: 2,
      blockBaseQuantity: 1,
      blockConfirmedAddQuantity: 0,
      blockTargetAddQuantity: 1,
      blockTargetQuantity: 2,
      addQty: 1,
    })
  })

  test("subtracts only confirmed Block fills at every count", async () => {
    const existing = livePosition({
      initialExecutedQuantity: 2,
      blockBaseQuantity: 2,
      executedQuantity: 9,
      quantity: 9,
      // Six additional units may exist for unrelated adjustments; only the
      // confirmed two-unit Block leg consumes this Count-3 target.
      blockLegs: [{ quantity: 2 }],
    })
    const plan = await __liveStageTest.resolveAccumulationPlan(
      "connection-control-test",
      existing,
      {
        setVariant: "block",
        setKey: "BTCUSDT:signal:long#block:3#independent",
        blockVolumeRatio: 1,
      },
      100,
    )

    expect(plan).toMatchObject({
      blockBaseQuantity: 2,
      blockConfirmedAddQuantity: 2,
      blockTargetAddQuantity: 6,
      blockTargetQuantity: 8,
      addQty: 4,
    })
  })

  test("grows the immutable Block base with cumulative fills from only the original entry", () => {
    const position = livePosition({
      initialExecutedQuantity: 0.4,
      blockBaseQuantity: 0.4,
      executedQuantity: 2.4,
      quantity: 3,
      blockLegs: [{ quantity: 1 }],
      dcaLegs: [{ quantity: 1 }],
    })

    expect(__liveStageTest.reconcileInitialEntryBaseQuantity(position, 1)).toBe(true)
    expect(position.initialExecutedQuantity).toBe(1)
    expect(position.blockBaseQuantity).toBe(1)
    expect(__liveStageTest.reconcileInitialEntryBaseQuantity(position, 0.8)).toBe(false)
    expect(position.initialExecutedQuantity).toBe(1)
    expect(position.blockBaseQuantity).toBe(1)
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

  test("keeps aggregate re-arm deferred until every physical quantity action is settled", () => {
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ status: "closing_partial", pendingSystemAction: { phase: "partial_wait" } }),
    )).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ pendingQuantityMutation: { phase: "position_verify" } }),
    )).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ pendingReduction: { clientOrderId: "reduce-pending" } }),
    )).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ pendingAccumulation: { clientOrderId: "add-pending" } }),
    )).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ aggregateProtectionMutationRequestedAt: 1 }),
    )).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsInFlight(
      livePosition({ status: "filled" }),
    )).toBe(false)
  })

  test("recovers only an authoritatively settled and abandoned aggregate hand-off", () => {
    const now = 100_000
    expect(__liveStageTest.aggregateProtectionMutationIsAbandoned(livePosition({
      aggregateProtectionMutationRequestedAt: 1,
      aggregateProtectionMutationSettledAt: now - 60_000,
    }), now)).toBe(true)
    expect(__liveStageTest.aggregateProtectionMutationIsAbandoned(livePosition({
      aggregateProtectionMutationRequestedAt: 1,
      aggregateProtectionMutationSettledAt: now - 59_999,
    }), now)).toBe(false)
    expect(__liveStageTest.aggregateProtectionMutationIsAbandoned(livePosition({
      aggregateProtectionMutationRequestedAt: 1,
      aggregateProtectionMutationSettledAt: now - 60_000,
      pendingReduction: { clientOrderId: "still-active" },
    }), now)).toBe(false)
    expect(__liveStageTest.aggregateProtectionMutationIsAbandoned(livePosition({
      aggregateProtectionMutationRequestedAt: 1,
    }), now)).toBe(false)
  })

  test("never defers individual row controls when Sets share one physical slot", () => {
    const tracking = {
      system_tracking_id: "sys-connection-control-test-control-test",
      connection_tracking_id: "conn-connection-control-test",
    }
    const first = livePosition({ id: "row-a", setKey: "set-a", stopLoss: 5, takeProfit: 10, ...tracking })
    const second = livePosition({ id: "row-b", setKey: "set-b", stopLoss: 4, takeProfit: 8, ...tracking })
    expect(__liveStageTest.initialAggregateProtectionCoordination(first, [first])).toMatchObject({
      deferred: false,
      slot: "BTCUSDT|long",
      memberCount: 1,
    })
    expect(__liveStageTest.initialAggregateProtectionCoordination(second, [first, second])).toMatchObject({
      deferred: false,
      slot: "BTCUSDT|long",
      memberCount: 2,
    })
  })

  test("projects only the shared security stop while retaining each Set's row controls", () => {
    const leader = livePosition({
      id: "leader",
      setKey: "set-leader",
      stopLoss: 5,
      takeProfit: 10,
      stopLossOrderId: "venue-sl",
      takeProfitOrderId: "venue-tp",
      takeProfitPrice: 110,
      securityStopOrderId: "venue-security",
      securityStopPrice: 89,
      securityStopRequired: true,
      securityStopStatus: "armed",
    })
    const member = livePosition({
      id: "member",
      setKey: "set-member",
      stopLoss: 4,
      takeProfit: 8,
      stopLossOrderId: "member-sl",
      takeProfitOrderId: "member-tp",
      stopLossPrice: 96,
      takeProfitPrice: 108,
    })
    expect(__liveStageTest.projectAggregateMemberCoverage(member, leader, {
      key: "BTCUSDT|long",
      leaderId: "leader",
      memberIds: ["leader", "member"],
      direction: "long",
      symbol: "BTCUSDT",
      systemQuantity: 2,
      venueQuantity: 2,
      quantityTolerance: 1e-8,
      ownershipMatches: true,
      desiredStopLoss: 95,
      desiredTakeProfit: 110,
      outerStopLoss: 95,
      maximumStopRange: 5,
      securityStopGap: 0.5,
      securityStopPrice: 89,
    })).toBe(true)
    expect(member.stopLossOrderId).toBe("member-sl")
    expect(member.takeProfitOrderId).toBe("member-tp")
    expect(member.protectionMode).toBe("exchange_control")
    expect(member.controlOrderSetCoverage?.["set-member"]).toMatchObject({
      protected: true,
      aggregateProtectionOwner: false,
      aggregateProtectionLeaderId: "leader",
      stopLossOrderId: "member-sl",
      takeProfitOrderId: "member-tp",
      stopLossPrice: 96,
      takeProfitPrice: 108,
      securityStopOrderId: "venue-security",
      securityStopPrice: 89,
      securityStopRequired: true,
      securityStopStatus: "armed",
      systemProtectionLegs: [],
    })
  })

  test("attributes a missing filled row control to its exact Set before aggregate inference", async () => {
    const older = livePosition({
      id: "row-older",
      createdAt: 1,
      executedQuantity: 1,
      quantity: 1,
      stopLossOrderId: "older-sl",
      takeProfitOrderId: "older-tp",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
    })
    const newer = livePosition({
      id: "row-newer",
      createdAt: 2,
      executedQuantity: 1,
      quantity: 1,
      stopLossOrderId: "newer-sl",
      takeProfitOrderId: "newer-tp",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
    })
    const exchange = connector({
      getOrder: jest.fn(async (_symbol: string, orderId: string) => orderId === "newer-sl"
        ? { orderId, status: "filled", filledQty: 0.4, filledPrice: 94 }
        : { orderId, status: "open", filledQty: 0 }),
    })
    const aggregateResult = {
      plans: [],
      changedPositions: 0,
      rearmedLeaders: 0,
      ownershipMismatches: 0,
      closedMemberIds: new Set<string>(),
    }

    await expect(__liveStageTest.settleFilledRowControlsAcrossMembers(
      "connection-control-test",
      exchange,
      [older, newer],
      new Set(["older-sl", "older-tp", "newer-tp"]),
      aggregateResult,
      async () => undefined,
    )).resolves.toBe(true)

    expect(older.executedQuantity).toBe(1)
    expect(older.stopLossOrderId).toBe("older-sl")
    expect(newer.executedQuantity).toBe(0.6)
    expect(newer.stopLossOrderId).toBeUndefined()
    expect(newer.takeProfitOrderId).toBe("newer-tp")
    expect(newer.partialOrderExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: "newer-sl", appliedQuantity: 0.4 }),
    ]))
  })

  test("restores protection only after a partial system-close order is terminal", () => {
    expect(__liveStageTest.isTerminalSystemCloseOrder(null)).toBe(false)
    expect(__liveStageTest.isTerminalSystemCloseOrder({ status: "open" })).toBe(false)
    expect(__liveStageTest.isTerminalSystemCloseOrder({ status: "partially_filled" })).toBe(false)
    expect(__liveStageTest.isTerminalSystemCloseOrder({ status: "filled" })).toBe(true)
    expect(__liveStageTest.isTerminalSystemCloseOrder({ status: "cancelled" })).toBe(true)
  })

  test("backs failed system closes off without skipping ambiguous-delivery recovery", () => {
    const now = 1_000_000
    const position = livePosition({
      pendingSystemAction: {
        token: "close-token",
        reason: "max_hold_time_exceeded",
        phase: "system_verify",
        startedAt: now - 35_000,
        updatedAt: now,
        clientOrderId: "cts-system-close-owned",
      },
    })

    const first = __liveStageTest.scheduleSystemCloseRetry(position, "Timeout after 35000ms", now)
    expect(first).toMatchObject({
      retryCount: 1,
      nextRetryAt: now + 60_000,
      lastFailureClass: "timeout",
    })
    expect(__liveStageTest.isSystemCloseRetryDeferred(position, now + 59_999)).toBe(true)
    expect(__liveStageTest.hasUnresolvedSystemCloseDelivery(position)).toBe(true)

    // A response-lost order remains recoverable under the same client id; only
    // after the barrier proves it absent may the ordinary backoff short-circuit.
    position.pendingSystemAction.clientOrderId = undefined
    expect(__liveStageTest.hasUnresolvedSystemCloseDelivery(position)).toBe(false)
    expect(__liveStageTest.isSystemCloseRetryDeferred(position, now + 60_000)).toBe(false)

    const second = __liveStageTest.scheduleSystemCloseRetry(position, "rate limit 429", now + 60_000)
    const third = __liveStageTest.scheduleSystemCloseRetry(position, "network socket reset", now + 180_000)
    const fourth = __liveStageTest.scheduleSystemCloseRetry(position, "503 unavailable", now + 420_000)
    const fifth = __liveStageTest.scheduleSystemCloseRetry(position, "venue rejected", now + 720_000)
    expect(second.nextRetryAt - second.updatedAt).toBe(120_000)
    expect(third.nextRetryAt - third.updatedAt).toBe(240_000)
    expect(fourth.nextRetryAt - fourth.updatedAt).toBe(300_000)
    expect(fifth.nextRetryAt - fifth.updatedAt).toBe(300_000)
    expect(second.lastFailureClass).toBe("rate_limit")
    expect(third.lastFailureClass).toBe("network")
    expect(fourth.lastFailureClass).toBe("venue_unavailable")
    expect(fifth.lastFailureClass).toBe("venue_rejection")
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

  test("does not archive a flat slot until response-lost protection writes are confirmed absent", async () => {
    const position = livePosition({
      stopLossOrderId: undefined,
      takeProfitOrderId: undefined,
      pendingProtectionOrders: {
        stopLoss: {
          clientOrderId: "cts-pending-sl",
          triggerPrice: 95,
          quantity: 1,
        },
      },
    })
    const exchange = connector({
      getOrder: jest.fn(async () => null),
      getOrderDetails: jest.fn(async () => null),
      getOpenOrder: jest.fn(async () => null),
      getPosition: jest.fn(async () => null),
      getOpenOrders: jest.fn(async () => []),
    })

    await expect(__liveStageTest.settleControlOrdersBeforeSystemClose(
      exchange,
      position,
      "exchange_externally_closed",
      100,
    )).resolves.toMatchObject({ decision: "wait" })
    expect(position.pendingProtectionOrders?.stopLoss).toBeDefined()
    expect(position.pendingSystemAction?.absenceConfirmations).toBe(1)

    await expect(__liveStageTest.settleControlOrdersBeforeSystemClose(
      exchange,
      position,
      "exchange_externally_closed",
      100,
    )).resolves.toMatchObject({ decision: "exchange_closed", authoritativeQuantity: 0 })
    expect(position.pendingProtectionOrders?.stopLoss).toBeUndefined()
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
