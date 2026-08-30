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
})
