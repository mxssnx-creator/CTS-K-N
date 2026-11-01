/**
 * The Common one-minute history: completed minutes only, an anchored window,
 * causal and bounded; the venue is read once per symbol (backfill, at most
 * every 10 minutes) and the live 1s feed extends it.
 */
import {
  COMMON_WINDOW_ANCHOR_MINUTES,
  commonHistoryForCycle,
  commonHistoryMinutes,
  commonWarmupMinutes,
  commonWindowStartMs,
  completedMinuteBars,
  resetCommonHistoryForTests,
} from "@/lib/common-indicators/history"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 9, 14, 12, 0, 30)
const FORMING = Math.floor(NOW / MINUTE) * MINUTE

/** one-second candles from `fromMinute` minutes before NOW's minute (mid-minute start) through NOW */
function seconds(fromMinute: number, nowMs = NOW, startOffsetSeconds = 17, price = 100) {
  const formingStart = Math.floor(nowMs / MINUTE) * MINUTE
  const out = []
  for (let t = formingStart - fromMinute * MINUTE + startOffsetSeconds * 1_000; t <= nowMs; t += 1_000) {
    const minute = Math.floor((t - formingStart) / MINUTE)
    const close = price + minute * 0.1 + ((t / 1_000) % 60) * 0.001
    out.push({ timestamp: t, open: close, high: close + 0.01, low: close - 0.01, close, volume: 1 })
  }
  return out
}

/** the venue's one-minute klines for [startMs, endMs) */
function minuteBars(startMs: number, endMs: number, close = 90.5) {
  const out = []
  for (let t = startMs; t < endMs; t += MINUTE) out.push({ timestamp: t, open: 90, high: 91, low: 89, close, volume: 60 })
  return out
}

const memoryRedis = () => {
  const data = new Map<string, string>()
  return {
    data,
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      data.set(key, value)
      return "OK"
    }),
  }
}

const venueLoader = () => jest.fn(async (_symbol: string, options: { startMs: number; endMs: number }) =>
  minuteBars(options.startMs, options.endMs))

