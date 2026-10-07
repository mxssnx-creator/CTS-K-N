/**
 * A prehistoric range longer than the stored stage history (about 120 minutes
 * of seconds) is completed from the venue's real one-minute bars, resolved to
 * seconds. Never in a paper/preview process, never into a synthetic series,
 * never for forex.
 */
const strings = new Map<string, string>()
const connections = new Map<string, Record<string, unknown>>()
const getOHLCV = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getClient: () => ({ get: async (key: string) => strings.get(key) ?? null }),
  getRedisClient: () => ({ get: async (key: string) => strings.get(key) ?? null }),
  getConnection: async (id: string) => connections.get(id) ?? null,
}))
jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: { getOrCreateConnector: async () => ({ getOHLCV }) },
}))

import { loadRangeMinuteBars, loadRangeSecondsFromMinuteBars } from "@/lib/market-data-loader"
import { marketDataKey } from "@/lib/market-data-keys"

const MINUTE = 60_000
const now = Date.UTC(2026, 9, 6, 22, 0, 0)
const bar = (timestamp: number, open: number, close: number) => ({ timestamp, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 60 })

describe("prehistoric range backfill", () => {
  const savedForce = process.env.FORCE_SIMULATED
  beforeEach(() => {
    strings.clear()
    connections.clear()
    getOHLCV.mockReset()
    delete process.env.FORCE_SIMULATED
    connections.set("bingx-x02", { id: "bingx-x02", exchange: "bingx", market_type: "perpetual_futures" })
  })
  afterAll(() => {
    if (savedForce === undefined) delete process.env.FORCE_SIMULATED
    else process.env.FORCE_SIMULATED = savedForce
  })

  test("resolves the venue's real minute bars to seconds over the missing range only", async () => {
    const start = now - 24 * 60 * MINUTE
    getOHLCV.mockResolvedValue([bar(start, 100, 106), bar(start + MINUTE, 106, 100), bar(start + 2 * MINUTE, 100, 103)])
    const seconds = await loadRangeSecondsFromMinuteBars("BTCUSDT", { connectionId: "bingx-x02", startMs: start, endMs: start + 2 * MINUTE, nowMs: now })

    expect(getOHLCV).toHaveBeenCalledWith("BTCUSDT", "1m", 24 * 60 + 2)
    expect(seconds).toHaveLength(120)
    expect(seconds[0]).toMatchObject({ timestamp: start, open: 100 })
    expect(seconds[59].close).toBeCloseTo(106, 10)
    expect(seconds[119].timestamp).toBe(start + 2 * MINUTE - 1_000)
    expect(seconds.every((candle) => candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close))).toBe(true)
  })

  test("the measurement reads the venue's bars themselves: real wicks, aligned minutes, the range only", async () => {
    const start = now - 3 * MINUTE
    getOHLCV.mockResolvedValue([
      bar(start - MINUTE, 99, 100),                         // before the range
      { ...bar(start, 100, 106), timestamp: start + 1_234 }, // unaligned venue timestamp
      bar(start + MINUTE, 106, 100),
      bar(start + MINUTE, 106, 101),                        // a repeated minute keeps its last bar
      { ...bar(start + 2 * MINUTE, 100, 103), high: Number.NaN },
      bar(now, 103, 104),                                   // at the range end (exclusive)
    ])
    const bars = await loadRangeMinuteBars("BTCUSDT", { connectionId: "bingx-x02", startMs: start, endMs: now, nowMs: now })
    expect(bars.map((entry) => entry.timestamp)).toEqual([start, start + MINUTE])
    expect(bars[0]).toMatchObject({ open: 100, high: 107, low: 99, close: 106 })
    expect(bars[1].close).toBe(101)
  })

  test("a paper/preview process stays offline", async () => {
    process.env.FORCE_SIMULATED = "1"
    expect(await loadRangeSecondsFromMinuteBars("BTCUSDT", { connectionId: "bingx-x02", startMs: now - 3_600_000, endMs: now, nowMs: now })).toEqual([])
    expect(getOHLCV).not.toHaveBeenCalled()
  })

  test("a synthetic stored series is never extended with real bars", async () => {
    strings.set(marketDataKey("BTCUSDT", "1s", "bingx-x02"), JSON.stringify({ source: "synthetic", candles: [] }))
    expect(await loadRangeSecondsFromMinuteBars("BTCUSDT", { connectionId: "bingx-x02", startMs: now - 3_600_000, endMs: now, nowMs: now })).toEqual([])
    expect(getOHLCV).not.toHaveBeenCalled()
  })

  test("forex keeps its M1 history and an unknown connection is refused", async () => {
    connections.set("fx", { id: "fx", exchange: "instaforex", market_type: "forex" })
    expect(await loadRangeSecondsFromMinuteBars("EURUSD", { connectionId: "fx", startMs: now - 3_600_000, endMs: now, nowMs: now })).toEqual([])
    expect(await loadRangeSecondsFromMinuteBars("BTCUSDT", { connectionId: "missing", startMs: now - 3_600_000, endMs: now, nowMs: now })).toEqual([])
    expect(getOHLCV).not.toHaveBeenCalled()
  })

  test("a failed venue read leaves the range as it was", async () => {
    getOHLCV.mockRejectedValue(new Error("venue down"))
    expect(await loadRangeSecondsFromMinuteBars("BTCUSDT", { connectionId: "bingx-x02", startMs: now - 3_600_000, endMs: now, nowMs: now })).toEqual([])
  })
})
