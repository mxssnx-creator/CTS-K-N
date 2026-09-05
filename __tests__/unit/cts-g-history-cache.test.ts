const start = Date.UTC(2026, 8, 4)
const candles = Array.from({ length: 1440 }, (_, i) => ({ timestamp: start + i * 60_000, close: 100 + i }))
const chunks = [candles.slice(0, 720), candles.slice(720)]
const redis = {
  get: jest.fn(async () => JSON.stringify({ ranges: chunks.map(rows => ({ start: rows[0].timestamp, end: rows.at(-1)!.timestamp })) })),
  lrange: jest.fn(async (_key: string, a: number, b: number) => chunks.slice(a, b + 1).map(rows => JSON.stringify(rows))),
}
jest.mock("@/lib/redis-db", () => ({ initRedis: jest.fn(async () => {}), getRedisClient: () => redis }))
import { getCtsGMinuteHistory } from "@/lib/trade-engine/market-data-cache"

test("compact history deduplicates concurrent reads, extends the tail, and isolates connections", async () => {
  const tail = candles.slice(-90)
  const [a, b] = await Promise.all([getCtsGMinuteHistory("BTCUSDT", tail, "cts-cache-a"), getCtsGMinuteHistory("BTCUSDT", tail, "cts-cache-a")])
  expect(a).toHaveLength(1440)
  expect(b).toEqual(a)
  expect(redis.lrange).toHaveBeenCalledTimes(2)
  const next = { timestamp: start + 1440 * 60_000, close: 1540 }
  const grown = await getCtsGMinuteHistory("BTCUSDT", [...tail, next], "cts-cache-a")
  expect(grown).toHaveLength(1441)
  expect(grown.at(-1)).toEqual(next)
  expect(redis.lrange).toHaveBeenCalledTimes(2)
  await getCtsGMinuteHistory("BTCUSDT", tail, "cts-cache-b")
  expect(redis.lrange).toHaveBeenCalledTimes(4)
  expect(redis.lrange.mock.calls[2][0]).not.toBe(redis.lrange.mock.calls[0][0])
})
