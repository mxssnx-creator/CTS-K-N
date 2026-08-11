import { BinanceConnector } from "@/lib/exchange-connectors/binance-connector"
import { OKXConnector } from "@/lib/exchange-connectors/okx-connector"
import { OrangeXConnector } from "@/lib/exchange-connectors/orangex-connector"

const response = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "content-type": "application/json" },
})

describe("exchange control-order options", () => {
  afterEach(() => jest.restoreAllMocks())

  test("Binance accepts its code-less success payload and forwards one-way reduce-only/client id", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response({ orderId: 12345 }))
    const connector = new BinanceConnector({
      apiKey: "binance-key",
      apiSecret: "binance-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
    })

    const result = await connector.placeOrder("BTCUSDT", "sell", 0.1, 0, "market", {
      reduceOnly: true,
      hedgeMode: false,
      clientOrderId: "dtclose_BTC_1",
    })

    expect(result).toEqual({ success: true, orderId: 12345 })
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get("reduceOnly")).toBe("true")
    expect(url.searchParams.get("newClientOrderId")).toBe("dtclose_BTC_1")
    expect(url.searchParams.has("positionSide")).toBe(false)
  })

  test("Binance hedge controls bind the owned position side without illegal reduceOnly", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response({ orderId: 222 }))
    const connector = new BinanceConnector({
      apiKey: "binance-key",
      apiSecret: "binance-secret",
      isTestnet: true,
      apiType: "perpetual_futures",
    })

    await connector.placeOrder("BTCUSDT", "sell", 0.1, 0, "market", {
      reduceOnly: true,
      hedgeMode: true,
      positionSide: "LONG",
      clientOrderId: "dtclose_BTC_2",
    })

    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get("positionSide")).toBe("LONG")
    expect(url.searchParams.has("reduceOnly")).toBe(false)
  })

  test("OKX forwards client id and correct net/hedge close semantics", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(response({ code: "0", data: [{ ordId: "okx-net" }] }))
      .mockResolvedValueOnce(response({ code: "0", data: [{ ordId: "okx-hedge" }] }))
    const connector = new OKXConnector({
      apiKey: "okx-key",
      apiSecret: "okx-secret",
      apiPassphrase: "okx-passphrase",
      isTestnet: true,
      apiType: "perpetual_futures",
      marginType: "cross",
    })

    await connector.placeOrder("BTC-USDT-SWAP", "sell", 1, 0, "market", {
      reduceOnly: true,
      hedgeMode: false,
      clientOrderId: "dtclose_okx_net_1",
    })
    await connector.placeOrder("BTC-USDT-SWAP", "buy", 1, 0, "market", {
      reduceOnly: true,
      hedgeMode: true,
      positionSide: "SHORT",
      clientOrderId: "dtclose_okx_hedge_1",
    })

    const netBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    const hedgeBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))
    expect(netBody).toMatchObject({ reduceOnly: true, clOrdId: "dtcloseokxnet1", tdMode: "cross" })
    expect(netBody.posSide).toBeUndefined()
    expect(hedgeBody).toMatchObject({ posSide: "short", clOrdId: "dtcloseokxhedge1" })
    expect(hedgeBody.reduceOnly).toBeUndefined()
  })

  test("OKX rejects a per-order sCode failure even when the envelope code is zero", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(response({
      code: "0",
      data: [{ ordId: "", sCode: "51008", sMsg: "Insufficient balance" }],
    }))
    const connector = new OKXConnector({
      apiKey: "okx-key",
      apiSecret: "okx-secret",
      apiPassphrase: "okx-passphrase",
      isTestnet: true,
      apiType: "perpetual_futures",
    })

    const result = await connector.placeOrder("BTC-USDT-SWAP", "buy", 1, 0, "market", {
      clientOrderId: "PortableControl123",
    })

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Insufficient balance") })
  })

  test("OrangeX legacy fails before network when safe control fields are requested", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
    const connector = new OrangeXConnector({
      apiKey: "orangex-key",
      apiSecret: "orangex-secret",
      isTestnet: false,
      apiType: "perpetual_futures",
      connectionLibrary: "legacy",
    })

    const result = await connector.placeOrder("BTCUSDT", "sell", 1, 0, "market", {
      reduceOnly: true,
      clientOrderId: "dtclose_orangex_legacy",
    })

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("cannot guarantee reduce-only/idempotent"),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
