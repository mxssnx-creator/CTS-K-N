import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

describe("BingX environment-specific ticker admission", () => {
  const originalFetch = global.fetch
  const create = (isTestnet = true) => new BingXConnector({ apiKey: "test", apiSecret: "test", isTestnet, apiType: "perpetual_futures" })
  afterEach(() => {
    global.fetch = originalFetch
    for (const key of ["swapMarkets", "swapMarketsInFlight", "invalidTickerSymbols", "tickerCooldownUntil"]) (BingXConnector as any)[key].clear()
    ;(BingXConnector as any).sharedLastSync = 0
    ;(BingXConnector as any).sharedSyncPromise = null
    jest.restoreAllMocks()
  })

  test("shares inventory reads, rejects unavailable VST symbols and separates Mainnet inventory", async () => {
    const requests: URL[] = []
    global.fetch = jest.fn(async (input) => {
      const url = new URL(String(input)); requests.push(url)
      if (url.pathname.endsWith("/time")) return Response.json({ code: 0, data: { serverTime: Date.now() } })
      if (url.pathname.endsWith("/contracts")) return Response.json({ code: 0, data: [{ symbol: "BTC-USDT" }, ...(!url.hostname.includes("vst") ? [{ symbol: "NEW-USDT" }] : [])] })
      return Response.json({ code: 0, data: { bidPrice: "99", askPrice: "101", lastPrice: "100" } })
    }) as typeof fetch
    const a = create(), b = create()
    await Promise.all([a.getTicker("NEWUSDT"), b.getTicker("OTHERUSDT")])
    expect(requests.filter((url) => url.pathname.endsWith("/contracts"))).toHaveLength(1)
    expect(requests.filter((url) => url.pathname.endsWith("/ticker"))).toHaveLength(0)
    await expect(a.getTicker("BTCUSDT")).resolves.toMatchObject({ last: 100 })
    await expect(create(false).getTicker("NEWUSDT")).resolves.toMatchObject({ last: 100 })
    expect(requests.filter((url) => url.pathname.endsWith("/contracts"))).toHaveLength(2)
  })

  test("honors the venue quote cooldown and retries only after its deadline", async () => {
    let now = 1_780_000_000_000
    jest.spyOn(Date, "now").mockImplementation(() => now)
    let tickers = 0
    global.fetch = jest.fn(async (input) => {
      if (String(input).includes("/server/time")) return Response.json({ code: 0, data: { serverTime: now } })
      if (String(input).includes("/contracts")) return Response.json({ code: 0, data: [{ symbol: "BTC-USDT" }] })
      tickers++
      return tickers === 1
        ? Response.json({ code: 109429, msg: `over 5 error code:109415 requests, can retry after time: ${now + 10_000}` })
        : Response.json({ code: 0, data: { lastPrice: "100" } })
    }) as typeof fetch
    const connector = create()
    await expect(connector.getTicker("BTCUSDT")).resolves.toBeNull()
    await expect(create().getTicker("BTCUSDT")).resolves.toBeNull()
    expect(tickers).toBe(1)
    now += 10_001
    await expect(connector.getTicker("BTCUSDT")).resolves.toMatchObject({ last: 100 })
    expect(tickers).toBe(2)
  })

  test("negative-caches a delisted symbol throughout the venue error window", async () => {
    let tickers = 0
    global.fetch = jest.fn(async (input) => {
      if (String(input).includes("/server/time")) return Response.json({ code: 0, data: { serverTime: Date.now() } })
      if (String(input).includes("/contracts")) return Response.json({ code: 0, data: [{ symbol: "OLD-USDT" }] })
      tickers++
      return Response.json({ code: 109415, msg: "symbol unavailable" })
    }) as typeof fetch
    for (let i = 0; i < 7; i++) await expect(create().getTicker("OLDUSDT")).resolves.toBeNull()
    expect(tickers).toBe(1)
  })
})
