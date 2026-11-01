/**
 * getHistoricCandleTail is called on every realtime pass for every symbol
 * whose hot `:candles` tail is shorter than the stage warmup. It now reuses
 * the parsed tail while the raw `history:meta` string is unchanged. These
 * tests pin that the cached result is identical to the previous uncached
 * read, that an unchanged index never re-reads chunks, that every rewrite of
 * the index (the only way chunk content changes) misses, and that the real
 * caller only reads the shared array.
 */
const strings = new Map<string, string>()
const lists = new Map<string, string[]>()

const redis = {
  get: jest.fn(async (key: string) => strings.get(key) ?? null),
  lrange: jest.fn(async (key: string, start: number, end: number) =>
    (lists.get(key) ?? []).slice(start, end + 1)),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => redis),
  getMarketData: jest.fn(async () => null),
  saveIndication: jest.fn(),
  storeIndications: jest.fn(),
  getSettings: jest.fn(async () => null),
  getAppSettings: jest.fn(async () => ({})),
}))

import { getHistoricCandleTail } from "@/lib/trade-engine/market-data-cache"

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

const scope = (symbol: string, connectionId?: string) =>
  connectionId ? `market_data:${connectionId}:${symbol}` : `market_data:${symbol}`

const candle = (timestamp: number, close: number): Candle =>
  ({ timestamp, open: close, high: close + 1, low: close - 1, close, volume: 10 })

const series = (count: number, startMs = 1_700_000_000_000, closeOffset = 0): Candle[] =>
  Array.from({ length: count }, (_, index) => candle(startMs + index * 1_000, 100 + index + closeOffset))

let writeSequence = 0

/** Mirrors market-data-loader writeHistoricCandleChunks (meta republished with a new updatedAt). */
function writeHistory(
  symbol: string,
  connectionId: string | undefined,
  candles: Candle[],
  options: { chunkSize?: number; rawChunks?: string[] } = {},
): void {
  const chunkSize = options.chunkSize ?? 2_000
  const chunks: string[] = []
  const ranges: Array<{ start: number; end: number; count: number }> = []
  for (let offset = 0; offset < candles.length; offset += chunkSize) {
    const chunk = candles.slice(offset, offset + chunkSize)
    ranges.push({ start: chunk[0].timestamp, end: chunk[chunk.length - 1].timestamp, count: chunk.length })
    chunks.push(JSON.stringify(chunk))
  }
  lists.set(`${scope(symbol, connectionId)}:history:chunks`, options.rawChunks ?? chunks)
  strings.set(`${scope(symbol, connectionId)}:history:meta`, JSON.stringify({
    version: 2,
    chunkSize,
    candleCount: candles.length,
    ranges,
    updatedAt: new Date(1_800_000_000_000 + ++writeSequence).toISOString(),
  }))
}

/** The pre-cache getHistoricCandleTail, verbatim, reading the same store without touching the spies. */
function uncachedTail(symbol: string, limit: number, connectionId?: string): any[] {
  const requested = Math.max(0, Math.floor(Number(limit) || 0))
  if (requested === 0) return []
  const meta = JSON.parse(strings.get(`${scope(symbol, connectionId)}:history:meta`) ?? "null")
  const ranges = (meta?.ranges ?? []) as Array<{ count: number }>
  let first = ranges.length - 1
  let remaining = requested
  while (first > 0 && remaining > 0) {
    remaining -= Math.max(1, Number(ranges[first].count) || 0)
    if (remaining > 0) first--
  }
  const rawChunks = (lists.get(`${scope(symbol, connectionId)}:history:chunks`) ?? []).slice(first, ranges.length)
  const ts = (c: any) => Number(c?.timestamp ?? c?.time ?? c?.openTime ?? 0)
  const byTimestamp = new Map<number, any>()
  for (const raw of rawChunks) {
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) continue
      for (const c of parsed) if (Number.isFinite(ts(c)) && ts(c) > 0) byTimestamp.set(ts(c), c)
    } catch { /* corrupt chunk */ }
  }
  return [...byTimestamp.values()].sort((a, b) => ts(a) - ts(b)).slice(-requested)
}

