import {
  forexLotsFromUnits,
  forexNotionalUsd,
  forexPriceMovePnlUsd,
  forexPipSize,
  forexPriceDigits,
  forexUnitsFromLots,
  normalizeForexSymbol,
} from "@/lib/forex-market"
import { calculateObservedSpread, effectivePositionCostPercent } from "@/lib/position-cost"
import { InstaForexConnector } from "@/lib/exchange-connectors/instaforex-connector"
import { VolumeCalculator } from "@/lib/volume-calculator"

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response
}

function connector(): InstaForexConnector {
  return new InstaForexConnector({
    apiKey: "12345678",
    apiSecret: "",
    accountId: "12345678",
    isTestnet: false,
    marketType: "forex",
    apiType: "forex",
    positionCostPercent: 0.1,
    spreadBufferPips: 0,
    spreadMultiplier: 0,
  }, "instaforex")
}

function bridgeConnector(): InstaForexConnector {
  return new InstaForexConnector({
    apiKey: "12345678",
    apiSecret: "",
    accountId: "12345678",
    accountPassword: "terminal-password-for-test-only",
    accountServer: "InstaForex-Demo",
    bridgeUrl: "http://127.0.0.1:8765",
    bridgeToken: "bridge-token",
    forexExecutionMode: "mt5_bridge",
    executionMode: "mt5_bridge",
    connectionMethod: "bridge",
    connectionLibrary: "mt5-bridge",
    readOnly: false,
    isTestnet: false,
    marketType: "forex",
    apiType: "forex",
    positionCostPercent: 0.1,
    spreadBufferPips: 0,
    spreadMultiplier: 0,
  }, "instaforex")
}

describe("Forex market accounting", () => {
  test("normalizes broker symbols and uses InstaForex lot units", () => {
    expect(normalizeForexSymbol("eur/usd.fx")).toBe("EURUSD")
    expect(forexPipSize("USDJPY")).toBe(0.01)
    expect(forexPriceDigits("USDJPY")).toBe(3)
    expect(forexUnitsFromLots(1)).toBe(10_000)
    expect(forexLotsFromUnits(25_000)).toBe(2.5)
  })

  test("normalizes USD notional for direct and cross pairs", () => {
    expect(forexNotionalUsd(1, 1.1, "EURUSD")).toBeCloseTo(11_000, 10)
    expect(forexNotionalUsd(1, 150, "USDJPY")).toBeCloseTo(10_000, 10)
    expect(forexNotionalUsd(1, 0.85, "EURGBP", 10_000, 0.78)).toBeCloseTo(6_630, 10)
    expect(forexNotionalUsd(1, 0.85, "EURGBP")).toBe(0)
  })

  test("uses executable direction and quote-currency conversion for PnL", () => {
    expect(forexPriceMovePnlUsd("long", 1, 1.1, 1.101, "EURUSD")).toBeCloseTo(10, 10)
    expect(forexPriceMovePnlUsd("short", 1, 1.101, 1.1, "EURUSD")).toBeCloseTo(10, 10)
    expect(forexPriceMovePnlUsd("long", 1, 0.85, 0.851, "EURGBP", 10_000, 0.78)).toBeCloseTo(7.8, 10)
    expect(forexPriceMovePnlUsd("long", 1, 0.85, 0.851, "EURGBP")).toBe(0)
  })
})

describe("Forex broker spread and PositionCost", () => {
  test("uses live bid/ask spread and preserves explicit zero multiplier/buffer", () => {
    const quote = { bid: 1.1, ask: 1.1002, marketType: "forex" as const }
    const observed = calculateObservedSpread(quote, "EURUSD")
    expect(observed?.spreadPips).toBeCloseTo(2, 10)
    expect(effectivePositionCostPercent(0.1, quote, "EURUSD", {
      marketType: "forex",
      spreadMultiplier: 0,
      spreadBufferPips: 0,
    })).toBeCloseTo(0.1, 10)

    const wide = { bid: 1.1, ask: 1.105, marketType: "forex" as const }
    expect(effectivePositionCostPercent(0.1, wide, "EURUSD", {
      marketType: "forex",
      spreadMultiplier: 1,
      spreadBufferPips: 1,
    })).toBeGreaterThan(0.1)
  })
})

