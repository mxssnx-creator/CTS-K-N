import { StrategySetsProcessor } from "@/lib/strategy-sets-processor"
import { loadCompactionConfig } from "@/lib/sets-compaction"
import { setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

const mockRedisStore = new Map<string, unknown>()
const mockClientStore = new Map<string, string>()

const mockGet = jest.fn(async (key: string) => mockClientStore.get(key) ?? null)
const mockSet = jest.fn(async (key: string, value: string) => {
  mockClientStore.set(key, value)
  return "OK"
})

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    get: mockGet,
    set: mockSet,
  })),
  getSettings: jest.fn(async (key: string) => {
    if (key === "strategy_sets_config") {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return mockRedisStore.get(key) ?? null
  }),
  setSettings: jest.fn(async (key: string, value: unknown) => {
    mockRedisStore.set(key, value)
  }),
}))

jest.mock("@/lib/engine-progression-logs", () => ({
  logProgressionEvent: jest.fn(async () => undefined),
}))

jest.mock("@/lib/broadcast-helpers", () => ({
  emitStrategyUpdate: jest.fn(),
}))

jest.mock("@/lib/sets-compaction", () => {
  const actual = jest.requireActual("@/lib/sets-compaction")
  return {
    ...actual,
    loadCompactionConfig: jest.fn(async (type: string) =>
      type === "strategy.base"
        ? { floor: 5000, thresholdPct: 20 }
        : { floor: 250, thresholdPct: 20 },
    ),
  }
})

