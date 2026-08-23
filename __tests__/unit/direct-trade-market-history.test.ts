const fetchBingXPublicMock = jest.fn()

jest.mock("@/lib/bingx-public-api", () => ({
  fetchBingXPublic: (...args: unknown[]) => fetchBingXPublicMock(...args),
}))

describe("Direct-Trade venue-bound market history", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    delete process.env.DIRECT_TRADE_SYNTHETIC_MARKET_DATA
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.DIRECT_TRADE_SYNTHETIC_MARKET_DATA
  })

  test("normalizes newest-first Bybit linear candles into an ascending unique minute series", async () => {
    const now = Date.now()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        retCode: 0,
        result: {
          list: [
            [String(now - 60_000), "101", "103", "100", "102", "11"],
            [String(now - 120_000), "100", "102", "99", "101", "10"],
          ],
        },
      }),
    }) as any
    const { fetchDirectTradeMinuteHistory } = await import("@/lib/direct-trade-market-history")

    const candles = await fetchDirectTradeMinuteHistory("BYBIT", "BTC-USDT", 1)

    expect(candles).toHaveLength(2)
    expect(candles.map((candle) => candle.time)).toEqual([...candles.map((candle) => candle.time)].sort((a, b) => a - b))
    expect(candles[1]).toMatchObject({ open: 101, high: 103, low: 100, close: 102, volume: 11 })
    const url = String((global.fetch as jest.Mock).mock.calls[0][0])
    expect(url).toContain("api.bybit.com/v5/market/kline")
    expect(url).toContain("category=linear")
    expect(url).toContain("symbol=BTCUSDT")
    expect(fetchBingXPublicMock).not.toHaveBeenCalled()
  })

  test("rejects unsupported venues rather than silently using a different exchange", async () => {
    const { fetchDirectTradeMinuteHistory } = await import("@/lib/direct-trade-market-history")

    await expect(fetchDirectTradeMinuteHistory("binance", "BTCUSDT", 1))
      .rejects.toThrow("not supported")
    expect(global.fetch).toBe(originalFetch)
    expect(fetchBingXPublicMock).not.toHaveBeenCalled()
  })
})
