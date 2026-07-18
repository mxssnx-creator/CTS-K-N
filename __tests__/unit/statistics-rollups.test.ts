const mockHashes = new Map<string, Record<string, string>>()
const mockStrings = new Map<string, string>()
const mockExpirations = new Map<string, number>()

const getHash = (key: string) => {
  const current = mockHashes.get(key) || {}
  mockHashes.set(key, current)
  return current
}

const mockClient = {
  hincrby: jest.fn(async (key: string, field: string, increment: number) => {
    const hash = getHash(key)
    const next = (Number(hash[field]) || 0) + increment
    hash[field] = String(next)
    return next
  }),
  hincrbyfloat: jest.fn(async (key: string, field: string, increment: number) => {
    const hash = getHash(key)
    const next = (Number(hash[field]) || 0) + increment
    hash[field] = String(next)
    return next
  }),
  hset: jest.fn(async (key: string, fieldOrObject: string | Record<string, unknown>, value?: unknown) => {
    const hash = getHash(key)
    if (typeof fieldOrObject === "string") hash[fieldOrObject] = String(value ?? "")
    else for (const [field, entry] of Object.entries(fieldOrObject)) hash[field] = String(entry ?? "")
    return 1
  }),
  hgetall: jest.fn(async (key: string) => ({ ...(mockHashes.get(key) || {}) })),
  expire: jest.fn(async (key: string, seconds: number) => {
    mockExpirations.set(key, seconds)
    return 1
  }),
  incr: jest.fn(async (key: string) => {
    const next = (Number(mockStrings.get(key)) || 0) + 1
    mockStrings.set(key, String(next))
    return next
  }),
  incrby: jest.fn(async (key: string, increment: number) => {
    const next = (Number(mockStrings.get(key)) || 0) + increment
    mockStrings.set(key, String(next))
    return next
  }),
  set: jest.fn(async (key: string, value: string) => {
    mockStrings.set(key, value)
    return "OK"
  }),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => mockClient),
}))

import {
  getIndicationStats,
  getStrategyStats,
  trackIndicationStats,
  trackStrategyStats,
} from "@/lib/statistics-tracker"

describe("bounded hourly statistics rollups", () => {
  beforeEach(() => {
    mockHashes.clear()
    mockStrings.clear()
    mockExpirations.clear()
    jest.clearAllMocks()
  })

  test("many indication and strategy events reuse one hourly hash per kind", async () => {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      trackIndicationStats("bingx-x01", "BTCUSDT", "Trend", index, 0.75),
    ))
    await Promise.all(Array.from({ length: 50 }, () =>
      trackStrategyStats("bingx-x01", "BTCUSDT", "Default", 3, 2, 1.5, 8),
    ))

    const hourlyKeys = Array.from(mockHashes.keys()).filter((key) => key.startsWith("statistics:hourly:"))
    expect(hourlyKeys).toHaveLength(2)
    expect(hourlyKeys.filter((key) => key.includes(":indications:"))).toHaveLength(1)
    expect(hourlyKeys.filter((key) => key.includes(":strategies:"))).toHaveLength(1)
    expect(Array.from(mockExpirations.entries()).filter(([key]) => key.startsWith("statistics:hourly:")))
      .toEqual(expect.arrayContaining(hourlyKeys.map((key) => [key, 8 * 24 * 60 * 60])))

    const indicationStats = await getIndicationStats("bingx-x01", 24)
    expect(indicationStats).toEqual([
      expect.objectContaining({ type: "trend", count: 100, avg_confidence: 0.75 }),
    ])
    const strategyStats = await getStrategyStats("bingx-x01", 24)
    expect(strategyStats).toEqual([
      expect.objectContaining({
        type: "default",
        count: 50,
        total_created: 150,
        total_passed: 100,
        avg_profit_factor: 1.5,
        avg_drawdown_time: 8,
      }),
    ])
  })
})
