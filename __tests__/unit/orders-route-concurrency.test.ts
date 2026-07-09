jest.mock("@/lib/audit-logger", () => ({
  auditLogger: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}))

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

describe("orders API Redis indexed storage", () => {
  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env.NODE_ENV = "test"
  })

  afterEach(() => {
    resetInlineRedisGlobals()
  })

  it("does not lose orders when multiple POST handlers run concurrently", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/orders/route"),
      import("@/lib/redis-db"),
    ])

    const totalOrders = 40
    const postResponses = await Promise.all(
      Array.from({ length: totalOrders }, (_, index) => {
        const request = new Request("http://localhost/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connection_id: "conn-concurrent",
            symbol: `BTCUSDT`,
            order_type: "limit",
            side: index % 2 === 0 ? "BUY" : "SELL",
            price: 100 + index,
            quantity: 1,
            time_in_force: "GTC",
          }),
        })

        return POST(request as any)
      })
    )

    const createdPayloads = await Promise.all(postResponses.map((response) => response.json()))
    expect(createdPayloads).toHaveLength(totalOrders)
    expect(createdPayloads.every((payload) => payload.success)).toBe(true)

    const getResponse = await GET(
      new Request(`http://localhost/api/orders?connection_id=conn-concurrent&limit=${totalOrders}`) as any
    )
    const getPayload = await getResponse.json()

    expect(getPayload.success).toBe(true)
    expect(getPayload.count).toBe(totalOrders)
    expect(new Set(getPayload.data.map((order: any) => order.id)).size).toBe(totalOrders)

    const redis = getRedisClient()
    await expect(redis.zcard("orders:index")).resolves.toBe(totalOrders)
    await expect(redis.zcard("orders:connection:conn-concurrent")).resolves.toBe(totalOrders)
    await expect(redis.zcard("orders:status:pending")).resolves.toBe(totalOrders)
  })
})
