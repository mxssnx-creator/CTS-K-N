/**
 * Both bounded caches in market-data-cache must hold a complete 70-symbol
 * basket. At the previous bound (64) the per-cycle prefetch evicted its own
 * oldest entries, so the same cycle re-read those symbols one by one; the
 * parsed-candle cache likewise re-parsed the evicted symbols on every pass.
 * The bound itself (LRU/oldest-first eviction) is unchanged.
 */
const hashes = new Map<string, Record<string, string>>()
const strings = new Map<string, string>()

const redis = {
  multi: jest.fn(() => {
    const queued: string[] = []
    const pipeline = {
      hgetall: (key: string) => {
        queued.push(key)
        return pipeline
      },
      exec: async () => queued.map((key) => hashes.get(key) ?? {}),
    }
    return pipeline
  }),
  get: jest.fn(async (key: string) => strings.get(key) ?? null),
}

const getMarketData = jest.fn(async () => null)

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => redis),
  getMarketData: (...args: unknown[]) => (getMarketData as any)(...args),
}))

import {
  getMarketDataCached,
  getParsedCandlesCached,
  prefetchMarketDataBatch,
} from "@/lib/trade-engine/market-data-cache"

const symbolsFor = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, "0")}USDT`)

describe("market-data-cache capacity for a 70-symbol basket", () => {
  let nowSpy: jest.SpyInstance<number, []>

  beforeEach(() => {
    hashes.clear()
    strings.clear()
    jest.clearAllMocks()
    // The latest-data cache has a 200 ms TTL; freeze time so only capacity
    // (never expiry) can produce a miss in these assertions.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
  })

  afterEach(() => nowSpy.mockRestore())

  test("a 70-symbol prefetch keeps every symbol cached for the cycle", async () => {
    const symbols = symbolsFor("CAP", 70)
    for (const symbol of symbols) hashes.set(`market_data:conn-a:${symbol}`, { symbol, close: "1" })

    await prefetchMarketDataBatch(symbols, "conn-a")
    for (const symbol of symbols) {
      expect(await getMarketDataCached(symbol, "conn-a")).toEqual({ symbol, close: "1" })
    }

    // At 64 entries the first six prefetched symbols were already evicted
    // and fell through to an individual getMarketData read each.
    expect(getMarketData).not.toHaveBeenCalled()
  })

  test("the latest-data cache stays bounded at 256 entries, oldest evicted first", async () => {
    const symbols = symbolsFor("LRU", 257)
    for (const symbol of symbols) hashes.set(`market_data:conn-b:${symbol}`, { symbol })

    await prefetchMarketDataBatch(symbols, "conn-b")
    // Hits first: they never insert, so they cannot perturb eviction order.
    for (const symbol of symbols.slice(1)) {
      expect(await getMarketDataCached(symbol, "conn-b")).toEqual({ symbol })
    }
    expect(getMarketData).not.toHaveBeenCalled()

    await getMarketDataCached(symbols[0], "conn-b")
    expect(getMarketData).toHaveBeenCalledTimes(1)
    expect(getMarketData).toHaveBeenCalledWith(symbols[0], "1m", "conn-b")
  })

  test("parsed candles for 70 symbols are reused on the next pass", async () => {
    const symbols = symbolsFor("PAR", 70)
    for (const [index, symbol] of symbols.entries()) {
      strings.set(
        `market_data:conn-c:${symbol}:candles`,
        JSON.stringify([{ timestamp: 2_000 + index, close: index }, { timestamp: 1_000 + index, close: index }]),
      )
    }

    const firstPass = new Map<string, any[]>()
    for (const symbol of symbols) firstPass.set(symbol, await getParsedCandlesCached(symbol, "conn-c"))
    for (const [index, symbol] of symbols.entries()) {
      const secondPass = await getParsedCandlesCached(symbol, "conn-c")
      // Same instance: served from the parsed cache, not re-parsed.
      expect(secondPass).toBe(firstPass.get(symbol))
      expect(secondPass.map((candle) => candle.timestamp)).toEqual([1_000 + index, 2_000 + index])
    }
  })

  test("the parsed-candle cache stays bounded at 256 entries, oldest evicted first", async () => {
    const symbols = symbolsFor("PCB", 257)
    for (const symbol of symbols) {
      strings.set(`market_data:conn-d:${symbol}:candles`, JSON.stringify([{ timestamp: 1, close: 1 }]))
    }

    const firstPass = new Map<string, any[]>()
    for (const symbol of symbols) firstPass.set(symbol, await getParsedCandlesCached(symbol, "conn-d"))
    for (const symbol of symbols.slice(1)) {
      expect(await getParsedCandlesCached(symbol, "conn-d")).toBe(firstPass.get(symbol))
    }

    const reparsed = await getParsedCandlesCached(symbols[0], "conn-d")
    expect(reparsed).not.toBe(firstPass.get(symbols[0]))
    expect(reparsed).toEqual(firstPass.get(symbols[0]))
  })
})
