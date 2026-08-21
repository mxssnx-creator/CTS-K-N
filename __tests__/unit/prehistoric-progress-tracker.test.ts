jest.mock("@/lib/redis-db", () => ({
  getRedisClient: jest.fn(),
}))

jest.mock("@/lib/engine-event-bus", () => ({
  publishEngineEvent: jest.fn().mockResolvedValue(undefined),
}))

import { publishEngineEvent } from "@/lib/engine-event-bus"
import { getPrehistoricProgressTracker, PrehistoricProgressTracker } from "@/lib/prehistoric-progress-tracker"
import { getRedisClient } from "@/lib/redis-db"
import { buildPrehistoricGateKeys } from "@/lib/progression-scope"

function createMemoryRedis() {
  const hashes = new Map<string, Record<string, string>>()
  const sets = new Map<string, Set<string>>()
  const strings = new Map<string, string>()
  const setFor = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Set())
    return sets.get(key)!
  }

  return {
    del: jest.fn(async (...keys: string[]) => {
      let deleted = 0
      for (const key of keys) {
        deleted += Number(hashes.delete(key)) + Number(sets.delete(key)) + Number(strings.delete(key))
      }
      return deleted
    }),
    expire: jest.fn(async () => 1),
    sadd: jest.fn(async (key: string, ...members: string[]) => {
      const target = setFor(key)
      let added = 0
      for (const member of members) {
        if (!target.has(member)) {
          target.add(member)
          added++
        }
      }
      return added
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      const target = setFor(key)
      let removed = 0
      for (const member of members) removed += Number(target.delete(member))
      return removed
    }),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) || new Set<string>())]),
    scard: jest.fn(async (key: string) => (sets.get(key) || new Set<string>()).size),
    hset: jest.fn(async (key: string, values: Record<string, unknown>) => {
      const hash = hashes.get(key) || {}
      for (const [field, value] of Object.entries(values)) hash[field] = String(value)
      hashes.set(key, hash)
      return Object.keys(values).length
    }),
    hgetall: jest.fn(async (key: string) => ({ ...(hashes.get(key) || {}) })),
    hdel: jest.fn(async (key: string, ...fields: string[]) => {
      const hash = hashes.get(key) || {}
      let removed = 0
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(hash, field)) {
          delete hash[field]
          removed++
        }
      }
      hashes.set(key, hash)
      return removed
    }),
    hincrby: jest.fn(async (key: string, field: string, amount: number) => {
      const hash = hashes.get(key) || {}
      const next = Number(hash[field] || 0) + Number(amount)
      hash[field] = String(next)
      hashes.set(key, hash)
      return next
    }),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, String(value))
      return "OK"
    }),
    getString: (key: string) => strings.get(key),
  }
}

describe("PrehistoricProgressTracker durable progress", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("deduplicates parallel/retried completion and opens realtime only after every symbol succeeds", async () => {
    const redis = createMemoryRedis()
    ;(getRedisClient as jest.Mock).mockReturnValue(redis)
    const connectionId = `historic-tracker-${Date.now()}`
    const tracker = new PrehistoricProgressTracker(connectionId)
    const gates = buildPrehistoricGateKeys(connectionId, "main", "done")

    await tracker.initialize(["btcusdt", "ETHUSDT"])
    await tracker.completeSymbol("BTCUSDT", 100)
    await tracker.completeSymbol("btcusdt", 900)

    let progress = await tracker.getProgress()
    expect(progress).toMatchObject({
      totalSymbols: 2,
      processedSymbols: 1,
      completedSymbols: ["BTCUSDT"],
      remainingSymbols: ["ETHUSDT"],
      totalCandles: 100,
      isComplete: false,
    })
    expect(await tracker.markComplete()).toBe(false)
    expect(redis.getString(gates.scoped)).toBeUndefined()

    await tracker.errorSymbol("ETHUSDT", "temporary exchange timeout")
    progress = await tracker.getProgress()
    expect(progress.processedSymbols).toBe(2)
    expect(progress.errorSymbols).toEqual([
      { symbol: "ETHUSDT", error: "temporary exchange timeout" },
    ])
    expect(await tracker.markComplete()).toBe(false)

    // A retry repairs only ETHUSDT; the completed BTC candle total remains
    // exactly once and no timer/reinitialization is needed.
    await tracker.startSymbol("ETHUSDT")
    await tracker.completeSymbol("ETHUSDT", 200)
    expect(await tracker.markComplete()).toBe(true)

    progress = await tracker.getProgress()
    expect(progress).toMatchObject({
      processedSymbols: 2,
      totalCandles: 300,
      errorSymbols: [],
      isComplete: true,
    })
    expect(redis.getString(gates.scoped)).toBe("1")
    expect(publishEngineEvent).toHaveBeenLastCalledWith(
      "progression.stage.completed",
      expect.objectContaining({
        connectionId,
        stage: "prehistoric_data",
        successful: true,
      }),
    )
  })

  it("returns the same singleton for a connection without sharing another connection's state", () => {
    const first = getPrehistoricProgressTracker("tracker-singleton-a")
    expect(getPrehistoricProgressTracker("tracker-singleton-a")).toBe(first)
    expect(getPrehistoricProgressTracker("tracker-singleton-b")).not.toBe(first)
  })
})
