const venueHistory = jest.fn(async (): Promise<any[] | null> => null)
jest.mock('@/lib/exchange-connectors/factory', () => ({ ExchangeConnectorFactory: { getInstance: () => ({ getOrCreateConnector: async () => ({ getOHLCV: venueHistory }) }) } }))
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

test('a short cold-start cache refreshes after history arrives without hammering Redis', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(start)
  redis.lrange.mockResolvedValueOnce([]).mockResolvedValueOnce([])
  const tail = candles.slice(-90)
  expect(await getCtsGMinuteHistory('BTCUSDT', tail, 'late-history')).toHaveLength(90)
  const reads = redis.lrange.mock.calls.length
  await getCtsGMinuteHistory('BTCUSDT', tail, 'late-history')
  expect(redis.lrange).toHaveBeenCalledTimes(reads)
  now.mockReturnValue(start + 30_001)
  expect(await getCtsGMinuteHistory('BTCUSDT', tail, 'late-history')).toHaveLength(1440)
  now.mockRestore()
})

test('hydrates higher-timeframe warm-up from real M1 candles and deduplicates concurrent requests', async () => {
  redis.lrange.mockResolvedValueOnce([]).mockResolvedValueOnce([])
  venueHistory.mockResolvedValueOnce(candles)
  const before = venueHistory.mock.calls.length
  const [a, b] = await Promise.all([getCtsGMinuteHistory('SOLUSDT', candles.slice(-90), 'venue-warmup'), getCtsGMinuteHistory('SOLUSDT', candles.slice(-90), 'venue-warmup')])
  expect(a).toHaveLength(1440)
  expect(b).toEqual(a)
  expect(venueHistory).toHaveBeenCalledTimes(before + 1)
  expect(venueHistory).toHaveBeenLastCalledWith('SOLUSDT', '1m', 1441)
})
