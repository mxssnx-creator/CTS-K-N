/**
 * Integration coverage for the shared live order service accounting contract.
 */

const hashStore = new Map<string, Record<string, any>>()
const kvStore = new Map<string, string>()

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