describe("Forex volume sizing", () => {
  test("uses 10,000-unit lots, the higher default average, and composes live factors once", () => {
    const base = VolumeCalculator.calculatePositionVolume({
      accountBalance: 1_000_000,
      currentPrice: 1.1,
      leverage: 1,
      positionCostPercent: 1,
      positionsAverage: 1,
      marketType: "forex",
      symbol: "EURUSD",
      lotSize: 10_000,
      quantityStep: 0.01,
      quantityPrecision: 2,
    })
    const main = VolumeCalculator.calculatePositionVolume({
      accountBalance: 1_000_000,
      currentPrice: 1.1,
      leverage: 1,
      positionCostPercent: 1,
      positionsAverage: 1,
      marketType: "forex",
      symbol: "EURUSD",
      lotSize: 10_000,
      quantityStep: 0.01,
      quantityPrecision: 2,
      tradeMode: "main",
      mainVolumeFactor: 2,
      sizeMultiplier: 1.5,
    })

    expect(base.intendedNotionalUsd).toBeCloseTo(2_000, 10)
    expect(base.finalVolume).toBeCloseTo(0.19, 10)
    expect(base.volumeKind).toBe("lots")
    expect(base.lotSize).toBe(10_000)
    expect(base.positionsAverage).toBe(1)
    expect(main.intendedNotionalUsd).toBeCloseTo(6_000, 10)
    expect(main.finalVolume).toBeCloseTo(0.55, 10)
    expect(main.liveEngineFactor).toBeCloseTo(2, 10)
    expect(main.sizeMultiplier).toBeCloseTo(1.5, 10)
  })

  test("refuses cross-pair sizing without an independent USD conversion", () => {
    const missing = VolumeCalculator.calculatePositionVolume({
      accountBalance: 1_000_000,
      currentPrice: 0.85,
      leverage: 1,
      positionCostPercent: 1,
      positionsAverage: 1,
      marketType: "forex",
      symbol: "EURGBP",
      lotSize: 10_000,
    })
    const converted = VolumeCalculator.calculatePositionVolume({
      accountBalance: 1_000_000,
      currentPrice: 0.85,
      leverage: 1,
      positionCostPercent: 1,
      positionsAverage: 1,
      marketType: "forex",
      symbol: "EURGBP",
      lotSize: 10_000,
      quoteToUsdRate: 0.78,
    })

    expect(missing.conversionAvailable).toBe(false)
    expect(missing.finalVolume).toBe(0)
    expect(converted.conversionAvailable).toBe(true)
    expect(converted.intendedNotionalUsd).toBeCloseTo(2_000, 10)
    expect(converted.finalVolume).toBeCloseTo(0.31, 10)
  })
})