describe("StrategySetsProcessor", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRedisStore.clear()
    mockClientStore.clear()
  })

  test("uses resolved compaction floors when selecting top strategy candidates", async () => {
    const processor = new StrategySetsProcessor("conn-1")
    const candidateCount = 5_025
    const indications = Array.from({ length: candidateCount }, (_, i) => ({
      type: "mock",
      confidence: 0.9,
      profitFactor: 2 + i / candidateCount,
      direction: "long",
      metadata: {},
    }))

    await processor.processAllStrategySets("BTCUSDT", indications)

    expect(loadCompactionConfig).toHaveBeenCalledWith("strategy.base")
    expect(setSettings).toHaveBeenCalledWith(
      "strategy_set:conn-1:BTCUSDT:base:long:stats",
      expect.objectContaining({
        totalCalculated: expect.any(Number),
      }),
    )
    const baseStatsCall = (setSettings as jest.Mock).mock.calls.find(
      ([key]) => key === "strategy_set:conn-1:BTCUSDT:base:long:stats",
    )
    expect(baseStatsCall?.[1].totalCalculated).toBe(candidateCount)
  })

  test("awaits constructor-loaded non-default settings before processing candidates", async () => {
    mockRedisStore.set("strategy_sets_config", {
      base: 300,
      main: 301,
      real: 302,
      live: 303,
    })

    const indications = Array.from({ length: 400 }, (_, index) => ({
      type: `indication-${index}`,
      confidence: 0.9,
      profitFactor: 1 + index / 100,
      direction: "long",
      metadata: { index },
    }))

    const processor = new StrategySetsProcessor("conn-strategy-settings")
    await processor.processAllStrategySets("BTC-USDT", indications)

    const baseEntries = JSON.parse(
      mockClientStore.get("strategy_set:conn-strategy-settings:BTC-USDT:base:long") ?? "[]",
    )
    const mainEntries = JSON.parse(
      mockClientStore.get("strategy_set:conn-strategy-settings:BTC-USDT:main:long") ?? "[]",
    )

    expect(baseEntries).toHaveLength(300)
    expect(mainEntries).toHaveLength(301)
    expect(Math.min(...baseEntries.map((entry: any) => entry.profitFactor))).toBeCloseTo(1.95)
    expect(Math.min(...mainEntries.map((entry: any) => entry.profitFactor))).toBeCloseTo(1.99)
  })

  test("aggregates each strategy stage qualified count exactly once", async () => {
    const processor = new StrategySetsProcessor("conn-aggregation")
    await processor.processAllStrategySets("ETHUSDT", [
      {
        type: "mock",
        confidence: 0.9,
        profitFactor: 2,
        direction: "long",
        metadata: {},
      },
    ])

    expect(logProgressionEvent).toHaveBeenCalledWith(
      "conn-aggregation",
      "strategies_sets",
      "info",
      "All strategy types evaluated for ETHUSDT",
      expect.objectContaining({
        totalQualified: 4,
        rejectedDirectionTotal: 0,
        base: expect.objectContaining({ rawTotal: 1, selectedTotal: 1, qualified: 1, byDirection: { long: 1, short: 0 } }),
        main: expect.objectContaining({ rawTotal: 1, selectedTotal: 1, qualified: 1, byDirection: { long: 1, short: 0 } }),
        real: expect.objectContaining({ rawTotal: 1, selectedTotal: 1, qualified: 1, byDirection: { long: 1, short: 0 } }),
        live: expect.objectContaining({ rawTotal: 1, selectedTotal: 1, qualified: 1, byDirection: { long: 1, short: 0 } }),
      }),
    )
  })

  test("keeps symbol/market and asymmetric Long/Short progression lanes independent", async () => {
    const processor = new StrategySetsProcessor("conn-directional")
    await processor.processAllStrategySets("ethusdt", [
      { type: "direction", confidence: 0.9, profitFactor: 2.4, direction: "long", setKey: "source-long-1", metadata: {} },
      { type: "move", confidence: 0.9, profitFactor: 2.2, side: "buy", setKey: "source-long-2", metadata: {} },
      { type: "trend", confidence: 0.9, profitFactor: 2.0, metadata: { direction: "LONG" } },
      { type: "active", confidence: 0.9, profitFactor: 1.8, direction: "short", setKey: "source-short-1", metadata: {} },
      { type: "invalid", confidence: 0.99, profitFactor: 9, direction: "sideways", metadata: {} },
    ])

    const longKey = "strategy_set:conn-directional:ETHUSDT:live:long"
    const shortKey = "strategy_set:conn-directional:ETHUSDT:live:short"
    const longEntries = JSON.parse(mockClientStore.get(longKey) ?? "[]")
    const shortEntries = JSON.parse(mockClientStore.get(shortKey) ?? "[]")

    expect(mockClientStore.has("strategy_set:conn-directional:ETHUSDT:live")).toBe(false)
    expect(longEntries).toHaveLength(3)
    expect(shortEntries).toHaveLength(1)
    expect(longEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectionId: "conn-directional",
        symbol: "ETHUSDT",
        direction: "long",
        sourceSetKey: "source-long-1",
      }),
    ]))
    expect(shortEntries[0]).toEqual(expect.objectContaining({
      connectionId: "conn-directional",
      symbol: "ETHUSDT",
      direction: "short",
      sourceSetKey: "source-short-1",
    }))

    const [longStats, shortStats, aggregateStats, bestShort] = await Promise.all([
      processor.getSetStats("ethusdt", "live", "long"),
      processor.getSetStats("ETHUSDT", "live", "short"),
      processor.getSetStats("ETHUSDT", "live"),
      processor.getSetEntries("ETHUSDT", "live", 10, "short"),
    ])
    expect(longStats).toEqual(expect.objectContaining({ direction: "long", currentEntries: 3, totalQualified: 3 }))
    expect(shortStats).toEqual(expect.objectContaining({ direction: "short", currentEntries: 1, totalQualified: 1 }))
    expect(aggregateStats).toEqual(expect.objectContaining({ direction: "all", currentEntries: 4, totalQualified: 4 }))
    expect(bestShort).toHaveLength(1)
    expect(bestShort[0].direction).toBe("short")

    expect(logProgressionEvent).toHaveBeenCalledWith(
      "conn-directional",
      "strategies_sets",
      "info",
      "All strategy types evaluated for ETHUSDT",
      expect.objectContaining({
        symbol: "ETHUSDT",
        selectedTotal: 4,
        rejectedDirectionTotal: 1,
        live: expect.objectContaining({
          qualified: 4,
          byDirection: { long: 3, short: 1 },
        }),
      }),
    )
  })
})
