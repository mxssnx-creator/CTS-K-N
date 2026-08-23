import {
  resolveMarketDataFetchDeadlineMs,
  withMarketDataFetchDeadline,
} from "@/lib/market-data-loader"

describe("market-data connector deadline", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("defaults to 15 seconds and clamps unsafe overrides", () => {
    expect(resolveMarketDataFetchDeadlineMs(undefined)).toBe(15_000)
    expect(resolveMarketDataFetchDeadlineMs("20")).toBe(1_000)
    expect(resolveMarketDataFetchDeadlineMs("45000")).toBe(45_000)
    expect(resolveMarketDataFetchDeadlineMs("999999")).toBe(60_000)
    expect(resolveMarketDataFetchDeadlineMs("invalid")).toBe(15_000)
  })

  test("rejects a connector operation that never settles", async () => {
    jest.useFakeTimers()
    const pending = withMarketDataFetchDeadline(
      () => new Promise<never>(() => undefined),
      "Bybit:BTCUSDT",
      1_000,
    )
    const rejection = expect(pending).rejects.toThrow("Bybit:BTCUSDT timed out after 1000ms")

    await jest.advanceTimersByTimeAsync(1_000)
    await rejection
  })

  test("returns a completed venue result and clears its timer", async () => {
    jest.useFakeTimers()
    await expect(withMarketDataFetchDeadline(async () => [1, 2, 3], "BingX:BTCUSDT", 5_000))
      .resolves.toEqual([1, 2, 3])
    expect(jest.getTimerCount()).toBe(0)
  })
})
