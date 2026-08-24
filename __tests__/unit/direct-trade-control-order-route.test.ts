const placeLiveOrderMock = jest.fn()

jest.mock("@/lib/live-order-service", () => ({
  placeLiveOrder: (...args: unknown[]) => placeLiveOrderMock(...args),
  directOrderControlKey: (connectionId: string, clientOrderId: string) => (
    `live:direct_order_control:${encodeURIComponent(connectionId)}:${encodeURIComponent(clientOrderId)}`
  ),
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

const token = "direct-trade-processor-token-0123456789"
const instanceId = "direct-worker-test"

function request(body: Record<string, unknown>, suppliedToken = token) {
  return new Request("http://localhost/api/trade-engine/direct-trade/order", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-direct-trade-processor-token": suppliedToken,
    },
    body: JSON.stringify(body),
  })
}

describe("Direct-Trade leased control-order route", () => {
  const priorToken = process.env.DIRECT_TRADE_PROCESSOR_TOKEN

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    resetInlineRedisGlobals()
    process.env.DIRECT_TRADE_PROCESSOR_TOKEN = token
    placeLiveOrderMock.mockResolvedValue({
      success: true,
      mode: "simulated",
      orderId: "paper-order-1",
      quantity: 0.25,
      fill: { filled: true, filledQty: 0.25, filledPrice: 100, status: "filled" },
      details: { status: "filled" },
    })
  })

  afterAll(() => {
    if (priorToken === undefined) delete process.env.DIRECT_TRADE_PROCESSOR_TOKEN
    else process.env.DIRECT_TRADE_PROCESSOR_TOKEN = priorToken
  })

  test("requires the installed worker token and current lease owner", async () => {
    const { POST } = await import("@/app/api/trade-engine/direct-trade/order/route")
    const denied = await POST(request({ kind: "open" }, "wrong-token") as any)
    expect(denied.status).toBe(401)
    expect(placeLiveOrderMock).not.toHaveBeenCalled()
  })

  test("opens only for the selected live connection and closes with reduce-only position side", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x01" }))

    const opened = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_1m_1",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
      price: 100,
    }) as any)
    expect(opened.status).toBe(200)
    expect(placeLiveOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionId: "bingx-x01",
      side: "long",
      positionDirection: "long",
      reduceOnly: false,
      persistPosition: false,
      countPositionCreated: true,
      countAccumulated: false,
      safetyPayload: expect.objectContaining({ confirmLiveOrderPlacement: true }),
    }))

    const closed = await POST(request({
      kind: "close",
      instanceId,
      positionId: "dt_BTCUSDT_long_1",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
    }) as any)
    expect(closed.status).toBe(200)
    expect(placeLiveOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      side: "short",
      positionDirection: "long",
      reduceOnly: true,
      clientOrderId: expect.stringMatching(/^dt-close-/),
    }))
  })

  test("canonicalizes legacy timeframe-combination control IDs for recovery", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.set("direct_trade:connection:bingx-x02:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x02:state", JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x02" }))

    const response = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_XRPUSDT_short_5m+15m_1234",
      controlId: "dtopen_dt_XRPUSDT_short_5m+15m_1234",
      connectionId: "bingx-x02",
      symbol: "XRPUSDT",
      positionDirection: "short",
      quantity: 0.05,
      price: 1.5,
    }) as any)

    expect(response.status).toBe(200)
    expect(placeLiveOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      clientOrderId: "dtopen_dt_XRPUSDT_short_5m_15m_1234",
    }))
  })

  test("classifies Block and DCA orders as accumulation and forwards reconciliation state", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x01" }))
    placeLiveOrderMock.mockResolvedValueOnce({
      success: true,
      mode: "live",
      orderId: "pending-block-1",
      quantity: 0.1,
      fill: { filled: false, filledQty: 0, filledPrice: 0, status: "pending" },
      details: { status: "pending" },
      controlState: "acknowledged",
      pendingReconciliation: true,
      idempotentReplay: true,
    })

    const response = await POST(request({
      kind: "open",
      stage: "block",
      instanceId,
      positionId: "dt_BTCUSDT_long_1",
      controlId: "dtblk_stable_1",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.1,
    }) as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      success: true,
      controlState: "acknowledged",
      pendingReconciliation: true,
      idempotentReplay: true,
    })
    expect(placeLiveOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      countPositionCreated: false,
      countAccumulated: true,
    }))
  })

  test("rejects malformed symbols and missing entry prices before exchange submission", async () => {
    const { POST } = await import("@/app/api/trade-engine/direct-trade/order/route")

    const invalidSymbol = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_1",
      connectionId: "bingx-x02",
      symbol: "DYDX",
      positionDirection: "long",
      quantity: 0.25,
      price: 100,
    }) as any)
    expect(invalidSymbol.status).toBe(400)

    const missingPrice = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_2",
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
    }) as any)
    expect(missingPrice.status).toBe(400)
    expect(placeLiveOrderMock).not.toHaveBeenCalled()
  })

  test("after Stop allows only reconciliation of an already durable open control", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const control = "dtopen_persisted_1"
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", JSON.stringify({ enabled: false, liveMode: false, connectionId: "bingx-x01" }))
    await redis.set(
      `live:direct_order_control:${encodeURIComponent("bingx-x01")}:${encodeURIComponent(control)}`,
      JSON.stringify({ version: 1, state: "acknowledged" }),
    )

    const reconciled = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_persisted",
      controlId: control,
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
      reconcileOnly: true,
    }) as any)
    expect(reconciled.status).toBe(200)
    expect(placeLiveOrderMock).toHaveBeenCalledTimes(1)

    const fresh = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_fresh",
      controlId: "dtopen_not_persisted",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
      reconcileOnly: true,
    }) as any)
    expect(fresh.status).toBe(409)
    expect(placeLiveOrderMock).toHaveBeenCalledTimes(1)
  })

  test("never lets a legacy global lease override a different scoped owner", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.set("direct_trade:processor:lease", instanceId)
    await redis.set("direct_trade:state", JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x01" }))
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", "scoped-owner")
    await redis.set("direct_trade:connection:bingx-x01:state", JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x01" }))

    const response = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_legacy",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
      price: 100,
    }) as any)

    expect(response.status).toBe(409)
    expect(placeLiveOrderMock).not.toHaveBeenCalled()
  })
})
