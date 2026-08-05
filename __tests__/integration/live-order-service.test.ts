/**
 * Integration coverage for the shared live order service accounting contract.
 */

const hashStore = new Map<string, Record<string, any>>()
const kvStore = new Map<string, string>()
const setStore = new Map<string, Set<string>>()

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
  getRedisClient: jest.fn(() => ({
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

  test("simulated progression folds into placed and filled counters", async () => {
    const { recordLiveOrderProgression } = await import("@/lib/live-order-service")

    await recordLiveOrderProgression("conn-sim", "solusdt", "short", "simulated")

    expect(hashStore.get("progression:conn-sim")).toMatchObject({
      live_orders_simulated_count: "1",
      live_orders_placed_count: "1",
      live_orders_filled_count: "1",
      live_positions_created_count: "1",
    })
    expect(hashStore.get("live_orders_by_symbol_v2:conn-sim")).toEqual({
      "SOLUSDT:short:placed": "1",
      "SOLUSDT:short:filled": "1",
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
      { countPositionCreated: false },
    )
    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "long",
      "filled",
      125,
      "long-block-2:filled",
      { countPositionCreated: false, countAccumulated: true },
    )
    await recordLiveOrderProgression(
      "conn-adjustments",
      "BTCUSDT",
      "short",
      "simulated",
      40,
      "short-block-1:simulated",
      { countPositionCreated: false, countAccumulated: true },
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
      { countPositionCreated: false, countAccumulated: true },
    )

    expect(hashStore.get("progression:conn-adjustments")).toMatchObject({
      live_orders_placed_count: "2",
      live_orders_filled_count: "2",
      live_orders_simulated_count: "1",
      live_orders_accumulated_count: "2",
      live_volume_usd_total: "165",
    })
    expect(hashStore.get("progression:conn-adjustments")?.live_positions_created_count).toBeUndefined()
    expect(hashStore.get("live_orders_by_symbol_v2:conn-adjustments")).toEqual({
      "BTCUSDT:long:placed": "1",
      "BTCUSDT:long:filled": "1",
      "BTCUSDT:short:placed": "1",
      "BTCUSDT:short:filled": "1",
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