describe("InstaForex official connector safety", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("reports official read-only capabilities and never sends mutation requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
    const instance = connector()

    expect(instance.getEnvironmentInfo()).toMatchObject({
      executionMode: "read_only",
      executionSupported: false,
      readOnly: true,
      connectionMethod: "rest",
      connectionLibrary: "native-http",
      quantityUnit: "lots",
    })
    expect(instance.getCapabilities()).toEqual(expect.arrayContaining([
      "forex",
      "broker_spread",
      "spread_from_broker_tick",
      "position_cost",
      "read_only",
      "no_http_order_execution",
    ]))

    await expect(instance.placeOrder("EURUSD", "buy", 0.1, undefined, "market")).resolves.toMatchObject({ success: false })
    await expect(instance.placeStopOrder("EURUSD", "sell", 0.1, 1.09, "stop_loss")).resolves.toMatchObject({ success: false })
    await expect(instance.cancelOrder("EURUSD", "ticket-1")).resolves.toMatchObject({ success: false })
    await expect(instance.closePosition("EURUSD", "long")).resolves.toMatchObject({ success: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("reads broker quote bid/ask and exposes broker-sourced PositionCost", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("quotesTick")) {
        return response([{ symbol: "EURUSD", digits: 5, bid: 1.1, ask: 1.1002, lasttime: "2026-08-29T12:00:00Z" }])
      }
      if (url.includes("RequestBalanceInformation")) {
        return response({ balance: 1000, equity: 1010, freeMargin: 900, currency: "USD" })
      }
      return response({}, 404)
    })
    const instance = connector()
    const ticker = await instance.getTicker("EURUSD")

    expect(ticker).toMatchObject({
      bid: 1.1,
      ask: 1.1002,
      spreadSource: "broker_tick",
      marketType: "forex",
    })
    expect(ticker?.spreadPips).toBeCloseTo(2, 10)
    expect(ticker?.positionCostPercent).toBeCloseTo(0.1, 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("sends an optional Client Cabinet passkey only to account-read requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({ passkey: "cabinet-passkey-test" })
      return response({ balance: 1000, equity: 1000, freeMargin: 900, currency: "USD" })
    })
    const instance = new InstaForexConnector({
      apiKey: "12345678",
      apiSecret: "",
      apiPassphrase: "cabinet-passkey-test",
      accountId: "12345678",
      isTestnet: false,
      marketType: "forex",
      apiType: "forex",
    }, "instaforex")

    await expect(instance.getBalance()).resolves.toMatchObject({ success: true, balance: 1000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("uses the explicit terminal bridge for native ticket-bound execution", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/healthz")) return response({ ok: true })
      if (url.endsWith("/v1/mt5")) {
        const body = JSON.parse(String(init?.body || "{}")) as { operation?: string }
        if (body.operation === "account_info") {
          return response({ success: true, data: { balance: 1000, equity: 1000, freeMargin: 900, currency: "USD" } })
        }
        if (body.operation === "tick") {
          return response({ success: true, data: { symbol: "EURUSD", digits: 5, bid: 1.1, ask: 1.1002 } })
        }
        if (body.operation === "send_order") return response({ success: true, data: { orderId: "mt5-entry-42" } })
        if (body.operation === "send_protection") return response({ success: true, data: { orderId: "mt5-sl-42" } })
      }
      return response({}, 404)
    })
    const instance = bridgeConnector()

    expect(instance.getEnvironmentInfo()).toMatchObject({
      executionMode: "mt5_bridge",
      executionSupported: true,
      readOnly: false,
      connectionMethod: "bridge",
      connectionLibrary: "mt5-bridge",
      quantityUnit: "lots",
    })
    expect(instance.getCapabilities()).toEqual(expect.arrayContaining([
      "private_terminal_bridge",
      "order_execution",
      "native_position_sl_tp",
      "broker_managed_margin_leverage",
    ]))

    await expect(instance.getBalance()).resolves.toMatchObject({ success: true, balance: 1000 })
    await expect(instance.getTicker("EURUSD")).resolves.toMatchObject({
      bid: 1.1,
      ask: 1.1002,
      spreadSource: "broker_tick",
    })
    await expect(instance.placeOrder("EURUSD", "buy", 0.1, undefined, "market", {
      positionTicket: 42,
      stopLossPrice: 1.09,
      takeProfitPrice: 1.12,
      clientOrderId: "entry-42",
    })).resolves.toEqual({ success: true, orderId: "mt5-entry-42" })
    await expect(instance.placeStopOrder("EURUSD", "sell", 0.1, 1.09, "stop_loss", {
      positionTicket: 42,
      clientOrderId: "sl-42",
    })).resolves.toEqual({ success: true, orderId: "mt5-sl-42" })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(requests.every(({ url }) => url === "http://127.0.0.1:8765/v1/mt5")).toBe(true)
    const entryBody = JSON.parse(String(requests[2].init?.body || "{}"))
    expect(entryBody).toMatchObject({
      operation: "send_order",
      accountId: "12345678",
      password: "terminal-password-for-test-only",
      server: "InstaForex-Demo",
      positionTicket: 42,
      stopLossPrice: 1.09,
      takeProfitPrice: 1.12,
      clientOrderId: "entry-42",
    })
    expect(entryBody).not.toHaveProperty("apiSecret")
    const protectionBody = JSON.parse(String(requests[3].init?.body || "{}"))
    expect(protectionBody).toMatchObject({
      operation: "send_protection",
      positionTicket: 42,
      volumeLots: 0.1,
      triggerPrice: 1.09,
      kind: "stop_loss",
    })
  })

  test("requires exact post-close verification before reporting a bridge close as successful", async () => {
    const operations: string[] = []
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/v1/mt5")) {
        const body = JSON.parse(String(init?.body || "{}")) as { operation?: string }
        operations.push(String(body.operation || ""))
        if (body.operation === "positions") {
          return response({ success: true, data: { positions: [{
            ticket: 42,
            positionTicket: 42,
            symbol: "EURUSD",
            type: "buy",
            side: "buy",
            volume: 0.1,
            price_open: 1.1,
            price_current: 1.1002,
          }] } })
        }
        if (body.operation === "close") {
          return response({ success: true, data: {
            orderId: "close-42",
            remainingLots: 0,
            fullyClosed: true,
            postCloseVerified: true,
          } })
        }
      }
      return response({}, 404)
    })

    await expect(bridgeConnector().closePosition("EURUSD", "long")).resolves.toMatchObject({
      success: true,
      orderId: "close-42",
      fullyClosed: true,
      postCloseVerified: true,
    })
    expect(operations).toEqual(["positions", "close"])
  })

})