describe("Common one-minute history", () => {
  beforeEach(() => resetCommonHistoryForTests())

  test("the window is anchored to the hour and covers H..H+59 minutes", () => {
    const H = commonHistoryMinutes()
    expect(commonWarmupMinutes()).toBe(H + COMMON_WINDOW_ANCHOR_MINUTES - 1)
    for (const offset of [0, 1, 37, 59, 60, 61, 119]) {
      const last = Date.UTC(2026, 9, 14, 9, 0) + offset * MINUTE
      const start = commonWindowStartMs(last)
      expect(start % HOUR).toBe(0)
      const length = (last - start) / MINUTE + 1
      expect(length).toBeGreaterThanOrEqual(H)
      expect(length).toBeLessThanOrEqual(H + 59)
    }
  })

  test("completedMinuteBars keeps whole minutes before the forming one, stamped with their open", () => {
    const bars = completedMinuteBars(seconds(3), FORMING)
    expect(bars.every((bar) => bar.timestamp % MINUTE === 0 && bar.timestamp < FORMING)).toBe(true)
    expect(bars).toHaveLength(3)
  })

  test("realtime: completed minutes only; the partial first live minute is dropped", async () => {
    const view = await commonHistoryForCycle({
      connectionId: "c0", symbol: "BTCUSDT", candles: seconds(90), mode: "realtime", loadMinuteBars: null, redis: null,
    })
    expect(view).not.toBeNull()
    expect(view!.bars.every((bar) => bar.timestamp < FORMING)).toBe(true)
    expect(view!.lastCompletedMs).toBe(FORMING - MINUTE)
    expect(view!.completedThroughMs).toBe(FORMING)
    // 90 minutes from second 17: the first minute is partial, the forming one excluded
    expect(view!.bars).toHaveLength(89)
    for (let index = 1; index < view!.bars.length; index++) {
      expect(view!.bars[index].timestamp - view!.bars[index - 1].timestamp).toBe(MINUTE)
    }
  })

  test("the same view (and key) within a minute; a new view when a minute completes", async () => {
    const options = { connectionId: "c1", symbol: "ETHUSDT", mode: "realtime" as const, loadMinuteBars: null, redis: null }
    const first = await commonHistoryForCycle({ ...options, candles: seconds(90) })
    const sameMinute = await commonHistoryForCycle({ ...options, candles: seconds(90, NOW + 20_000) })
    expect(sameMinute).toBe(first)
    const nextMinute = await commonHistoryForCycle({ ...options, candles: seconds(90, NOW + 45_000) })
    expect(nextMinute).not.toBe(first)
    expect(nextMinute!.key).not.toBe(first!.key)
    expect(nextMinute!.lastCompletedMs).toBe(FORMING)
  })

  test("a late tick that revises the newest completed minute changes the key", async () => {
    const options = { connectionId: "c2", symbol: "SOLUSDT", mode: "realtime" as const, loadMinuteBars: null, redis: null }
    const candles = seconds(90)
    const first = await commonHistoryForCycle({ ...options, candles })
    const revised = candles.map((candle) => candle.timestamp === FORMING - 1_000 ? { ...candle, close: candle.close + 1, high: candle.high + 1 } : candle)
    const second = await commonHistoryForCycle({ ...options, candles: revised })
    expect(second!.lastCompletedMs).toBe(first!.lastCompletedMs)
    expect(second!.contentHash).not.toBe(first!.contentHash)
    expect(second!.key).not.toBe(first!.key)
  })

  test("one venue backfill fills the anchored window; the live feed keeps its minutes", async () => {
    const loader = venueLoader()
    const view = await commonHistoryForCycle({
      connectionId: "c3", symbol: "XRPUSDT", candles: seconds(90), mode: "realtime",
      loadMinuteBars: loader, redis: null, awaitBackfill: true, nowMs: NOW,
    })
    expect(loader).toHaveBeenCalledTimes(1)
    const [, range] = loader.mock.calls[0]
    expect(range.startMs).toBe(commonWindowStartMs(FORMING - MINUTE))
    // venue bars up to the first live minute, live minutes after (stored minutes win)
    const again = await commonHistoryForCycle({
      connectionId: "c3", symbol: "XRPUSDT", candles: seconds(90), mode: "realtime",
      loadMinuteBars: loader, redis: null, nowMs: NOW,
    })
    expect(again!.bars[0].timestamp).toBe(commonWindowStartMs(FORMING - MINUTE))
    expect(again!.bars[0].close).toBe(90.5)
    // the newest minutes are the live feed's (about 99.9), not the venue's 90.5
    expect(again!.bars[again!.bars.length - 1].close).toBeGreaterThan(99)
    expect(again!.bars.find((bar) => bar.timestamp === FORMING - 89 * MINUTE)!.close).toBeGreaterThan(91)
    expect(again!.bars.length).toBe((FORMING - again!.windowStartMs) / MINUTE)
    for (let index = 1; index < again!.bars.length; index++) {
      expect(again!.bars[index].timestamp - again!.bars[index - 1].timestamp).toBe(MINUTE)
    }
    expect(view).toBe(again)
  })

  test("a short venue answer is retried at most every 10 minutes, not every cycle", async () => {
    const loader = jest.fn(async () => [])
    for (let cycle = 0; cycle < 5; cycle++) {
      const nowMs = NOW + cycle * MINUTE
      await commonHistoryForCycle({
        connectionId: "c4", symbol: "BCHUSDT", candles: seconds(90, nowMs), mode: "realtime",
        loadMinuteBars: loader, redis: null, awaitBackfill: true, nowMs,
      })
    }
    expect(loader).toHaveBeenCalledTimes(1)
    await commonHistoryForCycle({
      connectionId: "c4", symbol: "BCHUSDT", candles: seconds(90, NOW + 11 * MINUTE), mode: "realtime",
      loadMinuteBars: loader, redis: null, awaitBackfill: true, nowMs: NOW + 11 * MINUTE,
    })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  test("a restart restores the stored minutes and fills the gap to the live window", async () => {
    const redis = memoryRedis()
    const loader = venueLoader()
    await commonHistoryForCycle({
      connectionId: "c5", symbol: "ADAUSDT", candles: seconds(90), mode: "realtime",
      loadMinuteBars: loader, redis, awaitBackfill: true, nowMs: NOW,
    })
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledWith("market_data:c5:ADAUSDT:common_1m", expect.any(String), "EX", expect.any(Number))

    // the process restarts 3 hours later
    resetCommonHistoryForTests()
    const later = NOW + 3 * HOUR
    const restartLoader = venueLoader()
    const view = await commonHistoryForCycle({
      connectionId: "c5", symbol: "ADAUSDT", candles: seconds(90, later), mode: "realtime",
      loadMinuteBars: restartLoader, redis, awaitBackfill: true, nowMs: later,
    })
    // only the missing range (between the stored and the live minutes) was read
    expect(restartLoader).toHaveBeenCalledTimes(1)
    const [, range] = restartLoader.mock.calls[0]
    expect(range.startMs).toBe(FORMING)
    expect(range.endMs).toBeLessThanOrEqual(Math.floor(later / MINUTE) * MINUTE)
    const restored = await commonHistoryForCycle({
      connectionId: "c5", symbol: "ADAUSDT", candles: seconds(90, later), mode: "realtime",
      loadMinuteBars: restartLoader, redis, nowMs: later,
    })
    expect(restored).toBe(view)
    for (let index = 1; index < view!.bars.length; index++) {
      expect(view!.bars[index].timestamp - view!.bars[index - 1].timestamp).toBe(MINUTE)
    }
  })

  test("the store is persisted at most every 5 minutes", async () => {
    const redis = memoryRedis()
    for (let cycle = 0; cycle < 4; cycle++) {
      const nowMs = NOW + cycle * MINUTE
      await commonHistoryForCycle({
        connectionId: "c6", symbol: "DOTUSDT", candles: seconds(90, nowMs), mode: "realtime",
        loadMinuteBars: null, redis, nowMs,
      })
    }
    expect(redis.set).toHaveBeenCalledTimes(1)
    await commonHistoryForCycle({
      connectionId: "c6", symbol: "DOTUSDT", candles: seconds(90, NOW + 6 * MINUTE), mode: "realtime",
      loadMinuteBars: null, redis, nowMs: NOW + 6 * MINUTE,
    })
    expect(redis.set).toHaveBeenCalledTimes(2)
  })

  test("historical replay: the loaded series cut before the minute of asOf, anchored, no venue read", async () => {
    const loader = jest.fn(async () => [])
    const asOf = NOW - 10 * MINUTE + 25_000
    const replay = minuteBars(asOf - 3_000 * MINUTE, NOW)
    const view = await commonHistoryForCycle({
      connectionId: "c7", symbol: "XRPUSDT", candles: replay, asOfMs: asOf, mode: "historical",
      loadMinuteBars: loader,
    })
    expect(loader).not.toHaveBeenCalled()
    const asOfMinute = Math.floor(asOf / MINUTE) * MINUTE
    expect(view!.lastCompletedMs).toBe(asOfMinute - MINUTE)
    expect(view!.windowStartMs).toBe(commonWindowStartMs(asOfMinute - MINUTE))
    expect(view!.bars[0].timestamp).toBe(view!.windowStartMs)
  })

  test("forced simulation backfills synthetic minutes only when opted in", async () => {
    const saved = { sim: process.env.FORCE_SIMULATED, live: process.env.FORCE_LIVE, opt: process.env.COMMON_HISTORY_SIMULATED_BACKFILL }
    try {
      process.env.FORCE_SIMULATED = "1"
      delete process.env.FORCE_LIVE
      delete process.env.COMMON_HISTORY_SIMULATED_BACKFILL
      const plain = await commonHistoryForCycle({
        connectionId: "c8", symbol: "LINKUSDT", candles: seconds(90), mode: "realtime", redis: null, awaitBackfill: true, nowMs: NOW,
      })
      expect(plain!.bars).toHaveLength(89)

      resetCommonHistoryForTests()
      process.env.COMMON_HISTORY_SIMULATED_BACKFILL = "1"
      const filled = await commonHistoryForCycle({
        connectionId: "c8", symbol: "LINKUSDT", candles: seconds(90), mode: "realtime", redis: null, awaitBackfill: true, nowMs: NOW,
      })
      const again = await commonHistoryForCycle({
        connectionId: "c8", symbol: "LINKUSDT", candles: seconds(90), mode: "realtime", redis: null, nowMs: NOW,
      })
      expect(filled).toBe(again)
      expect(again!.bars[0].timestamp).toBe(again!.windowStartMs)
      expect(again!.bars.length).toBe((FORMING - again!.windowStartMs) / MINUTE)
      // the synthetic minutes join the first live price
      // the first whole live minute (the 1s feed starts 17 s into minute -90)
      const firstLive = again!.bars.findIndex((bar) => bar.timestamp === FORMING - 89 * MINUTE)
      expect(firstLive).toBeGreaterThan(0)
      expect(Math.abs(again!.bars[firstLive - 1].close / again!.bars[firstLive].open - 1)).toBeLessThan(1e-9)
    } finally {
      for (const [key, value] of [["FORCE_SIMULATED", saved.sim], ["FORCE_LIVE", saved.live], ["COMMON_HISTORY_SIMULATED_BACKFILL", saved.opt]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("the Common Set pass reads the cycle's Common history array itself (shared with Auto)", async () => {
    const processor = new IndicationSetsProcessor("c9") as any
    await processor.settingsReady
    const commonCandles = minuteBars(NOW - 100 * MINUTE, NOW)
    const marketData = { candles: seconds(5), commonCandles }
    expect(processor.getHistoryCandles(marketData)).toBe(commonCandles)
    expect(processor.getHistoryCandles({ candles: [] })).toEqual([])
  })
})
