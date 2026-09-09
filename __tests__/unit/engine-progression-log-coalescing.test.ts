const mockClient = {
  lpush: jest.fn(async () => 1),
  ltrim: jest.fn(async () => "OK"),
  expire: jest.fn(async () => 1),
  lrange: jest.fn(async () => []),
  del: jest.fn(async () => 1),
}

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: jest.fn(() => mockClient),
}))

import {
  __progressionLogTestUtils,
  logProgressionEvent,
  flushAllLogBuffers,
  forceFlushLogs,
  getProgressionLogs,
} from "@/lib/engine-progression-logs"

describe("engine progression log coalescing", () => {
  const originalNow = Date.now

  beforeEach(() => {
    __progressionLogTestUtils.reset()
    jest.clearAllMocks()
  })

  afterEach(() => {
    Date.now = originalNow
    __progressionLogTestUtils.reset()
  })

  test("retains one compact heartbeat instead of every healthy symbol cycle", async () => {
    let now = 1_000
    Date.now = () => now

    for (let index = 0; index < 100; index++) {
      await logProgressionEvent(
        "connection-one",
        "indications",
        "info",
        "Indication cycle complete",
        { symbol: "BTCUSDT", count: index },
      )
    }
    expect(__progressionLogTestUtils.buffered("connection-one")).toHaveLength(1)

    now += 15_000
    await logProgressionEvent(
      "connection-one",
      "indications",
      "info",
      "Indication cycle complete",
      { symbol: "BTCUSDT", count: 100 },
    )

    const buffered = __progressionLogTestUtils.buffered("connection-one")
    expect(buffered).toHaveLength(2)
    const details = JSON.parse(buffered[1].split("|").slice(4).join("|"))
    expect(details).toEqual(expect.objectContaining({
      symbol: "BTCUSDT",
      count: 100,
      suppressedEvents: 99,
      coalescedWindowMs: 15_000,
    }))
  })

  test("keeps coalescing metadata hard bounded across many symbols", async () => {
    for (let index = 0; index < 2_000; index++) {
      await logProgressionEvent(
        `connection-${index}`,
        "realtime",
        "debug",
        "Realtime cycle",
        { symbol: `SYMBOL${index}` },
      )
    }
    expect(__progressionLogTestUtils.coalescedSize()).toBeLessThanOrEqual(1024)
  })

  test("a slow Redis acknowledgement cannot replay or overlap a log batch", async () => {
    jest.useFakeTimers()
    let release!: () => void
    const acknowledgement = new Promise<void>(resolve => { release = resolve })
    mockClient.lpush.mockImplementationOnce(async () => { await acknowledgement; return 1 })
    try {
      for (let index = 0; index < 1000; index++) await logProgressionEvent("slow", "live_trading", "info", `entry ${index}`)
      expect(mockClient.lpush).toHaveBeenCalledTimes(1)
      expect(__progressionLogTestUtils.buffered("slow").length).toBeLessThanOrEqual(250)
      const timedRead = forceFlushLogs("slow")
      await jest.advanceTimersByTimeAsync(500)
      await timedRead
      expect(mockClient.lpush).toHaveBeenCalledTimes(1)
      const drain = flushAllLogBuffers()
      expect(flushAllLogBuffers()).toBe(drain)
      release()
      await drain
      await forceFlushLogs("slow")
      expect(mockClient.lpush).toHaveBeenCalledTimes(2)
      const batches = mockClient.lpush.mock.calls as unknown as string[][]
      const entries = batches.flatMap(call => call.slice(1))
      expect(new Set(entries).size).toBe(entries.length)
    } finally { release(); jest.useRealTimers() }
  })

  test("log readers clamp limits, accept both legacy encodings, and flush only their connection", async () => {
    await logProgressionEvent("unrelated", "custom", "info", "must remain buffered")
    mockClient.lrange.mockResolvedValueOnce([
      '2026-09-09T00:00:00Z|info|real|ready|{"count":0}',
      JSON.stringify({ timestamp: "2026-09-09T00:00:01Z", level: "warn", category: "system", message: "legacy JSON", data: { errorCount: 1 } }),
    ] as never)
    const rows = await getProgressionLogs("target", { limit: -1 })
    expect(mockClient.lrange).toHaveBeenLastCalledWith("engine_logs:target", 0, 0)
    expect(mockClient.lpush).not.toHaveBeenCalled()
    expect(rows[0].details).toEqual({ count: 0 })
    expect(rows[1]).toMatchObject({ phase: "system", message: "legacy JSON", details: { errorCount: 1 } })
    expect(__progressionLogTestUtils.buffered("unrelated")).toHaveLength(1)
  })
})
