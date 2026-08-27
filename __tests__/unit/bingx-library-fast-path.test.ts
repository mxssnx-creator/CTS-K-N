import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

describe("installed bingx-api package fast path", () => {
  const originalFetch = global.fetch

  function mockServerTimeFetch() {
    const mock = jest.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { serverTime: Date.now() },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    global.fetch = mock as typeof fetch
    return mock
  }

  async function connectorWithTradeService(tradeService: Record<string, jest.Mock>) {
    const connector = new BingXConnector({
      apiKey: "test-package-key-1234567890",
      apiSecret: "test-package-secret-1234567890",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      connectionMethod: "library",
      connectionLibrary: "sdk",
    })
    await connector.warmUpFastPath()
    await (connector as any).syncPromise?.catch(() => undefined)
    ;(connector as any).sdkClient = { getTradeService: () => tradeService }
    ;(connector as any).sdkReady = true
    return connector
  }

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test("initializes the package client and account service as the mainnet-swap default", async () => {
    mockServerTimeFetch()

    const connector = new BingXConnector({
      apiKey: "test-package-key-1234567890",
      apiSecret: "test-package-secret-1234567890",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      connectionMethod: "library",
      connectionLibrary: "sdk",
    })

    await connector.warmUpFastPath()
    expect(connector.getFastPathStatus()).toEqual(expect.objectContaining({
      ready: true,
      transport: "bingx-api",
      package: "bingx-api",
      officialPackage: false,
    }))

    // Let the constructor's non-blocking time-sync settle before restoring
    // the fetch mock so the test leaves no network work behind.
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  test("uses the SDK order service first with canonical quantity and stable client identity", async () => {
    const fetchMock = mockServerTimeFetch()
    const tradeOrder = jest.fn(async () => ({
      code: 0,
      data: { order: { orderId: "sdk-order-1", status: "NEW", executedQty: "0" } },
    }))
    const connector = await connectorWithTradeService({ tradeOrder })
    const requestsBeforeOrder = fetchMock.mock.calls.length

    const result = await connector.placeOrder("BTCUSDT", "buy", 0.123456789, undefined, "market", {
      positionSide: "LONG",
      hedgeMode: true,
      clientOrderId: "cts-sdk-entry-1",
    })

    expect(result).toMatchObject({ success: true, orderId: "sdk-order-1", status: "NEW" })
    expect(tradeOrder).toHaveBeenCalledTimes(1)
    expect(tradeOrder.mock.calls[0][0]).toMatchObject({
      symbol: "BTC-USDT",
      side: "BUY",
      type: "MARKET",
      quantity: "0.123457",
      positionSide: "LONG",
      clientOrderID: "cts-sdk-entry-1",
    })
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeOrder)
    expect(connector.getLastOperationTransport("placeOrder")).toMatchObject({ transport: "bingx-api" })
  })

  test("never retries an ambiguous SDK acknowledgement through REST, even without a client id", async () => {
    const fetchMock = mockServerTimeFetch()
    const tradeOrder = jest.fn(async () => ({ code: 0, data: {} }))
    const connector = await connectorWithTradeService({ tradeOrder })
    const requestsBeforeOrder = fetchMock.mock.calls.length

    const result = await connector.placeOrder("ETHUSDT", "sell", 0.02, undefined, "market")

    expect(result.success).toBe(false)
    expect(result.error).toContain("REST retry suppressed to prevent a duplicate order")
    expect(tradeOrder).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeOrder)
  })

  test("rejects invalid quantity before invoking either SDK or REST", async () => {
    const fetchMock = mockServerTimeFetch()
    const tradeOrder = jest.fn()
    const connector = await connectorWithTradeService({ tradeOrder })
    const requestsBeforeOrder = fetchMock.mock.calls.length

    expect(await connector.placeOrder("BTCUSDT", "buy", Number.NaN, undefined, "market"))
      .toMatchObject({ success: false, error: "Invalid quantity: NaN" })
    expect(tradeOrder).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeOrder)
  })

  test("uses the SDK cancel service and records the authoritative transport", async () => {
    mockServerTimeFetch()
    const cancelOrder = jest.fn(async () => ({ code: 0, data: { orderId: "sdk-order-1" } }))
    const connector = await connectorWithTradeService({ cancelOrder })

    expect(await connector.cancelOrder("BTCUSDT", "sdk-order-1")).toEqual({ success: true })
    expect(cancelOrder).toHaveBeenCalledWith("sdk-order-1", "BTC-USDT", expect.anything())
    expect(connector.getLastOperationTransport("cancelOrder")).toMatchObject({ transport: "bingx-api" })
  })

  test("collapses concurrent cancellation of one control order into one venue request", async () => {
    mockServerTimeFetch()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cancelOrder = jest.fn(async () => {
      await gate
      return { code: 0, data: { orderId: "shared-control-order" } }
    })
    const connector = await connectorWithTradeService({ cancelOrder })

    const first = connector.cancelOrder("BTCUSDT", "shared-control-order")
    const second = connector.cancelOrder("BTCUSDT", "shared-control-order")
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true },
    ])
    expect(cancelOrder).toHaveBeenCalledTimes(1)
    await expect(connector.cancelOrder("BTCUSDT", "shared-control-order")).resolves.toEqual({ success: true })
    expect(cancelOrder).toHaveBeenCalledTimes(1)
  })

  test("keeps control-order writes available during the benign missing-order lookup brake", async () => {
    mockServerTimeFetch()
    const cancelOrder = jest.fn(async () => ({ code: 0, data: { orderId: "write-during-lookup-brake" } }))
    const connector = await connectorWithTradeService({ cancelOrder })
    ;(BingXConnector as any).bingxLookupCooldownUntil = Date.now() + 90_000
    try {
      await expect(connector.getOrder("BTCUSDT", "lookup-miss")).resolves.toBeNull()
      await expect(connector.cancelOrder("BTCUSDT", "write-during-lookup-brake")).resolves.toEqual({ success: true })
      expect(cancelOrder).toHaveBeenCalledTimes(1)
    } finally {
      ;(BingXConnector as any).bingxLookupCooldownUntil = 0
    }
  })

  test("treats an SDK-thrown already-absent cancellation as success without a REST retry", async () => {
    const fetchMock = mockServerTimeFetch()
    const cancelOrder = jest.fn(async () => {
      throw new Error("109400: order does not exist")
    })
    const connector = await connectorWithTradeService({ cancelOrder })
    const requestsBeforeCancel = fetchMock.mock.calls.length

    await expect(connector.cancelOrder("BTCUSDT", "retired-control-1")).resolves.toEqual({ success: true })
    expect(cancelOrder).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeCancel)
    expect(connector.getLastOperationTransport("cancelOrder")).toMatchObject({
      transport: "bingx-api",
      fallbackReason: "order already absent",
    })
  })

  test("reuses an authoritative missing-order observation instead of cancelling the same id", async () => {
    const requests: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      requests.push(url.pathname)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/openOrder") {
        return Response.json({ code: 109400, msg: "order does not exist" })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const cancelOrder = jest.fn()
    const connector = await connectorWithTradeService({ cancelOrder })

    await expect(connector.getOpenOrder("BTCUSDT", "retired-control-2")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("109400"),
    })
    await expect(connector.cancelOrder("BTCUSDT", "retired-control-2")).resolves.toEqual({ success: true })

    expect(cancelOrder).not.toHaveBeenCalled()
    expect(requests.filter((path) => path === "/openApi/swap/v2/trade/openOrder")).toHaveLength(1)
  })
})
