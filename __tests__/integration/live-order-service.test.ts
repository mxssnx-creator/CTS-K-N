/**
 * Integration coverage for the shared live order service accounting contract.
 */

const hashStore = new Map<string, Record<string, any>>()
const kvStore = new Map<string, string>()
const setStore = new Map<string, Set<string>>()
const mockPersistNow = jest.fn(async () => true)

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async (id: string) => ({
    id,
    exchange: "mock",
    api_key: "1234567890",
    api_secret: "secret12345",
    is_testnet: "1",
    is_live_trade: "1",
    live_trade_requested: "1",
  })),
  getMarketData: jest.fn(async () => ({ latest: { close: 100 } })),
  savePosition: jest.fn(async (position: any) => {
    kvStore.set(`live:position:${position.id}`, JSON.stringify(position))
  }),
  getRedisBackend: jest.fn(() => "inline-local"),
  persistNow: (...args: unknown[]) => mockPersistNow(...args),
  getRedisClient: jest.fn(() => ({
    get: async (key: string) => kvStore.get(key) ?? null,
    set: async (key: string, value: string, options?: { NX?: boolean; XX?: boolean }) => {
      if (options?.NX && kvStore.has(key)) return null
      if (options?.XX && !kvStore.has(key)) return null
      kvStore.set(key, value)
      return "OK"
    },
    del: async (key: string) => kvStore.delete(key) ? 1 : 0,
    expire: async (key: string) => kvStore.has(key) || setStore.has(key) ? 1 : 0,
    hincrby: async (key: string, field: string, delta: number) => {
      const hash = hashStore.get(key) || {}
      hash[field] = String((Number(hash[field] || 0) || 0) + delta)
      hashStore.set(key, hash)
      return Number(hash[field])
    },
    hincrbyfloat: async (key: string, field: string, delta: number) => {
      const hash = hashStore.get(key) || {}
      hash[field] = String((Number(hash[field] || 0) || 0) + delta)
      hashStore.set(key, hash)
      return hash[field]
    },
    sadd: async (key: string, member: string) => {
      const set = setStore.get(key) || new Set<string>()
      const sizeBefore = set.size
      set.add(member)
      setStore.set(key, set)
      return set.size === sizeBefore ? 0 : 1
    },
  })),
}))

jest.mock("@/lib/live-order-safety", () => ({
  getLiveOrderSafetyFailure: jest.fn(() => null),
}))

jest.mock("@/lib/exchange-connectors/factory", () => ({
  createExchangeConnector: jest.fn(async () => ({
    setLeverage: jest.fn(async () => ({ success: true })),
    placeOrder: jest.fn(async () => ({
      success: true,
      orderId: "ex-1",
      status: "filled",
      filledQty: 2,
      filledPrice: 100,
    })),
  })),
}))

