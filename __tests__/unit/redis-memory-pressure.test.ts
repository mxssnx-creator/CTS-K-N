import { InlineLocalRedis } from "@/lib/redis-db"

describe("inline Redis bounded cleanup", () => {
  it("expires a bounded batch without requiring a full keyspace materialization", async () => {
    const redis = new InlineLocalRedis()
    for (let i = 0; i < 250; i++) {
      await redis.set(`test:ttl:${i}`, String(i), { PX: 1 })
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    const removed = await redis.cleanupExpiredKeysPublic()
    expect(removed).toBeGreaterThan(0)
    expect(await redis.dbSize()).toBeLessThan(250)
  })

  it("keeps scan sessions bounded under abandoned scans", async () => {
    const redis = new InlineLocalRedis()
    for (let i = 0; i < 100; i++) await redis.set(`scan:${i}`, String(i))
    for (let i = 0; i < 100; i++) await redis.scan(String(i + 1), "MATCH", "scan:*")
    expect(await redis.dbSize()).toBe(100)
  })
})
