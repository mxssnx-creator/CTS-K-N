import { jest } from "@jest/globals"

const connect = jest.fn(async () => undefined)
const ping = jest.fn(async () => "PONG")
const info = jest.fn(async () => "# Stats\r\ninstantaneous_ops_per_sec:37\r\n")
let transaction: Record<string, any> | null = null
const createClient = jest.fn(() => ({
  isOpen: false,
  on: jest.fn(),
  connect,
  ping,
  info,
  multi: () => transaction,
}))

jest.mock("redis", () => ({ createClient }))
jest.mock("@/lib/redis-migrations", () => ({
  runMigrations: jest.fn(async () => undefined),
  resetMigrationRunState: jest.fn(),
}))

describe("redis-db production Redis client selection", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    createClient.mockClear()
    connect.mockClear()
    ping.mockClear()
    info.mockClear()
    transaction = null
    process.env = { ...originalEnv, NODE_ENV: "production", REDIS_URL: "redis://localhost:6379" }
    delete (globalThis as any).__redis_core_promise
    delete (globalThis as any).__redis_init_promise
    delete (globalThis as any).__redis_fully_connected
    delete (globalThis as any).__redis_backend
    delete (globalThis as any).__redis_data
    delete (globalThis as any).__redis_observed_rps
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("uses the network Redis adapter instead of InlineLocalRedis when REDIS_URL is configured", async () => {
    const redisDb = await import("@/lib/redis-db")

    await redisDb.initRedis()
    const client = redisDb.getRedisClient()

    expect(redisDb.getRedisBackend()).toBe("redis-network")
    expect(client).not.toBeInstanceOf(redisDb.InlineLocalRedis)
    expect(createClient).toHaveBeenCalledWith({ url: "redis://localhost:6379" })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it("reads the production Redis INFO rate instead of reporting the inline-only zero counter", async () => {
    const redisDb = await import("@/lib/redis-db")

    await redisDb.initRedis()

    await expect(redisDb.getObservedRedisRequestsPerSecond()).resolves.toBe(37)
    expect(info).toHaveBeenCalled()
  })

  it("preserves counter writes, all collection members and result alignment in mixed batches", async () => {
    const exec = jest.fn(async () => [1, 5, 2, ["a", "b"], 2, true, 1, 1.25])
    transaction = Object.fromEntries([
      "hSet", "hIncrBy", "rPush", "lRange", "sAdd", "sIsMember", "zAdd", "zScore",
    ].map((method) => [method, jest.fn()]))
    transaction.exec = exec
    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    const batch = redisDb.getRedisClient().pipeline()
    batch.hset("stats", { valid: 3 })
    batch.hincrby("stats", "valid", 2)
    batch.rpush("rows", "a", "b")
    batch.lrange("rows", 0, -1)
    batch.sadd("index", "a", "b")
    batch.sismember("index", "b")
    batch.zadd("scores", 1.25, "a")
    batch.zscore("scores", "a")

    await expect(batch.exec()).resolves.toEqual([1, 5, 2, ["a", "b"], 2, 1, 1, "1.25"])
    expect(transaction.hSet).toHaveBeenCalledWith("stats", { valid: "3" })
    expect(transaction.hIncrBy).toHaveBeenCalledWith("stats", "valid", 2)
    expect(transaction.rPush).toHaveBeenCalledWith("rows", ["a", "b"])
    expect(transaction.sAdd).toHaveBeenCalledWith("index", ["a", "b"])
    expect(transaction.zAdd).toHaveBeenCalledWith("scores", { score: 1.25, value: "a" })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("rejects an unsupported batch before any queued writes are executed", async () => {
    const exec = jest.fn(async () => ["OK"])
    transaction = { set: jest.fn(), exec }
    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    const batch = redisDb.getRedisClient().multi()
    batch.set("must-not-write", "value")
    batch.unsupportedCommand("key")
    await expect(batch.exec()).rejects.toThrow("Unsupported native Redis transaction command: unsupportedCommand")
    expect(exec).not.toHaveBeenCalled()
  })
})
