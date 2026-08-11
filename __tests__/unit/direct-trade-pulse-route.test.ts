const fetchBingXPublicMock = jest.fn()

jest.mock("@/lib/bingx-public-api", () => ({
  fetchBingXPublic: (...args: unknown[]) => fetchBingXPublicMock(...args),
}))

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

function minuteHistory() {
  const end = Date.now()
  return Array.from({ length: 510 }, (_, index) => {
    const close = 100 + index * 0.04
    return {
      time: end - (509 - index) * 60_000,
      open: close - 0.02,
      high: close + 0.04,
      low: close - 0.04,
      close,
      volume: 100 + index,
    }
  })
}

describe("Direct-Trade entry pulse", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    resetInlineRedisGlobals()
    fetchBingXPublicMock.mockResolvedValue({ ok: true, json: async () => ({ data: minuteHistory() }) })
  })

  afterEach(() => resetInlineRedisGlobals())

  test("refreshes compact current 5m/15m/30m signal lines without loading the historic config grid", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/pulse/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.set("direct_trade:state", JSON.stringify({
      timeframes: ["5m", "15m", "30m"],
      entryTactics: ["momentum"],
      entryTiming: "current",
      activityVolumeRatio: 0,
    }))
    await redis.set("direct_trade:calculation", JSON.stringify({ symbols: ["BTCUSDT"] }))

    const response = await GET()
    const payload = await response.json()

    expect(payload.success).toBe(true)
    // 7 non-empty timeframe combinations × 2 directions × 1 tactic × seven
    // default-enabled lineages, including the independent DCA signal lane.
    expect(payload.signalsEvaluated).toBe(98)
    expect(Array.isArray(payload.activeSignalKeys)).toBe(true)
    expect(fetchBingXPublicMock).toHaveBeenCalledTimes(1)
  })
})
