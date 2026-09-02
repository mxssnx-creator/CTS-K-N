const fetchBingXPublicMock = jest.fn()

jest.mock("@/lib/bingx-public-api", () => ({
  fetchBingXPublic: (...args: unknown[]) => fetchBingXPublicMock(...args),
}))

import { fetchTopSymbols } from "@/lib/top-symbols"

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function cryptoRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `S${String(index + 1).padStart(3, "0")}-USDT`,
    lastPrice: String(100 + index),
    priceChangePercent: String(index / 100),
    volume: String(index + 1),
    quoteVolume: String(index + 1),
  }))
}

describe("high-scale top-symbol resolution", () => {
  beforeEach(() => {
    fetchBingXPublicMock.mockReset()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test("retains 160 unique BingX symbols while bounding ATR work to 128 at concurrency eight", async () => {
    let activeKlines = 0
    let maximumKlines = 0
    fetchBingXPublicMock.mockImplementation(async (pathname: string) => {
      if (pathname.includes("/quote/ticker")) {
        return response({ code: 0, data: cryptoRows(160) })
      }
      if (pathname.includes("/quote/klines")) {
        activeKlines += 1
        maximumKlines = Math.max(maximumKlines, activeKlines)
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
        activeKlines -= 1
        return response({
          code: 0,
          data: [
            { open: "100", high: "102", low: "99", close: "101" },
            { open: "101", high: "103", low: "100", close: "102" },
          ],
        })
      }
      return response({}, 404)
    })

    const result = await fetchTopSymbols("bingx", 160, "volatility_1h")
    const symbols = result.symbols.map((ticker) => ticker.symbol)
    const klineCalls = fetchBingXPublicMock.mock.calls
      .filter(([pathname]) => String(pathname).includes("/quote/klines"))

    expect(symbols).toHaveLength(160)
    expect(new Set(symbols).size).toBe(160)
    expect(symbols).toContain("S160USDT")
    expect(klineCalls).toHaveLength(128)
    expect(fetchBingXPublicMock).toHaveBeenCalledWith(
      "/openApi/swap/v2/quote/ticker",
      {},
      { timeoutMs: 15_000 },
    )
    expect(maximumKlines).toBeGreaterThan(1)
    expect(maximumKlines).toBeLessThanOrEqual(8)
  })

  test("batches 128 InstaForex quotes into 50/50/28 without losing pair identity", async () => {
    const codes = [
      "AED", "AUD", "CAD", "CHF", "CNH", "CZK", "DKK", "EUR", "GBP", "HKD",
      "HUF", "ILS", "JPY", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "THB",
      "TRY", "USD", "XAG", "XAU", "ZAR",
    ]
    const pairs: string[] = []
    for (const base of codes) {
      for (const quote of codes) {
        if (base !== quote) pairs.push(`${base}${quote}`)
      }
    }
    const listed = pairs.slice(0, 128)
    const quoteBatchSizes: number[] = []
    let activeQuoteRequests = 0
    let maximumQuoteRequests = 0
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/quotesList")) {
        return response({ quotesList: listed.map((symbol) => ({ symbol, group: { name: "Forex" } })) })
      }
      if (url.pathname.endsWith("/quotesTick")) {
        const symbols = String(url.searchParams.get("q") || "").split(",").filter(Boolean)
        quoteBatchSizes.push(symbols.length)
        activeQuoteRequests += 1
        maximumQuoteRequests = Math.max(maximumQuoteRequests, activeQuoteRequests)
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
        activeQuoteRequests -= 1
        return response(symbols.map((symbol, index) => ({
          symbol: symbol.toUpperCase(),
          change24h: index + 1,
        })))
      }
      return response({}, 404)
    }) as typeof fetch

    const result = await fetchTopSymbols("instaforex", 128, "volatility")
    const symbols = result.symbols.map((ticker) => ticker.symbol)

    expect(symbols).toHaveLength(128)
    expect(new Set(symbols).size).toBe(128)
    expect(quoteBatchSizes.sort((left, right) => right - left)).toEqual([50, 50, 28])
    expect(maximumQuoteRequests).toBeLessThanOrEqual(8)
  })

  test.each(["binance", "bybit", "okx"])(
    "%s keeps low-volume but active markets when a 128-symbol basket is requested",
    async (exchange) => {
      const rows = cryptoRows(130)
      global.fetch = jest.fn(async () => {
        if (exchange === "binance") {
          return response(rows.map((row) => ({
            symbol: row.symbol.replace("-", ""),
            lastPrice: row.lastPrice,
            priceChangePercent: row.priceChangePercent,
            quoteVolume: "1",
          })))
        }
        if (exchange === "bybit") {
          return response({ result: { list: rows.map((row) => ({
            symbol: row.symbol.replace("-", ""),
            lastPrice: row.lastPrice,
            price24hPcnt: "0.01",
            turnover24h: "1",
          })) } })
        }
        return response({ data: rows.map((row) => ({
          instId: `${row.symbol}-SWAP`,
          last: row.lastPrice,
          sodUtc8: "0.01",
          volCcy24h: "1",
        })) })
      }) as typeof fetch

      const result = await fetchTopSymbols(exchange, 128, "volume")
      expect(result.symbols).toHaveLength(128)
      expect(new Set(result.symbols.map((ticker) => ticker.symbol)).size).toBe(128)
    },
  )

  test("caches an exchange-exhaustive result even when fewer than 1,000 markets exist", async () => {
    const rows = cryptoRows(130)
    const fetchMock = jest.fn(async () => response({ data: rows.map((row) => ({
      instId: `${row.symbol}-SWAP`,
      last: row.lastPrice,
      sodUtc8: "0.01",
      volCcy24h: "1",
    })) }))
    global.fetch = fetchMock as typeof fetch

    const first = await fetchTopSymbols("okx", 1_000, "volume")
    const second = await fetchTopSymbols("okx", 1_000, "volume")

    expect(first.symbols).toHaveLength(130)
    expect(second.symbols).toEqual(first.symbols)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