describe("getHistoricCandleTail cache", () => {
  beforeEach(() => {
    strings.clear()
    lists.clear()
    redis.get.mockClear()
    redis.lrange.mockClear()
  })

  test("a miss and every following hit equal the uncached read", async () => {
    // Overlapping chunk borders (later chunk wins), a corrupt chunk, and
    // limits that cut inside, align with, and exceed the stored chunks.
    const candles = series(6_500)
    const chunks = [
      JSON.stringify(candles.slice(0, 2_000)),
      "{corrupt",
      JSON.stringify([...candles.slice(1_990, 2_000).map((c) => ({ ...c, close: -1 })), ...candles.slice(2_000, 4_000)]),
      JSON.stringify(candles.slice(4_000, 6_000)),
      JSON.stringify(candles.slice(6_000)),
    ]
    writeHistory("EQUSDT", "conn-eq", candles)
    const meta = JSON.parse(strings.get("market_data:conn-eq:EQUSDT:history:meta")!)
    meta.ranges.splice(1, 0, { start: candles[2_000].timestamp, end: candles[2_000].timestamp, count: 1 })
    strings.set("market_data:conn-eq:EQUSDT:history:meta", JSON.stringify(meta))
    lists.set("market_data:conn-eq:EQUSDT:history:chunks", chunks)

    for (const limit of [1, 3, 499, 500, 501, 2_000, 2_001, 4_500, 5_400, 6_499, 6_500, 10_000]) {
      const expected = uncachedTail("EQUSDT", limit, "conn-eq")
      const miss = await getHistoricCandleTail("EQUSDT", limit, "conn-eq")
      const hit = await getHistoricCandleTail("EQUSDT", limit, "conn-eq")
      expect(miss).toEqual(expected)
      expect(hit).toBe(miss)
      expect(hit).toEqual(expected)
    }
    // The overlap rows from the later chunk replace the earlier copies.
    const full = await getHistoricCandleTail("EQUSDT", 10_000, "conn-eq")
    expect(full.find((c) => c.timestamp === candles[1_995].timestamp)?.close).toBe(-1)
  })

  test("an unchanged index serves the parsed tail without re-reading chunks", async () => {
    writeHistory("HITUSDT", "conn-hit", series(6_000))

    const first = await getHistoricCandleTail("HITUSDT", 5_400, "conn-hit")
    expect(redis.lrange).toHaveBeenCalledTimes(1)
    for (let pass = 0; pass < 5; pass++) {
      expect(await getHistoricCandleTail("HITUSDT", 5_400, "conn-hit")).toBe(first)
    }
    // One meta GET per call (the validation read), one LRANGE in total.
    expect(redis.get).toHaveBeenCalledTimes(6)
    expect(redis.lrange).toHaveBeenCalledTimes(1)
    expect(first).toHaveLength(5_400)
  })

  test("appending a new chunk invalidates the entry", async () => {
    const candles = series(6_000)
    writeHistory("APPUSDT", "conn-app", candles)
    const before = await getHistoricCandleTail("APPUSDT", 5_400, "conn-app")

    const extended = [...candles, ...series(1_500, candles[candles.length - 1].timestamp + 1_000, 50_000)]
    writeHistory("APPUSDT", "conn-app", extended)
    const after = await getHistoricCandleTail("APPUSDT", 5_400, "conn-app")

    expect(redis.lrange).toHaveBeenCalledTimes(2)
    expect(after).not.toBe(before)
    expect(after).toEqual(uncachedTail("APPUSDT", 5_400, "conn-app"))
    expect(after[after.length - 1].timestamp).toBe(extended[extended.length - 1].timestamp)
  })

  test("a changed last range invalidates the entry", async () => {
    const metaKey = "market_data:conn-last:LASTUSDT:history:meta"
    writeHistory("LASTUSDT", "conn-last", series(5_000))
    const rangesBefore = JSON.parse(strings.get(metaKey)!).ranges
    const before = await getHistoricCandleTail("LASTUSDT", 4_000, "conn-last")

    // Same chunk count; only the newest chunk grows (its end/count change).
    const grown = series(5_600)
    writeHistory("LASTUSDT", "conn-last", grown)
    const rangesAfter = JSON.parse(strings.get(metaKey)!).ranges
    expect(rangesAfter).toHaveLength(rangesBefore.length)
    expect(rangesAfter.slice(0, -1)).toEqual(rangesBefore.slice(0, -1))
    expect(rangesAfter.at(-1)).not.toEqual(rangesBefore.at(-1))

    const after = await getHistoricCandleTail("LASTUSDT", 4_000, "conn-last")
    expect(redis.lrange).toHaveBeenCalledTimes(2)
    expect(after).not.toBe(before)
    expect(after).toEqual(uncachedTail("LASTUSDT", 4_000, "conn-last"))
    expect(after[after.length - 1].timestamp).toBe(grown[grown.length - 1].timestamp)
  })

  test("a rewrite with identical ranges but new content invalidates the entry", async () => {
    const candles = series(6_000)
    writeHistory("REWUSDT", "conn-rew", candles)
    await getHistoricCandleTail("REWUSDT", 5_400, "conn-rew")

    // Same timestamps (so the same ranges), different prices: only the
    // republished meta (new updatedAt) identifies the change.
    writeHistory("REWUSDT", "conn-rew", series(6_000, candles[0].timestamp, 7_000))
    const after = await getHistoricCandleTail("REWUSDT", 5_400, "conn-rew")

    expect(redis.lrange).toHaveBeenCalledTimes(2)
    expect(after).toEqual(uncachedTail("REWUSDT", 5_400, "conn-rew"))
    expect(after[0].close).toBe(candles[600].close + 7_000)
  })

  test("entries are isolated per connection scope and limit", async () => {
    writeHistory("ISOUSDT", "conn-x", series(6_000, 1_700_000_000_000, 0))
    writeHistory("ISOUSDT", "conn-y", series(6_000, 1_700_000_000_000, 1_000))
    writeHistory("ISOUSDT", undefined, series(6_000, 1_700_000_000_000, 2_000))

    for (const connectionId of ["conn-x", "conn-y", undefined]) {
      for (const limit of [5_400, 300]) {
        expect(await getHistoricCandleTail("ISOUSDT", limit, connectionId))
          .toEqual(uncachedTail("ISOUSDT", limit, connectionId))
      }
    }
    expect(redis.lrange).toHaveBeenCalledTimes(6)
    expect((await getHistoricCandleTail("ISOUSDT", 300, "conn-y"))[0].close).toBe(100 + 5_700 + 1_000)
    expect(redis.lrange).toHaveBeenCalledTimes(6)
  })

  test("a missing index falls back to the legacy path and drops the entry", async () => {
    writeHistory("GONEUSDT", "conn-gone", series(6_000))
    const metaKey = "market_data:conn-gone:GONEUSDT:history:meta"
    const meta = strings.get(metaKey)!
    await getHistoricCandleTail("GONEUSDT", 5_400, "conn-gone")

    strings.delete(metaKey)
    expect(await getHistoricCandleTail("GONEUSDT", 5_400, "conn-gone")).toEqual([])
    expect(redis.lrange).toHaveBeenCalledTimes(1)

    // The same meta string reappearing (e.g. a restore) is re-read, never
    // answered from an entry that outlived the index it was built from.
    strings.set(metaKey, meta)
    expect(await getHistoricCandleTail("GONEUSDT", 5_400, "conn-gone"))
      .toEqual(uncachedTail("GONEUSDT", 5_400, "conn-gone"))
    expect(redis.lrange).toHaveBeenCalledTimes(2)
  })

  test("the cache stays bounded at 256 entries, least recently used first", async () => {
    const symbols = Array.from({ length: 257 }, (_, index) => `L${String(index).padStart(3, "0")}USDT`)
    for (const symbol of symbols) writeHistory(symbol, "conn-lru", series(3, 1_700_000_000_000))

    for (const symbol of symbols.slice(0, 256)) await getHistoricCandleTail(symbol, 2, "conn-lru")
    // Touch the oldest entry so the second-oldest becomes least recent.
    await getHistoricCandleTail(symbols[0], 2, "conn-lru")
    expect(redis.lrange).toHaveBeenCalledTimes(256)

    await getHistoricCandleTail(symbols[256], 2, "conn-lru")
    expect(redis.lrange).toHaveBeenCalledTimes(257)
    await getHistoricCandleTail(symbols[0], 2, "conn-lru")
    expect(redis.lrange).toHaveBeenCalledTimes(257)
    await getHistoricCandleTail(symbols[1], 2, "conn-lru")
    expect(redis.lrange).toHaveBeenCalledTimes(258)
  })
})

