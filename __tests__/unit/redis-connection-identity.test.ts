import { jest } from "@jest/globals"

jest.mock("@/lib/redis-migrations", () => ({
  runMigrations: jest.fn(async () => undefined),
  resetMigrationRunState: jest.fn(),
  getLatestMigrationVersion: jest.fn(() => 0),
}))

describe("Redis connection identity recovery", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv, NODE_ENV: "test" }
    delete process.env.REDIS_URL
    delete process.env.KV_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.KV_REST_API_URL
    delete (globalThis as any).__redis_core_promise
    delete (globalThis as any).__redis_init_promise
    delete (globalThis as any).__redis_fully_connected
    delete (globalThis as any).__redis_backend
    delete (globalThis as any).__redis_data
    delete (globalThis as any).__redis_snapshot_loaded
  })

  afterAll(() => {
    process.env = originalEnv
  })

  test("uses the indexed connection id when a legacy hash omitted embedded id", async () => {
    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    const client = redisDb.getRedisClient()
    await client.flushDb()
    await client.sadd("connections", "bingx-x01")
    await client.hset("connection:bingx-x01", {
      name: "BingX X01",
      exchange: "bingx",
      is_enabled: "1",
    })

    await expect(redisDb.getConnection("bingx-x01")).resolves.toMatchObject({
      id: "bingx-x01",
      exchange: "bingx",
    })
    await expect(redisDb.getAllConnections()).resolves.toEqual([
      expect.objectContaining({ id: "bingx-x01", name: "BingX X01" }),
    ])
  })
})

  test("cannot inherit testnet from a stale settings overlay on BingX X01", async () => {
    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    const client = redisDb.getRedisClient()
    await client.flushDb()
    await client.sadd("connections", "bingx-x01")
    await client.hset("connection:bingx-x01", {
      name: "BingX X01",
      exchange: "bingx",
      is_testnet: "0",
      environment: "prod-live",
      updated_at: "2026-09-21T12:00:00.000Z",
    })
    await client.hset("settings:connection:bingx-x01", {
      is_testnet: "1",
      environment: "prod-vst",
      updated_at: "2026-09-21T13:00:00.000Z",
    })

    await expect(redisDb.getConnection("bingx-x01")).resolves.toMatchObject({
      id: "bingx-x01",
      is_testnet: false,
      environment: "prod-live",
      base_url: "https://open-api.bingx.com",
    })
  })

