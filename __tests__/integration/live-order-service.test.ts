/**
 * Integration coverage for the shared live order service accounting contract.
 */

const hashStore = new Map<string, Record<string, any>>()
const kvStore = new Map<string, string>()
const setStore = new Map<string, Set<string>>()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async (id: string) => ({ id, exchange: "mock", api_key: "key", api_secret: "secret", is_testnet: "1" })),
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
    expect(hashStore.get("live_orders_by_symbol:conn-a")).toMatchObject({
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
    expect(hashStore.get("live_orders_by_symbol:conn-idem")).toMatchObject({
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
    expect(hashStore.get("live_orders_by_symbol:conn-sim")).toEqual({
      "SOLUSDT:short:placed": "1",
      "SOLUSDT:short:filled": "1",
    })
  })

  test("live-stage per-symbol primitive writes the same counter key format", async () => {
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")

    await recordPerSymbolOrderCounter("conn-b", "ETHUSDT", "short", "placed")
    await recordPerSymbolOrderCounter("conn-b", "ETHUSDT", "short", "filled")

    expect(hashStore.get("live_orders_by_symbol:conn-b")).toEqual({
      "ETHUSDT:short:placed": "1",
      "ETHUSDT:short:filled": "1",
    })
  })
})