describe("live-order-service integration accounting", () => {
  beforeEach(() => {
    hashStore.clear()
    kvStore.clear()
    setStore.clear()
    mockPersistNow.mockClear()
    jest.resetModules()
  })

  test("manual/testing entry point creates the same counters and live position shape", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")

    const result = await placeLiveOrder({
      connectionId: "conn-a",
      symbol: "btcusdt",
      side: "long",
      quantity: 2,
      leverage: 5,
      safetyPayload: { confirm_live_order: true },
    })

    expect(result.success).toBe(true)
    expect(hashStore.get("progression:conn-a")).toMatchObject({
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_positions_created_count: "1",
      live_volume_usd_total: "200",
    })
    expect(hashStore.get("live_orders_by_symbol_v2:conn-a")).toMatchObject({
      "BTCUSDT:long:placed": "1",
      "BTCUSDT:long:filled": "1",
    })
    const saved = JSON.parse([...kvStore.values()][0])
    expect(saved).toMatchObject({
      connectionId: "conn-a",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      volumeUsd: 200,
    })
  })

  test("configures margin then leverage before a new entry and never changes venue settings for reduce-only exits", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const calls: string[] = []
    const connector = {
      setMarginType: jest.fn(async (_symbol: string, marginType: string) => {
        calls.push(`margin:${marginType}`)
        return { success: true }
      }),
      setLeverage: jest.fn(async (_symbol: string, leverage: number) => {
        calls.push(`leverage:${leverage}`)
        return { success: true }
      }),
      placeOrder: jest.fn(async () => {
        calls.push("order")
        return { success: true, orderId: "ordered-after-preflight", status: "filled", filledQty: 1, filledPrice: 100 }
      }),
    }

    await expect(placeLiveOrder({
      connectionId: "conn-margin-ordering",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 1,
      price: 100,
      leverage: 7,
      marginType: "isolated",
      connector,
      connection: { id: "conn-margin-ordering", position_mode: "one_way" },
    })).resolves.toMatchObject({ success: true })
    expect(calls).toEqual(["margin:isolated", "leverage:7", "order"])

    calls.length = 0
    await expect(placeLiveOrder({
      connectionId: "conn-margin-ordering",
      symbol: "BTCUSDT",
      side: "sell",
      positionDirection: "long",
      quantity: 1,
      price: 100,
      reduceOnly: true,
      connector,
      connection: { id: "conn-margin-ordering", position_mode: "one_way" },
    })).resolves.toMatchObject({ success: true })
    expect(calls).toEqual(["order"])
  })

  test("Direct-Trade live order reconciles exchange-only acknowledgements before recording the fill", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({ success: true, orderId: "exchange-ack-only" })),
      getOrder: jest.fn(async () => ({
        orderId: "exchange-ack-only",
        status: "filled",
        filledQty: 1.5,
        filledPrice: 101.25,
      })),
    }

    const result = await placeLiveOrder({
      connectionId: "conn-direct-live",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 2,
      price: 101,
      connector,
      connection: { id: "conn-direct-live", position_mode: "one_way" },
    })

    expect(result.success).toBe(true)
    expect(connector.getOrder).toHaveBeenCalledWith("BTCUSDT", "exchange-ack-only")
    expect(result.fill).toMatchObject({ filled: true, filledQty: 1.5, filledPrice: 101.25 })
    expect(JSON.parse([...kvStore.values()][0])).toMatchObject({
      executedQuantity: 1.5,
      averageExecutionPrice: 101.25,
      status: "open",
    })
  })

  test("does not book a live order acknowledgement as a fill when the exchange reports no execution", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "exchange-pending",
        status: "new",
        quantity: 2,
        price: 101,
      })),
      getOrder: jest.fn(async () => ({
        orderId: "exchange-pending",
        status: "new",
        quantity: 2,
        price: 101,
      })),
    }

    const result = await placeLiveOrder({
      connectionId: "conn-direct-pending",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 2,
      price: 101,
      connector,
      connection: { id: "conn-direct-pending", position_mode: "one_way" },
    })

    expect(result.success).toBe(true)
    expect(result.fill).toMatchObject({ filled: false, filledQty: 0, filledPrice: 0, status: "new" })
    expect(JSON.parse([...kvStore.values()][0])).toMatchObject({
      executedQuantity: 0,
      averageExecutionPrice: 0,
      volumeUsd: 0,
      status: "placed",
    })
    expect(hashStore.get("progression:conn-direct-pending")).toMatchObject({
      live_orders_placed_count: "1",
    })
    expect(hashStore.get("progression:conn-direct-pending")?.live_orders_filled_count).toBeUndefined()
  })

  test("Direct-Trade replays a completed control id without placing a second exchange order", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "control-exchange-1",
        status: "filled",
        filledQty: 1,
        filledPrice: 100,
      })),
    }
    const input = {
      connectionId: "conn-direct-idempotent",
      symbol: "BTCUSDT",
      side: "long",
      positionDirection: "long" as const,
      quantity: 1,
      price: 100,
      connector,
      connection: { id: "conn-direct-idempotent", position_mode: "one_way" },
      clientOrderId: "dtopen_stable_1",
      source: "direct-trade-open",
      persistPosition: false,
    }

    const first = await placeLiveOrder(input)
    const replay = await placeLiveOrder(input)

    expect(first).toMatchObject({ success: true, controlState: "completed", idempotentReplay: false })
    expect(replay).toMatchObject({ success: true, controlState: "completed", idempotentReplay: true })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(mockPersistNow).toHaveBeenCalled()
    expect(mockPersistNow.mock.invocationCallOrder[0]).toBeLessThan(connector.placeOrder.mock.invocationCallOrder[0])
    expect(hashStore.get("progression:conn-direct-idempotent")).toMatchObject({
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_positions_created_count: "1",
      live_volume_usd_total: "100",
    })
  })

  test("Direct-Trade completes delayed exact-order settlement on idempotent replay", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "settlement-lag-1",
        status: "filled",
        filledQty: 1,
        filledPrice: 110,
      })),
      getOrderSettlement: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          orderId: "settlement-lag-1",
          symbol: "BTCUSDT",
          filledQuantity: 1,
          averageFillPrice: 110,
          grossRealizedPnl: 10,
          tradingFee: 0.2,
          netRealizedPnl: 9.8,
          netIncludesEntryFee: true,
          source: "bybit_closed_pnl",
          settledAt: Date.now(),
          fills: [],
        }),
    }
    const input = {
      connectionId: "conn-direct-settlement-lag",
      symbol: "BTCUSDT",
      side: "sell" as const,
      positionDirection: "long" as const,
      quantity: 1,
      price: 109,
      reduceOnly: true,
      connector,
      connection: { id: "conn-direct-settlement-lag", position_mode: "one_way" },
      clientOrderId: "dtclose_settlement_lag_1",
      source: "direct-trade-close",
      persistPosition: false,
      updateCounters: false,
    }

    const first = await placeLiveOrder(input)
    const replay = await placeLiveOrder(input)
    expect(first).toMatchObject({ controlState: "completed", settlement: null })
    expect(replay).toMatchObject({
      controlState: "completed",
      idempotentReplay: true,
      settlement: {
        orderId: "settlement-lag-1",
        netRealizedPnl: 9.8,
        tradingFee: 0.2,
      },
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(connector.getOrderSettlement).toHaveBeenCalledTimes(2)
  })

  test("Direct-Trade reconciles a pending control id to its final fill without resubmission", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({ success: true, orderId: "control-pending-1", status: "new" })),
      getOrder: jest.fn()
        .mockResolvedValueOnce({ orderId: "control-pending-1", status: "pending", filledQty: 0, filledPrice: 0 })
        .mockResolvedValueOnce({ orderId: "control-pending-1", status: "filled", filledQty: 0.75, filledPrice: 102 }),
    }
    const input = {
      connectionId: "conn-direct-reconcile",
      symbol: "SOLUSDT",
      side: "long",
      positionDirection: "long" as const,
      quantity: 0.75,
      price: 101,
      connector,
      connection: { id: "conn-direct-reconcile", position_mode: "one_way" },
      clientOrderId: "dtdca_stable_1",
      source: "direct-trade-open",
      persistPosition: false,
      countPositionCreated: false,
      countAccumulated: true,
    }

    const pending = await placeLiveOrder(input)
    const reconciled = await placeLiveOrder(input)

    expect(pending).toMatchObject({ success: true, pendingReconciliation: true, controlState: "acknowledged" })
    expect(reconciled).toMatchObject({
      success: true,
      pendingReconciliation: false,
      controlState: "completed",
      idempotentReplay: true,
      fill: { filledQty: 0.75, filledPrice: 102 },
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(hashStore.get("progression:conn-direct-reconcile")).toMatchObject({
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_orders_accumulated_count: "1",
      live_volume_usd_total: "76.5",
    })
    expect(hashStore.get("progression:conn-direct-reconcile")?.live_positions_created_count).toBeUndefined()
  })

  test("Direct-Trade waits for an active partial and books its cumulative volume only when terminal", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({ success: true, orderId: "control-partial-1", status: "new" })),
      getOrder: jest.fn()
        .mockResolvedValueOnce({ orderId: "control-partial-1", status: "partially_filled", filledQty: 0.4, filledPrice: 100 })
        .mockResolvedValueOnce({ orderId: "control-partial-1", status: "cancelled", filledQty: 0.4, filledPrice: 100 }),
    }
    const input = {
      connectionId: "conn-direct-partial",
      symbol: "BTCUSDT",
      side: "long",
      positionDirection: "long" as const,
      quantity: 1,
      price: 100,
      connector,
      connection: { id: "conn-direct-partial", position_mode: "one_way" },
      clientOrderId: "dtblk_partial_1",
      source: "direct-trade-open",
      persistPosition: false,
      countPositionCreated: false,
      countAccumulated: true,
    }

    const partial = await placeLiveOrder(input)
    expect(partial).toMatchObject({ pendingReconciliation: true, controlState: "acknowledged" })
    expect(hashStore.get("progression:conn-direct-partial")?.live_orders_filled_count).toBeUndefined()
    expect(hashStore.get("progression:conn-direct-partial")?.live_volume_usd_total).toBeUndefined()

    const terminal = await placeLiveOrder(input)
    expect(terminal).toMatchObject({
      pendingReconciliation: false,
      controlState: "completed",
      idempotentReplay: true,
      fill: { filledQty: 0.4, filledPrice: 100 },
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(hashStore.get("progression:conn-direct-partial")).toMatchObject({
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_orders_accumulated_count: "1",
      live_volume_usd_total: "40",
    })
  })

  test("Direct-Trade refuses to reuse one control id for different economic order inputs", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "control-conflict-1",
        status: "filled",
        filledQty: 1,
        filledPrice: 100,
      })),
    }
    const base = {
      connectionId: "conn-direct-conflict",
      symbol: "XRPUSDT",
      side: "long",
      positionDirection: "long" as const,
      price: 100,
      connector,
      connection: { id: "conn-direct-conflict", position_mode: "one_way" },
      clientOrderId: "dtopen_conflict_1",
      source: "direct-trade-open",
      persistPosition: false,
    }

    await placeLiveOrder({ ...base, quantity: 1 })
    await expect(placeLiveOrder({ ...base, quantity: 2 })).rejects.toMatchObject({
      mode: "direct_order_control_conflict",
      statusCode: 409,
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
  })

  test("Direct-Trade treats a transport exception as ambiguous and reconciles by client id", async () => {
    const { exchangeClientOrderIdForControl, placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => { throw new Error("ECONNRESET after request write") }),
      // BingX's connector returns a success/order wrapper for this endpoint;
      // the service must unwrap it before interpreting status and fills.
      getOrderDetails: jest.fn(async (_symbol: string, _orderId: string | undefined, clientOrderId: string) => ({
        success: true,
        order: {
          orderId: "recovered-after-reset",
          clientOrderId,
          status: "filled",
          filledQty: 1,
          filledPrice: 99.5,
        },
      })),
    }
    const input = {
      connectionId: "conn-direct-ambiguous",
      symbol: "BCHUSDT",
      side: "short",
      positionDirection: "short" as const,
      quantity: 1,
      price: 100,
      connector,
      connection: { id: "conn-direct-ambiguous", position_mode: "one_way" },
      clientOrderId: "dtclose_ambiguous_1",
      source: "direct-trade-close",
      reduceOnly: true,
      persistPosition: false,
      updateCounters: false,
    }

    const ambiguous = await placeLiveOrder(input)
    const recovered = await placeLiveOrder(input)

    expect(ambiguous).toMatchObject({ success: true, pendingReconciliation: true })
    expect(recovered).toMatchObject({
      success: true,
      controlState: "completed",
      idempotentReplay: true,
      orderId: "recovered-after-reset",
      fill: { filledQty: 1, filledPrice: 99.5 },
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(connector.getOrderDetails).toHaveBeenCalledWith(
      "BCHUSDT",
      undefined,
      exchangeClientOrderIdForControl("dtclose_ambiguous_1"),
    )
  })

  test("Direct-Trade recovers an OKX acknowledgement by its portable venue client id", async () => {
    const { exchangeClientOrderIdForControl, placeLiveOrder } = await import("@/lib/live-order-service")
    const controlId = "dtopen_okx_ack_without_order_id_1"
    const venueClientOrderId = exchangeClientOrderIdForControl(controlId)
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => { throw new Error("network timeout after request write") }),
      getOpenOrders: jest.fn(async () => [{
        ordId: "okx-recovered-order",
        clOrdId: venueClientOrderId,
        state: "filled",
        accFillSz: "0.5",
        avgPx: "101.25",
      }]),
      getOrderHistory: jest.fn(async () => []),
    }
    const input = {
      connectionId: "conn-direct-okx-recovery",
      symbol: "BTC-USDT-SWAP",
      side: "long" as const,
      positionDirection: "long" as const,
      quantity: 0.5,
      price: 101,
      connector,
      connection: { id: "conn-direct-okx-recovery", exchange: "okx", position_mode: "one_way" },
      clientOrderId: controlId,
      source: "direct-trade-open",
      persistPosition: false,
    }

    const pending = await placeLiveOrder(input)
    const recovered = await placeLiveOrder(input)

    expect(venueClientOrderId).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(venueClientOrderId).not.toBe(controlId)
    expect(pending).toMatchObject({ success: true, pendingReconciliation: true })
    expect(recovered).toMatchObject({
      success: true,
      orderId: "okx-recovered-order",
      pendingReconciliation: false,
      controlState: "completed",
      fill: { filledQty: 0.5, filledPrice: 101.25 },
    })
    expect(connector.placeOrder).toHaveBeenCalledTimes(1)
    expect(connector.placeOrder.mock.calls[0][5]).toMatchObject({ clientOrderId: venueClientOrderId })
  })

  test("portable venue control ids are stable and do not alias separator variants", async () => {
    const { exchangeClientOrderIdForControl } = await import("@/lib/live-order-service")

    const first = exchangeClientOrderIdForControl("dt_open_ab_c")
    const second = exchangeClientOrderIdForControl("dt_open_a_bc")
    expect(first).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(first.length).toBeLessThanOrEqual(32)
    expect(first).toBe(exchangeClientOrderIdForControl("dt_open_ab_c"))
    expect(first).not.toBe(second)
    expect(exchangeClientOrderIdForControl("PortableControl123")).toBe("PortableControl123")
  })

  test("Direct-Trade makes a pre-submit leverage rejection terminal without touching placeOrder", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: false, error: "leverage not allowed" })),
      placeOrder: jest.fn(),
    }
    const input = {
      connectionId: "conn-direct-leverage-failure",
      symbol: "BTCUSDT",
      side: "long" as const,
      positionDirection: "long" as const,
      quantity: 1,
      price: 100,
      leverage: 10,
      connector,
      connection: { id: "conn-direct-leverage-failure", position_mode: "one_way" },
      clientOrderId: "dtopen_leverage_failure_1",
      source: "direct-trade-open",
      persistPosition: false,
    }

    const failed = await placeLiveOrder(input)
    const replay = await placeLiveOrder(input)

    expect(failed).toMatchObject({
      success: false,
      error: "leverage not allowed",
      pendingReconciliation: false,
      controlState: "failed",
    })
    expect(replay).toMatchObject({ success: false, controlState: "failed", idempotentReplay: true })
    expect(connector.setLeverage).toHaveBeenCalledTimes(1)
    expect(connector.placeOrder).not.toHaveBeenCalled()
    expect(hashStore.get("progression:conn-direct-leverage-failure")).toMatchObject({
      live_orders_failed_count: "1",
    })
  })

  test("Direct-Trade releases a claim when inline durability fails before placement", async () => {
    mockPersistNow.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    const { directOrderControlKey, placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(),
    }

    await expect(placeLiveOrder({
      connectionId: "conn-direct-persist-failure",
      symbol: "SOLUSDT",
      side: "long",
      positionDirection: "long",
      quantity: 1,
      price: 100,
      connector,
      connection: { id: "conn-direct-persist-failure", position_mode: "one_way" },
      clientOrderId: "dtopen_persist_failure_1",
      source: "direct-trade-open",
      persistPosition: false,
    })).rejects.toMatchObject({ mode: "direct_order_control_not_durable", statusCode: 503 })

    expect(connector.placeOrder).not.toHaveBeenCalled()
    expect(kvStore.has(directOrderControlKey(
      "conn-direct-persist-failure",
      "dtopen_persist_failure_1",
    ))).toBe(false)
  })

  test("normalizes OKX/Pionex fill aliases and terminal partial cancellations", async () => {
    const { isTerminalLiveOrderResult, parseOrderFill } = await import("@/lib/live-order-service")

    expect(parseOrderFill({ state: "filled", accFillSz: "0.75", avgPx: "101.5" })).toMatchObject({
      filled: true,
      filledQty: 0.75,
      filledPrice: 101.5,
      status: "filled",
    })
    expect(parseOrderFill({ status: "FILLED", filledSize: "2", avgFillPrice: "50" })).toMatchObject({
      filled: true,
      filledQty: 2,
      filledPrice: 50,
    })
    expect(isTerminalLiveOrderResult({
      state: "partially_filled_canceled",
      accFillSz: "0.4",
      avgPx: "100",
    }, 1)).toBe(true)
  })

  test.each([
    {
      name: "spot",
      connection: { id: "conn-direct-spot", exchange: "pionex", api_type: "spot" },
    },
    {
      name: "OrangeX legacy",
      connection: {
        id: "conn-direct-orangex-legacy",
        exchange: "orangex",
        api_type: "perpetual_futures",
        connection_library: "legacy",
      },
    },
  ])("blocks $name Direct-Trade connections that cannot guarantee reduce-only idempotency", async ({ connection }) => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(),
    }

    await expect(placeLiveOrder({
      connectionId: connection.id,
      symbol: "BTCUSDT",
      side: "long",
      positionDirection: "long",
      quantity: 1,
      price: 100,
      connector,
      connection,
      clientOrderId: `dtopen_${connection.id}`,
      source: "direct-trade-open",
      persistPosition: false,
    })).rejects.toMatchObject({
      mode: "unsupported_direct_trade_connection",
      statusCode: 409,
    })
    expect(connector.placeOrder).not.toHaveBeenCalled()
  })


  test("exchange order ids make live progression accounting idempotent", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const connector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "same-exchange-order",
        status: "filled",
        filledQty: 1,
        filledPrice: 100,
      })),
    }

    const input = {
      connectionId: "conn-idem",
      symbol: "ethusdt",
      side: "long",
      quantity: 1,
      leverage: 2,
      connector,
      connection: { id: "conn-idem", position_mode: "one_way" },
    }

    await placeLiveOrder(input)
    await placeLiveOrder(input)

    expect(connector.placeOrder).toHaveBeenCalledTimes(2)
    expect(hashStore.get("progression:conn-idem")).toMatchObject({
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_positions_created_count: "1",
      live_volume_usd_total: "100",
    })
    expect(hashStore.get("live_orders_by_symbol_v2:conn-idem")).toMatchObject({
      "ETHUSDT:long:placed": "1",
      "ETHUSDT:long:filled": "1",
    })
  })

  test("keeps simulated progression separate from real exchange counters", async () => {
    const { recordLiveOrderProgression } = await import("@/lib/live-order-service")

    await recordLiveOrderProgression("conn-sim", "solusdt", "short", "simulated")

    expect(hashStore.get("progression:conn-sim")).toMatchObject({
      live_orders_simulated_count: "1",
      live_simulated_positions_created_count: "1",
    })
    expect(hashStore.get("progression:conn-sim")?.live_orders_placed_count).toBeUndefined()
    expect(hashStore.get("progression:conn-sim")?.live_orders_filled_count).toBeUndefined()
    expect(hashStore.get("live_orders_by_symbol_v2:conn-sim")).toBeUndefined()
    expect(hashStore.get("live_orders_by_source_v1:conn-sim")).toMatchObject({
      "other:simulated": "1",
      "other:simulated_position_created": "1",
    })
  })

  test("live-stage per-symbol primitive writes the same counter key format", async () => {
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")

    await recordPerSymbolOrderCounter("conn-b", "ETHUSDT", "short", "placed")
    await recordPerSymbolOrderCounter("conn-b", "ETHUSDT", "short", "filled")

    expect(hashStore.get("live_orders_by_symbol_v2:conn-b")).toEqual({
      "ETHUSDT:short:placed": "1",
      "ETHUSDT:short:filled": "1",
    })
  })

  test("keeps unequal long and short order counts independently", async () => {
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")

    await recordPerSymbolOrderCounter("conn-sides", "BTCUSDT", "long", "placed")
    await recordPerSymbolOrderCounter("conn-sides", "BTCUSDT", "long", "placed")
    await recordPerSymbolOrderCounter("conn-sides", "BTCUSDT", "long", "placed")
    await recordPerSymbolOrderCounter("conn-sides", "BTCUSDT", "short", "placed")

    expect(hashStore.get("live_orders_by_symbol_v2:conn-sides")).toEqual({
      "BTCUSDT:long:placed": "3",
      "BTCUSDT:short:placed": "1",
    })
  })

  test("counts accumulation orders without inventing additional positions", async () => {
    const { recordLiveOrderProgression } = await import("@/lib/live-order-service")

    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "long",
      "placed",
      0,
      "long-block-2:placed",
      { countPositionCreated: false, source: "main-trade-block" },
    )
    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "long",
      "filled",
      125,
      "long-block-2:filled",
      { countPositionCreated: false, countAccumulated: true, source: "main-trade-block" },
    )
    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "short",
      "simulated",
      40,
      "short-block-1:simulated",
      { countPositionCreated: false, countAccumulated: true, source: "direct-trade-dca" },
    )
    // A crash/reconcile replay with the same durable event must not inflate
    // either side, the total order count, or the traded volume.
    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "long",
      "filled",
      125,
      "long-block-2:filled",
      { countPositionCreated: false, countAccumulated: true, source: "main-trade-block" },
    )

    expect(hashStore.get("progression:conn-adjustments")).toMatchObject({
      live_orders_attempted_count: "1",
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_orders_simulated_count: "1",
      live_orders_accumulated_count: "1",
      live_simulated_orders_accumulated_count: "1",
      live_volume_usd_total: "125",
      live_simulated_volume_usd_total: "40",
    })
    expect(hashStore.get("progression:conn-adjustments")?.live_positions_created_count).toBeUndefined()
    expect(hashStore.get("live_orders_by_symbol_v2:conn-adjustments")).toEqual({
      "BTCUSDT:long:placed": "1",
      "BTCUSDT:long:filled": "1",
    })
    expect(hashStore.get("live_orders_by_source_v1:conn-adjustments")).toMatchObject({
      "main-trade:placed": "1",
      "main-trade:filled": "1",
      "main-trade:accumulated": "1",
      "main-trade:volume_usd": "125",
      "direct-trade:simulated": "1",
      "direct-trade:simulated_accumulated": "1",
      "direct-trade:simulated_volume_usd": "40",
    })
  })

  test("per-symbol primitive rejects an invalid runtime direction", async () => {
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")

    await expect(
      recordPerSymbolOrderCounter("conn-invalid-counter", "BTCUSDT", "sideways" as any, "placed"),
    ).rejects.toThrow("Order side must be long, short, buy, or sell")
    expect(hashStore.get("live_orders_by_symbol_v2:conn-invalid-counter")).toBeUndefined()
  })

  test("rejects unknown sides instead of silently counting them as long", async () => {
    const { placeLiveOrder } = await import("@/lib/live-order-service")

    await expect(placeLiveOrder({
      connectionId: "conn-invalid-side",
      symbol: "BTCUSDT",
      side: "unknown",
      quantity: 1,
      connection: { id: "conn-invalid-side" },
    })).rejects.toThrow("Order side must be long, short, buy, or sell")
  })

  test("routes a supplied connector to paper mode when the persisted Live switch is off", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const suppliedConnector = {
      setLeverage: jest.fn(async () => ({ success: true })),
      placeOrder: jest.fn(async () => ({
        success: true,
        orderId: "must-not-be-sent",
        status: "filled",
        filledQty: 1,
        filledPrice: 100,
      })),
    }
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "development",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      const { placeLiveOrder } = await import("@/lib/live-order-service")
      const result = await placeLiveOrder({
        connectionId: "conn-paper-switch",
        symbol: "BTCUSDT",
        side: "long",
        quantity: 1,
        connector: suppliedConnector,
        connection: {
          id: "conn-paper-switch",
          exchange: "mock",
          api_key: "1234567890",
          api_secret: "secret12345",
          is_live_trade: "0",
          live_trade_requested: "0",
        },
      })

      expect(result).toMatchObject({ success: true, mode: "simulated" })
      expect(suppliedConnector.placeOrder).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  })

  test("FORCE_SIMULATED remains usable for isolated production progression tests", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousForceSimulated = process.env.FORCE_SIMULATED
    const previousAllowProductionSimulated = process.env.ALLOW_PROD_SIMULATED
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      process.env.FORCE_SIMULATED = "1"
      delete process.env.ALLOW_PROD_SIMULATED
      const { createLiveOrderConnector } = await import("@/lib/live-order-service")

      const result = await createLiveOrderConnector({
        id: "conn-force-sim",
        api_key: "",
        api_secret: "",
        is_testnet: "0",
        api_type: "perpetual_futures",
        contract_type: "usdt-perpetual",
      })

      expect(result).toMatchObject({ mode: "simulated", willUseRealExchange: false })
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
      if (previousForceSimulated === undefined) delete process.env.FORCE_SIMULATED
      else process.env.FORCE_SIMULATED = previousForceSimulated
      if (previousAllowProductionSimulated === undefined) delete process.env.ALLOW_PROD_SIMULATED
      else process.env.ALLOW_PROD_SIMULATED = previousAllowProductionSimulated
    }
  })
})