describe("indication processor stage-history merge over the cached tail", () => {
  beforeEach(() => {
    strings.clear()
    lists.clear()
    redis.get.mockClear()
    redis.lrange.mockClear()
  })

  let logSpy: jest.SpyInstance

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => logSpy.mockRestore())

  test("merges without mutating the shared tail and reuses it on the next pass", async () => {
    const { IndicationProcessor } = await import("@/lib/trade-engine/indication-processor-fixed")
    const { ENGINE_STAGE_HISTORY_CANDLES } = await import("@/lib/engine-stage-history")

    const history = series(6_000)
    writeHistory("MRGUSDT", "conn-mrg", history)
    // A 300-row realtime tail overlapping the newest 200 persisted candles
    // with refreshed closes, plus 100 newer candles.
    const realtime = series(300, history[5_800].timestamp, 0.5)
    strings.set("market_data:conn-mrg:MRGUSDT:candles", JSON.stringify(realtime))

    const tail = await getHistoricCandleTail("MRGUSDT", ENGINE_STAGE_HISTORY_CANDLES, "conn-mrg")
    const snapshot = JSON.stringify(tail)
    // Strict-mode writes to frozen objects throw, which getHistoricalCandles
    // would turn into an empty result.
    for (const row of tail) Object.freeze(row)
    Object.freeze(tail)

    const expected = [...new Map(
      [...uncachedTail("MRGUSDT", ENGINE_STAGE_HISTORY_CANDLES, "conn-mrg"), ...realtime]
        .map((row) => [row.timestamp, row] as const),
    ).values()].sort((a, b) => a.timestamp - b.timestamp)

    for (let pass = 0; pass < 2; pass++) {
      // A new processor has an empty 200 ms parsed-candle cache, so each pass
      // reaches getHistoricCandleTail exactly like the next realtime pass.
      const merged = await (new IndicationProcessor("conn-mrg") as any).getHistoricalCandles("MRGUSDT")
      expect(merged).toEqual(expected)
      expect(merged).not.toBe(tail)
      expect(merged).toHaveLength(ENGINE_STAGE_HISTORY_CANDLES + 100)
      expect(merged[merged.length - 101].close).toBe(realtime[199].close)
    }

    expect(redis.lrange).toHaveBeenCalledTimes(1)
    expect(await getHistoricCandleTail("MRGUSDT", ENGINE_STAGE_HISTORY_CANDLES, "conn-mrg")).toBe(tail)
    expect(JSON.stringify(tail)).toBe(snapshot)
  })
})
