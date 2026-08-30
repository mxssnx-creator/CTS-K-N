const executeCanonicalOrderMock = jest.fn()

jest.mock("@/lib/live-order-service", () => ({
  directOrderControlKey: (connectionId: string, clientOrderId: string) => (
    `live:direct_order_control:${encodeURIComponent(connectionId)}:${encodeURIComponent(clientOrderId)}`
  ),
}))

jest.mock("@/lib/direct-trade-canonical-order", () => ({
  executeDirectTradeCanonicalOrder: (...args: unknown[]) => executeCanonicalOrderMock(...args),
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

function watermarkedControl(connectionId: string, suffix: string): string {
  return `cts${connectionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase()}${suffix}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 48)
}

function directState(connectionId: string, positions: Record<string, unknown>[], enabled = true) {
  return JSON.stringify({ enabled, liveMode: enabled, connectionId, positions })
}

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
    executeCanonicalOrderMock.mockResolvedValue({
      success: true,
      mode: "live",
      orderId: "canonical-order-1",
      quantity: 0.25,
      fill: { filled: true, filledQty: 0.25, filledPrice: 100, status: "filled" },
      details: { status: "filled" },
      controlState: "completed",
      pendingReconciliation: false,
      canonicalLivePositionId: "live:bingx-x02:BTCUSDT:long:direct:test",
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
    expect(executeCanonicalOrderMock).not.toHaveBeenCalled()
  })

  test("opens only for the selected live connection and closes with reduce-only position side", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const openControlId = watermarkedControl("bingx-x01", "dtopen1")
    const closeControlId = watermarkedControl("bingx-x01", "dtclose1")
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", directState("bingx-x01", [
      { id: "dt_BTCUSDT_long_1m_1", connectionId: "bingx-x01", symbol: "BTCUSDT", direction: "long", openControlId },
      { id: "dt_BTCUSDT_long_1", connectionId: "bingx-x01", symbol: "BTCUSDT", direction: "long", closeControlId },
    ]))

    const opened = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_BTCUSDT_long_1m_1",
      controlId: openControlId,
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
      price: 100,
    }) as any)
    expect(opened.status).toBe(200)
    expect(executeCanonicalOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "open",
      stage: "entry",
      connectionId: "bingx-x01",
      positionDirection: "long",
      controlId: openControlId,
      statePosition: expect.objectContaining({ id: "dt_BTCUSDT_long_1m_1" }),
      shouldContinue: expect.any(Function),
    }))

    const closed = await POST(request({
      kind: "close",
      instanceId,
      positionId: "dt_BTCUSDT_long_1",
      controlId: closeControlId,
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
    }) as any)
    expect(closed.status).toBe(200)
    expect(executeCanonicalOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "close",
      positionDirection: "long",
      controlId: closeControlId,
    }))
  })

  test("forwards the authoritative exchange settlement to the processor", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const settlement = {
      orderId: "venue-close-1",
      symbol: "BTCUSDT",
      filledQuantity: 0.25,
      averageFillPrice: 101,
      grossRealizedPnl: 0.25,
      tradingFee: 0.01,
      netRealizedPnl: 0.24,
      netIncludesEntryFee: false,
      source: "exchange_order_detail",
      settledAt: Date.now(),
      fills: [],
    }
    const closeControlId = watermarkedControl("bingx-x02", "dtclosesettlement")
    await redis.set("direct_trade:connection:bingx-x02:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x02:state", directState("bingx-x02", [{
      id: "dt_BTCUSDT_long_settlement",
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      closeControlId,
    }]))
    executeCanonicalOrderMock.mockResolvedValueOnce({
      success: true,
      mode: "live",
      orderId: settlement.orderId,
      quantity: 0.25,
      fill: { filled: true, filledQty: 0.25, filledPrice: 101, status: "filled" },
      details: { status: "filled" },
      settlement,
      controlState: "completed",
      pendingReconciliation: false,
    })

    const response = await POST(request({
      kind: "close",
      instanceId,
      positionId: "dt_BTCUSDT_long_settlement",
      controlId: closeControlId,
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      positionDirection: "long",
      quantity: 0.25,
    }) as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      settlement,
    })
  })

  test("canonicalizes legacy timeframe-combination control IDs for recovery", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const legacyControlId = watermarkedControl("bingx-x02", "dtopen_short_5m+15m")
      .replace(/\+/g, "_")
    await redis.set("direct_trade:connection:bingx-x02:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x02:state", directState("bingx-x02", [{
      id: "dt_XRPUSDT_short_5m+15m_1234",
      connectionId: "bingx-x02",
      symbol: "XRPUSDT",
      direction: "short",
      openControlId: legacyControlId,
    }]))

    const response = await POST(request({
      kind: "open",
      instanceId,
      positionId: "dt_XRPUSDT_short_5m+15m_1234",
      controlId: legacyControlId,
      connectionId: "bingx-x02",
      symbol: "XRPUSDT",
      positionDirection: "short",
      quantity: 0.05,
      price: 1.5,
    }) as any)

    expect(response.status).toBe(200)
    expect(executeCanonicalOrderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      controlId: legacyControlId,
    }))
  })

  test("classifies Block and DCA orders as accumulation and forwards reconciliation state", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const blockControlId = watermarkedControl("bingx-x01", "dtblk_stable_1")
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", directState("bingx-x01", [{
      id: "dt_BTCUSDT_long_1",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      direction: "long",
      blockPendingControlId: blockControlId,
    }]))
    executeCanonicalOrderMock.mockResolvedValueOnce({
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
      controlId: blockControlId,
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
    expect(executeCanonicalOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "open",
      stage: "block",
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
    expect(executeCanonicalOrderMock).not.toHaveBeenCalled()
  })

  test("after Stop allows only reconciliation of an already durable open control", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/order/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const control = "dtopen_persisted_1"
    await redis.set("direct_trade:connection:bingx-x01:processor:lease", instanceId)
    await redis.set("direct_trade:connection:bingx-x01:state", directState("bingx-x01", [{
      id: "dt_BTCUSDT_long_persisted",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      direction: "long",
      openControlId: control,
    }, {
      id: "dt_BTCUSDT_long_fresh",
      connectionId: "bingx-x01",
      symbol: "BTCUSDT",
      direction: "long",
      openControlId: "dtopen_not_persisted",
    }], false))
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
    expect(executeCanonicalOrderMock).toHaveBeenCalledTimes(1)

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
    expect(executeCanonicalOrderMock).toHaveBeenCalledTimes(1)
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
    expect(executeCanonicalOrderMock).not.toHaveBeenCalled()
  })
})
