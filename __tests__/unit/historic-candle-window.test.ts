const chunks = [
  [{ timestamp: 1000, close: 1 }, { timestamp: 2000, close: 2 }],
  [{ timestamp: 3000, close: 3 }, { timestamp: 4000, close: 4 }],
  [{ timestamp: 5000, close: 5 }, { timestamp: 6000, close: 6 }],
]

const redis = {
  get: jest.fn(async (key: string) => key.endsWith(":history:meta")
    ? JSON.stringify({ ranges: [
      { start: 1000, end: 2000, count: 2 },
      { start: 3000, end: 4000, count: 2 },
      { start: 5000, end: 6000, count: 2 },
    ] })
    : null),
  lrange: jest.fn(async (_key: string, start: number, end: number) =>
    chunks.slice(start, end + 1).map((chunk) => JSON.stringify(chunk))),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => redis),
  getMarketData: jest.fn(async () => null),
}))

import {
  getHistoricCandlesForRange,
  getHistoricCandleTail,
  getHistoricCandleWindow,
} from "@/lib/trade-engine/market-data-cache"

describe("historic chunk window", () => {
  beforeEach(() => {
    redis.get.mockClear()
    redis.lrange.mockClear()
  })

  test("loads only the bounded replay window with warmup and lookahead", async () => {
    const result = await getHistoricCandleWindow("BTCUSDT", {
      afterMs: 3000,
      beforeMs: 6000,
      limit: 2,
      warmup: 2,
      lookahead: 1,
    })

    expect(result.warmup.map((c) => c.timestamp)).toEqual([2000, 3000])
    expect(result.pending.map((c) => c.timestamp)).toEqual([4000, 5000])
    expect(result.lookahead.map((c) => c.timestamp)).toEqual([6000])
    expect(redis.lrange).toHaveBeenCalledTimes(1)
  })

  test("selects the newest state without parsing the complete replay backlog", async () => {
    const result = await getHistoricCandleWindow("BTCUSDT", {
      afterMs: 1000,
      beforeMs: 7000,
      limit: 1,
      warmup: 2,
      lookahead: 0,
      pendingOrder: "latest",
    })

    expect(result.warmup.map((c) => c.timestamp)).toEqual([4000, 5000])
    expect(result.pending.map((c) => c.timestamp)).toEqual([6000])
    expect(redis.lrange).toHaveBeenCalledWith("market_data:BTCUSDT:history:chunks", 1, 2)
    expect(redis.lrange).toHaveBeenCalledTimes(1)
  })

  test("returns no latest candidates when the requested limit is zero", async () => {
    const result = await getHistoricCandleWindow("BTCUSDT", {
      afterMs: 1000,
      beforeMs: 7000,
      limit: 0,
      pendingOrder: "latest",
    })

    expect(result.pending).toEqual([])
  })

  test("loads only intersecting calculation chunks in bounded batches", async () => {
    const result = await getHistoricCandlesForRange("BTCUSDT", {
      startMs: 2500,
      endMs: 5200,
      batchChunks: 1,
    })

    expect(result.map((c) => c.timestamp)).toEqual([3000, 4000, 5000])
    expect(redis.lrange).toHaveBeenNthCalledWith(1, "market_data:BTCUSDT:history:chunks", 1, 1)
    expect(redis.lrange).toHaveBeenNthCalledWith(2, "market_data:BTCUSDT:history:chunks", 2, 2)
    expect(redis.lrange).toHaveBeenCalledTimes(2)
  })

  test("loads a bounded warmup tail from canonical chunks", async () => {
    const result = await getHistoricCandleTail("BTCUSDT", 3)

    expect(result.map((c) => c.timestamp)).toEqual([4000, 5000, 6000])
    expect(redis.lrange).toHaveBeenCalledWith("market_data:BTCUSDT:history:chunks", 1, 2)
  })

  test("keeps historic reads in the connection-owned namespace", async () => {
    const result = await getHistoricCandleWindow("EURUSD", {
      afterMs: 3000,
      beforeMs: 6000,
      limit: 1,
      warmup: 1,
      connectionId: "instaforex-demo",
    })

    expect(result.pending.map((c) => c.timestamp)).toEqual([4000])
    expect(redis.get).toHaveBeenCalledWith("market_data:instaforex-demo:EURUSD:history:meta")
    expect(redis.lrange).toHaveBeenCalledWith("market_data:instaforex-demo:EURUSD:history:chunks", 0, 2)
  })
})
