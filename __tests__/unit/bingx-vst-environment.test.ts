import {
  BINGX_PROD_VST_FALLBACK_ORIGIN,
  BINGX_PROD_VST_ORIGIN,
  configuredBingXOriginForEnvironment,
  normalizeBingXEnvironment,
} from "@/lib/bingx-environment"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

describe("BingX Prod-VST connector contract", () => {
  const originalFetch = global.fetch
  const originalVstOrigin = process.env.BINGX_VST_ORIGIN

  beforeEach(() => {
    delete process.env.BINGX_VST_ORIGIN
  })

  afterEach(() => {
    global.fetch = originalFetch
    ;(BingXConnector as any).openOrdersSnapshotCache?.clear()
    ;(BingXConnector as any).sharedTimeOffset = 0
    ;(BingXConnector as any).sharedLastSync = 0
    ;(BingXConnector as any).sharedSyncPromise = null
    jest.restoreAllMocks()
  })

  afterAll(() => {
    if (originalVstOrigin === undefined) delete process.env.BINGX_VST_ORIGIN
    else process.env.BINGX_VST_ORIGIN = originalVstOrigin
  })

  test("normalizes explicit environment aliases and fails closed on unknown values", () => {
    expect(normalizeBingXEnvironment("demo")).toBe("prod-vst")
    expect(normalizeBingXEnvironment("testnet")).toBe("prod-vst")
    expect(normalizeBingXEnvironment("mainnet")).toBe("prod-live")
    expect(() => normalizeBingXEnvironment("staging")).toThrow("Unsupported BINGX_ENVIRONMENT")
    expect(configuredBingXOriginForEnvironment("prod-vst")).toBe(BINGX_PROD_VST_ORIGIN)
    process.env.BINGX_VST_ORIGIN = BINGX_PROD_VST_FALLBACK_ORIGIN
    expect(configuredBingXOriginForEnvironment("prod-vst")).toBe(BINGX_PROD_VST_FALLBACK_ORIGIN)
    process.env.BINGX_VST_ORIGIN = "https://example.invalid"
    expect(() => configuredBingXOriginForEnvironment("prod-vst")).toThrow(
      "Unsupported BINGX_VST_ORIGIN",
    )
  })

  test("anchors a slow VST time sample at response arrival so the next signature stays behind the venue clock", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      if (url.pathname !== "/openApi/swap/v2/server/time") {
        throw new Error(`Unexpected request: ${url.pathname}`)
      }
      // The venue emits its clock just before it returns the response. A
      // midpoint estimate would turn this 6s first request into a +2.7s
      // offset and produce a future-dated signed request.
      now += 6_000
      return Response.json({ code: 0, data: { serverTime: now - 280 } })
    }) as typeof fetch

    try {
      const connector = new BingXConnector({
        apiKey: "demo-api-key",
        apiSecret: "demo-api-secret",
        isTestnet: true,
        apiType: "perpetual_futures",
        contractType: "usdt-perpetual",
        positionMode: "hedge",
      })
      await (connector as any).syncServerTime()

      expect((connector as any).timeOffset).toBe(-280)
      expect((connector as any).getTimestamp()).toBe(now - 2_280)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/openApi/swap/v2/server/time"),
        expect.objectContaining({ cache: "no-store" }),
      )
    } finally {
      Date.now = originalNow
    }
  })

  test("keeps balance, quotes, orders, positions, and mode changes on Prod-VST", async () => {
    const requests: Array<{ url: URL; method: string }> = []
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
      requests.push({ url, method })

      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v3/user/balance") {
        return Response.json({
          code: 0,
          data: {
            balance: {
              asset: "USDT",
              balance: "100000",
              equity: "100010",
              availableMargin: "99990",
              freezedMargin: "10",
              unrealizedProfit: "10",
            },
          },
        })
      }
      if (url.pathname === "/openApi/swap/v2/quote/ticker") {
        return Response.json({ code: 0, data: { symbol: "BTC-USDT", lastPrice: "60000" } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/order" && method === "POST") {
        return Response.json({
          code: 0,
          data: {
            order: {
              orderId: "vst-order-1",
              clientOrderID: url.searchParams.get("clientOrderID"),
              status: "FILLED",
              executedQty: "0.001",
              avgPrice: "60000",
            },
          },
        })
      }
      if (url.pathname === "/openApi/swap/v2/trade/order" && method === "GET") {
        return Response.json({
          code: 0,
          data: {
            order: {
              orderId: "vst-order-1",
              clientOrderID: "cts-vst-test-1",
              symbol: "BTC-USDT",
              side: "BUY",
              type: "MARKET",
              origQty: "0.001",
              executedQty: "0.001",
              avgPrice: "60000",
              status: "FILLED",
              time: 1_700_000_000_000,
              updateTime: 1_700_000_000_100,
            },
          },
        })
      }
      if (url.pathname === "/openApi/swap/v2/user/positions") {
        return Response.json({
          code: 0,
          data: [{ symbol: "BTC-USDT", positionAmt: "0.001", positionSide: "LONG", entryPrice: "60000" }],
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as unknown as typeof fetch
    global.fetch = fetchMock

    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    expect(connector.getEnvironmentInfo()).toEqual({
      environment: "prod-vst",
      baseUrl: BINGX_PROD_VST_ORIGIN,
      isDemo: true,
      usesVirtualFunds: true,
    })

    const connection = await connector.testConnection()
    expect(connection).toMatchObject({
      success: true,
      balance: 100000,
      equity: 100010,
      availableMargin: 99990,
      unrealizedProfit: 10,
      settlementAsset: "USDT",
      btcPrice: 60000,
      balances: [{ asset: "USDT", free: 99990, locked: 10, total: 100000 }],
    })
    await expect(connector.getTicker("BTCUSDT")).resolves.toEqual({
      bid: 0,
      ask: 0,
      last: 60000,
    })

    const placed = await connector.placeOrder("BTCUSDT", "buy", 0.001, undefined, "market", {
      positionSide: "LONG",
      hedgeMode: true,
      clientOrderId: "cts-vst-test-1",
    })
    expect(placed).toMatchObject({
      success: true,
      orderId: "vst-order-1",
      filledQty: 0.001,
      filledPrice: 60000,
      status: "FILLED",
    })

    await expect(connector.getOrder("BTCUSDT", "vst-order-1")).resolves.toMatchObject({
      orderId: "vst-order-1",
      clientOrderId: "cts-vst-test-1",
      status: "filled",
      filledQty: 0.001,
      filledPrice: 60000,
    })
    await expect(connector.getOrderDetails("BTCUSDT", "vst-order-1")).resolves.toMatchObject({
      success: true,
      order: expect.objectContaining({
        orderId: "vst-order-1",
        clientOrderID: "cts-vst-test-1",
        status: "FILLED",
      }),
    })
    await expect(connector.getPositions("BTCUSDT")).resolves.toEqual([
      expect.objectContaining({
        symbol: "BTC-USDT",
        positionAmt: "0.001",
        contracts: "0.001",
        positionSide: "LONG",
      }),
    ])
    await expect(connector.setPositionMode(true)).resolves.toEqual({ success: true })

    expect(requests.length).toBeGreaterThanOrEqual(7)
    expect(requests.every(({ url }) => url.origin === BINGX_PROD_VST_ORIGIN)).toBe(true)
    expect(requests.some(({ url, method }) =>
      method === "POST"
      && url.pathname === "/openApi/swap/v2/trade/order"
      && url.searchParams.get("clientOrderID") === "cts-vst-test-1"
    )).toBe(true)
    expect(requests.some(({ url }) => url.pathname === "/openApi/swap/v2/user/positions")).toBe(true)
    expect(requests.every(({ url }) => url.pathname !== "/openApi/swap/v2/trade/positionSide/dual")).toBe(true)
    expect(requests.every(({ url }) => !url.href.includes("demo-api-secret"))).toBe(true)
  })

  test("fails closed instead of claiming a VST one-way mode mutation", async () => {
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch

    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })
    await (connector as any).syncServerTime()

    await expect(connector.setPositionMode(false)).resolves.toEqual({
      success: false,
      error: "Prod-VST position mode cannot be changed to one-way; use hedge mode with an explicit positionSide",
    })
  })

  test("refreshes a symbol snapshot immediately after a confirmed VST cancellation", async () => {
    let orderOpen = true
    const requests: Array<{ pathname: string; method: string }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
      requests.push({ pathname: url.pathname, method })
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/openOrders") {
        return Response.json({
          code: 0,
          data: { orders: orderOpen ? [{ orderId: "vst-stop-1", symbol: "BTC-USDT" }] : [] },
        })
      }
      if (url.pathname === "/openApi/swap/v2/trade/order" && method === "DELETE") {
        orderOpen = false
        return Response.json({ code: 0, data: { orderId: "vst-stop-1" } })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch

    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })
    ;(connector as any).getSdkTradeService = jest.fn(async () => null)

    await expect(connector.getOpenOrders("BTCUSDT")).resolves.toEqual([
      expect.objectContaining({ orderId: "vst-stop-1" }),
    ])
    await expect(connector.cancelOrder("BTCUSDT", "vst-stop-1")).resolves.toEqual({ success: true })
    await expect(connector.getOpenOrders("BTCUSDT")).resolves.toEqual([])

    expect(requests.filter((request) => request.pathname === "/openApi/swap/v2/trade/openOrders")).toHaveLength(2)
  })

  test("invalidates the aggregate open-order snapshot after a VST protection order is armed", async () => {
    let stopOpen = false
    const requests: Array<{ pathname: string; method: string }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
      requests.push({ pathname: url.pathname, method })
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/openOrders") {
        return Response.json({
          code: 0,
          data: { orders: stopOpen ? [{ orderId: "vst-stop-2", symbol: "BTC-USDT" }] : [] },
        })
      }
      if (url.pathname === "/openApi/swap/v2/trade/order" && method === "POST") {
        stopOpen = true
        return Response.json({ code: 0, data: { order: { orderId: "vst-stop-2" } } })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch

    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })
    ;(connector as any).getSdkTradeService = jest.fn(async () => null)

    // Populate the aggregate cache before a protection mutation. Before this
    // regression fix, the subsequent live-stage liveness sweep reused this
    // empty snapshot and unnecessarily cancelled/recreated an unchanged TP.
    await expect(connector.getOpenOrders()).resolves.toEqual([])
    await expect(connector.placeStopOrder("BTCUSDT", "sell", 0.001, 59000, "stop_loss", {
      positionSide: "LONG",
      hedgeMode: true,
      reduceOnly: true,
      clientOrderId: "cts-vst-stop-cache-2",
    })).resolves.toMatchObject({ success: true, orderId: "vst-stop-2" })
    await expect(connector.getOpenOrders()).resolves.toEqual([
      expect.objectContaining({ orderId: "vst-stop-2" }),
    ])

    expect(requests.filter((request) => request.pathname === "/openApi/swap/v2/trade/openOrders")).toHaveLength(2)
  })

  test("pins every authenticated Prod-VST request to an explicit official .pro origin", async () => {
    process.env.BINGX_VST_ORIGIN = BINGX_PROD_VST_FALLBACK_ORIGIN
    const seen: URL[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      seen.push(url)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/quote/ticker") {
        return Response.json({ code: 0, data: { symbol: "BTC-USDT", lastPrice: "60000" } })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch

    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })
    expect(connector.getEnvironmentInfo().baseUrl).toBe(BINGX_PROD_VST_FALLBACK_ORIGIN)
    await expect(connector.getTicker("BTCUSDT")).resolves.toMatchObject({ last: 60000 })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((url) => url.origin === BINGX_PROD_VST_FALLBACK_ORIGIN)).toBe(true)
  })

  test("normalizes exact-order VST fills into authoritative net PnL and fees", async () => {
    const seen: URL[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      seen.push(url)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/allFillOrders") {
        return Response.json({
          code: 0,
          data: [
            { tradeId: "fill-1", orderId: "close-1", price: "61000", qty: "0.001", realizedPnl: "1.2", fee: "-0.1", time: 100 },
            { tradeId: "fill-2", orderId: "close-1", price: "61100", qty: "0.002", realizedPnl: "0.8", fee: "-0.05", time: 200 },
            { tradeId: "other", orderId: "close-2", price: "1", qty: "99", realizedPnl: "99", fee: "-9", time: 300 },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    await expect(connector.getOrderSettlement("BTCUSDT", "close-1")).resolves.toMatchObject({
      orderId: "close-1",
      symbol: "BTC-USDT",
      filledQuantity: 0.003,
      averageFillPrice: expect.closeTo(61066.6666666667, 8),
      grossRealizedPnl: 2,
      tradingFee: 0.15,
      netRealizedPnl: 1.85,
      netIncludesEntryFee: false,
      source: "bingx_fill_history",
      settledAt: 200,
    })
    const request = seen.find((url) => url.pathname === "/openApi/swap/v2/trade/allFillOrders")!
    expect(request.searchParams.get("orderId")).toBe("close-1")
    expect(request.searchParams.get("tradingUnit")).toBe("COIN")
    expect(request.searchParams.get("currency")).toBe("USDT")
  })

  test("resyncs and re-signs an exact-fill history read once after BingX 100421", async () => {
    const fillRequests: URL[] = []
    let serverTimeReads = 0
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        serverTimeReads++
        return Response.json({ code: 0, data: { serverTime: Date.now() - serverTimeReads * 10 } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/allFillOrders") {
        fillRequests.push(url)
        if (fillRequests.length === 1) {
          return Response.json({ code: 100421, msg: "Null timestamp or timestamp mismatch" })
        }
        return Response.json({
          code: 0,
          data: [{
            tradeId: "fill-recovered",
            orderId: "close-recovered",
            price: "101",
            qty: "2",
            realizedPnl: "3",
            fee: "-0.2",
            time: 300,
          }],
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    await expect(connector.getOrderSettlement("BTCUSDT", "close-recovered")).resolves.toMatchObject({
      orderId: "close-recovered",
      grossRealizedPnl: 3,
      tradingFee: 0.2,
      netRealizedPnl: 2.8,
    })
    expect(fillRequests).toHaveLength(2)
    expect(serverTimeReads).toBeGreaterThanOrEqual(2)
    expect(Number(fillRequests[1].searchParams.get("timestamp"))).not.toBe(
      Number(fillRequests[0].searchParams.get("timestamp")),
    )
  })

  test("uses exact terminal order accounting when Prod-VST fill history is empty", async () => {
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      if (url.pathname === "/openApi/swap/v2/server/time") {
        return Response.json({ code: 0, data: { serverTime: Date.now() } })
      }
      if (url.pathname === "/openApi/swap/v2/trade/allFillOrders") {
        return Response.json({ code: 0, data: [] })
      }
      if (url.pathname === "/openApi/swap/v2/trade/order") {
        return Response.json({
          code: 0,
          data: {
            order: {
              orderId: "vst-detail-close",
              symbol: "SOL-USDT",
              status: "FILLED",
              executedQty: "0.12",
              avgPrice: "95.125",
              profit: "-0.0133",
              commission: "-0.0057",
              updateTime: 400,
            },
          },
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    await expect(connector.getOrderSettlement("SOLUSDT", "vst-detail-close")).resolves.toMatchObject({
      orderId: "vst-detail-close",
      symbol: "SOL-USDT",
      filledQuantity: 0.12,
      averageFillPrice: 95.125,
      grossRealizedPnl: -0.0133,
      tradingFee: 0.0057,
      netRealizedPnl: -0.019,
      source: "bingx_order_detail",
      settledAt: 400,
      fills: [],
    })
  })
})
