import {
  BINGX_PROD_VST_ORIGIN,
  normalizeBingXEnvironment,
} from "@/lib/bingx-environment"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

describe("BingX Prod-VST connector contract", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test("normalizes explicit environment aliases and fails closed on unknown values", () => {
    expect(normalizeBingXEnvironment("demo")).toBe("prod-vst")
    expect(normalizeBingXEnvironment("testnet")).toBe("prod-vst")
    expect(normalizeBingXEnvironment("mainnet")).toBe("prod-live")
    expect(() => normalizeBingXEnvironment("staging")).toThrow("Unsupported BINGX_ENVIRONMENT")
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
    const connector = new BingXConnector({
      apiKey: "demo-api-key",
      apiSecret: "demo-api-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    await expect(connector.setPositionMode(false)).resolves.toEqual({
      success: false,
      error: "Prod-VST position mode cannot be changed to one-way; use hedge mode with an explicit positionSide",
    })
  })
})
