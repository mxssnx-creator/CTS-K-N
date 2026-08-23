import { BybitConnector } from "@/lib/exchange-connectors/bybit-connector"

function bybitResponse(result: unknown = {}, retCode = 0, retMsg = "OK"): Response {
  return new Response(JSON.stringify({ retCode, retMsg, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function credentials(apiType = "unified") {
  return {
    apiKey: "bybit-api-key-for-contract-test",
    apiSecret: "bybit-api-secret-for-contract-test",
    isTestnet: true,
    apiType,
    contractType: "usdt-perpetual",
    positionMode: "hedge",
  }
}

describe("Bybit V5 connector contract", () => {
  const originalFetch = global.fetch
  const originalDateNow = Date.now

  beforeEach(() => {
    ;(BybitConnector as any).sharedTimeOffset = 0
    ;(BybitConnector as any).sharedLastSync = originalDateNow()
    ;(BybitConnector as any).sharedSyncPromise = null
  })

  afterEach(() => {
    global.fetch = originalFetch
    Date.now = originalDateNow
    jest.restoreAllMocks()
  })

  test("signs at rate-limiter dispatch time instead of queue-entry time", async () => {
    let clock = 1_800_000_000_000
    Date.now = () => clock
    ;(BybitConnector as any).sharedLastSync = clock
    const requests: Array<{ url: string; init?: RequestInit }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return bybitResponse({ list: [{ coin: [{ coin: "USDT", walletBalance: "25" }] }] })
    }) as typeof fetch
    const connector = new BybitConnector(credentials())
    ;(connector as any).rateLimiter = {
      execute: async (operation: () => Promise<Response>) => {
        clock += 12_000
        return operation()
      },
    }

    await expect(connector.getBalance()).resolves.toMatchObject({ success: true, balance: 25 })
    const timestamp = Number((requests[0]?.init?.headers as Record<string, string>)?.["X-BAPI-TIMESTAMP"])
    expect(timestamp).toBe(clock - 500)
  })

  test("queries only active orders and never treats leavesQty as a fill", async () => {
    const requests: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      requests.push(String(input))
      return bybitResponse({ list: [{
        orderId: "open-1",
        symbol: "BTCUSDT",
        side: "Buy",
        orderType: "Limit",
        orderStatus: "New",
        qty: "0.1",
        leavesQty: "0.1",
        price: "60000",
      }] })
    }) as typeof fetch

    const orders = await new BybitConnector(credentials()).getOpenOrders("BTCUSDT")
    expect(requests[0]).toContain("openOnly=0")
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ orderId: "open-1", status: "pending", filledQty: 0 })
  })

  test("falls back from realtime to authoritative history for terminal orders", async () => {
    const requests: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/v5/order/realtime")) return bybitResponse({ list: [] })
      return bybitResponse({ list: [{
        orderId: "terminal-1",
        symbol: "BTCUSDT",
        side: "Sell",
        orderType: "Market",
        orderStatus: "Filled",
        qty: "0.1",
        cumExecQty: "0.1",
        avgPrice: "61000",
      }] })
    }) as typeof fetch

    const order = await new BybitConnector(credentials()).getOrder("BTCUSDT", "terminal-1")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("/v5/order/history")
    expect(requests[1]).toContain("orderId=terminal-1")
    expect(order).toMatchObject({ orderId: "terminal-1", status: "filled", filledQty: 0.1 })
  })

  test("places exchange-native close-only protection and cancels idempotently", async () => {
    const requests: Array<{ url: string; body: any }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.includes("/v5/order/create")) return bybitResponse({ orderId: "stop-1" })
      return bybitResponse({}, 170213, "Order does not exist")
    }) as typeof fetch
    const connector = new BybitConnector(credentials())

    await expect(connector.placeStopOrder("BTCUSDT", "sell", 0.1, 59000, "stop_loss", {
      hedgeMode: true,
      positionSide: "LONG",
      clientOrderId: "control-stop-1",
    })).resolves.toEqual({ success: true, orderId: "stop-1" })
    await expect(connector.cancelOrder("BTCUSDT", "stop-1")).resolves.toEqual({ success: true })

    expect(requests[0]?.body).toMatchObject({
      category: "linear",
      side: "Sell",
      triggerDirection: 2,
      reduceOnly: true,
      closeOnTrigger: true,
      positionIdx: 1,
      orderLinkId: "control-stop-1",
    })
  })

  test("maps legacy contract accounts to Bybit CONTRACT wallet type", async () => {
    let requestedUrl = ""
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return bybitResponse({ list: [{ coin: [] }] })
    }) as typeof fetch

    await new BybitConnector(credentials("contract")).getBalance()
    expect(requestedUrl).toContain("accountType=CONTRACT")
  })
})
