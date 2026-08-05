import { OrangeXConnector } from "@/lib/exchange-connectors/orangex-connector"
import { PionexConnector } from "@/lib/exchange-connectors/pionex-connector"

function jsonRpc(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("documented futures connector contracts", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test("Pionex futures uses UAPI fields for positions, hedge orders and close orders", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes("/account/positions")) {
        return new Response(JSON.stringify({ result: true, data: { positions: [{
          symbol: "BTC_USDT_PERP",
          positionSide: "LONG",
          netSize: "0.25",
          avgPrice: "60000",
          markPrice: "60100",
          leverage: 5,
          isolatedMode: false,
          unrealizedPnL: "25",
        }] } }), { status: 200 })
      }
      if (url.includes("/trade/order")) {
        return new Response(JSON.stringify({ result: true, data: { orderId: "pionex-order-1" } }), { status: 200 })
      }
      if (url.includes("/account/balances")) {
        return new Response(JSON.stringify({ result: true, data: { balances: [{ coin: "USDT", free: "1000", frozen: "10" }] } }), { status: 200 })
      }
      if (url.includes("/market/tickers")) {
        return new Response(JSON.stringify({ result: true, data: { tickers: [{ symbol: "BTC_USDT_PERP", bidPrice: "60000", askPrice: "60001", lastPrice: "60000.5" }] } }), { status: 200 })
      }
      if (url.includes("/market/klines")) {
        return new Response(JSON.stringify({ result: true, data: { klines: [{ time: 1_700_000_000_000, open: "59000", high: "60100", low: "58900", close: "60000", volume: "12" }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ result: true, data: {} }), { status: 200 })
    }) as typeof fetch

    const connector = new PionexConnector({
      apiKey: "pionex-key",
      apiSecret: "pionex-secret",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    const balance = await connector.getBalance()
    expect(balance.balance).toBe(1000)
    await expect(connector.getTicker("BTC-USDT")).resolves.toEqual({ bid: 60000, ask: 60001, last: 60000.5 })
    await expect(connector.getOHLCV("BTC-USDT", "1m", 1)).resolves.toEqual([{
      timestamp: 1_700_000_000_000,
      open: 59000,
      high: 60100,
      low: 58900,
      close: 60000,
      volume: 12,
    }])

    const order = await connector.placeOrder("BTC-USDT", "buy", 0.25, undefined, "market", {
      hedgeMode: true,
      positionSide: "LONG",
      clientOrderId: "row/live:1",
    })
    expect(order).toEqual({ success: true, orderId: "pionex-order-1" })

    const positions = await connector.getPositions("BTC-USDT")
    expect(positions[0]).toMatchObject({ symbol: "BTC_USDT_PERP", side: "long", contracts: 0.25, entryPrice: 60000 })

    await connector.closePosition("BTC-USDT", "long")
    const orderRequests = requests.filter((request) => request.url.includes("/trade/order"))
    expect(orderRequests).toHaveLength(2)
    expect(JSON.parse(String(orderRequests[0]?.init?.body))).toMatchObject({
      symbol: "BTC_USDT_PERP",
      positionSide: "LONG",
      side: "BUY",
      type: "MARKET_QTY",
      size: "0.25",
    })
    expect(JSON.parse(String(orderRequests[1]?.init?.body))).toMatchObject({
      symbol: "BTC_USDT_PERP",
      positionSide: "LONG",
      side: "SELL",
      type: "MARKET_QTY",
      size: "0.25",
    })
  })

  test("OrangeX authenticates through JSON-RPC and preserves reduce-only, hedge and STOP fields", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (url.endsWith("/public/auth")) {
        return jsonRpc({ access_token: "orangex-token", expires_in: 900 })
      }
      if (url.endsWith("/private/get_assets_info")) {
        return jsonRpc({
          PERPETUAL: {
            available_funds: "900",
            order_frozen: "5",
            total_margin_balance: "905",
          },
        })
      }
      if (url.endsWith("/private/get_positions")) {
        return jsonRpc([{ instrument_name: "BTC-USDT-PERPETUAL", size: "0.2", direction: "buy", average_price: "60000", mark_price: "60100", pos_id: "pos-1" }])
      }
      if (url.endsWith("/private/buy")) {
        expect(body.params).toMatchObject({ instrument_name: "BTC-USDT-PERPETUAL", position_side: "LONG" })
        return jsonRpc({ order_id: "orangex-open-1" })
      }
      if (url.endsWith("/private/sell")) {
        expect(body.params).toMatchObject({
          instrument_name: "BTC-USDT-PERPETUAL",
          position_side: "LONG",
          reduce_only: true,
          condition_type: "STOP",
          trigger_price: "59000",
        })
        return jsonRpc({ order_id: "orangex-stop-1" })
      }
      if (url.endsWith("/private/close_position")) {
        expect(body.params).toMatchObject({ instrument_name: "BTC-USDT-PERPETUAL", type: "market", amount: "0.2", pos_id: "pos-1" })
        return jsonRpc({ order_id: "orangex-close-1" })
      }
      if (url.endsWith("/private/get_tradingview_chart_data")) {
        return jsonRpc([{ tick: 1_700_000_000, open: "59000", high: "60100", low: "58900", close: "60000", volume: "12" }])
      }
      return jsonRpc({})
    }) as typeof fetch

    const connector = new OrangeXConnector({
      apiKey: "orangex-client",
      apiSecret: "orangex-secret",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      positionMode: "hedge",
    })

    const balance = await connector.getBalance()
    expect(balance.balance).toBe(905)
    await expect(connector.placeOrder("BTC/USDT", "buy", 0.2, undefined, "market", {
      hedgeMode: true,
      positionSide: "LONG",
      clientOrderId: "row/live:1",
    })).resolves.toEqual({ success: true, orderId: "orangex-open-1" })
    await expect(connector.placeStopOrder("BTC/USDT", "sell", 0.2, 59000, "stop_loss", {
      hedgeMode: true,
      positionSide: "LONG",
    })).resolves.toEqual({ success: true, orderId: "orangex-stop-1" })
    await expect(connector.closePosition("BTC/USDT", "long")).resolves.toEqual({ success: true })
    await expect(connector.getOHLCV("BTC/USDT", "1m", 1)).resolves.toEqual([{
      timestamp: 1_700_000_000_000,
      open: 59000,
      high: 60100,
      low: 58900,
      close: 60000,
      volume: 12,
    }])
    await expect(connector.getOHLCV("BTC/USDT", "1d", 1)).resolves.toEqual([{
      timestamp: 1_700_000_000_000,
      open: 59000,
      high: 60100,
      low: 58900,
      close: 60000,
      volume: 12,
    }])
    const chartRequest = requests.filter((request) => request.url.endsWith("/private/get_tradingview_chart_data")).at(-1)
    expect(JSON.parse(String(chartRequest?.init?.body)).params).toMatchObject({ resolution: "D" })

    expect(requests.some((request) => request.url.endsWith("/public/auth"))).toBe(true)
    expect(requests.filter((request) => request.url.endsWith("/public/auth"))).toHaveLength(1)
  })
})
