import { InlineLocalRedis, flushOwnedKeys, protectedRedisKeyPrefixes } from "@/lib/redis-db"

describe("flushOwnedKeys — reset never wipes a co-located project", () => {
  const originalEnv = process.env.CTS_REDIS_PROTECTED_PREFIXES

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CTS_REDIS_PROTECTED_PREFIXES
    else process.env.CTS_REDIS_PROTECTED_PREFIXES = originalEnv
  })

  async function seededClient(): Promise<InlineLocalRedis> {
    const client = new InlineLocalRedis()
    // CTS-K-N keys of every shape the app uses.
    await client.set("_schema_version", "108")
    await client.hset("connection:bingx-x02", { exchange: "bingx" })
    await client.sadd("connections", "bingx-x02")
    await client.set("trade_engine_state:bingx-x02", "{}")
    await client.set("live:entry-protection-halt:bingx-x02", "1")
    // Another project's keys on the same logical DB.
    await client.set("cts-ga:desk:state", "keep")
    await client.hset("cts-ga:pulse:bingx-x02", { alive: "1" })
    await client.set("cts-g:legacy", "keep")
    return client
  }

  it("deletes every owned key and preserves foreign-prefixed keys by default", async () => {
    delete process.env.CTS_REDIS_PROTECTED_PREFIXES
    const client = await seededClient()

    const result = await flushOwnedKeys(client)

    expect(result).toMatchObject({ deleted: 5, protected: 3, batches: 1 })
    expect(result.protectedPrefixes).toEqual(["cts-ga:", "cts-g:"])
    expect(await client.get("_schema_version")).toBeNull()
    expect(await client.hgetall("connection:bingx-x02")).toEqual({})
    expect(await client.get("live:entry-protection-halt:bingx-x02")).toBeNull()
    expect(await client.get("cts-ga:desk:state")).toBe("keep")
    expect(await client.hgetall("cts-ga:pulse:bingx-x02")).toEqual({ alive: "1" })
    expect(await client.get("cts-g:legacy")).toBe("keep")
  })

  it("honours an explicit prefix override, including an empty one", async () => {
    process.env.CTS_REDIS_PROTECTED_PREFIXES = "other:"
    expect(protectedRedisKeyPrefixes()).toEqual(["other:"])
    const client = await seededClient()
    await client.set("other:thing", "keep")

    const result = await flushOwnedKeys(client)
    expect(result.protected).toBe(1)
    expect(await client.get("other:thing")).toBe("keep")
    // With no override the cts-ga keys were owned this time and are gone.
    expect(await client.get("cts-ga:desk:state")).toBeNull()

    process.env.CTS_REDIS_PROTECTED_PREFIXES = ""
    expect(protectedRedisKeyPrefixes()).toEqual([])
  })

  it("removes a large keyspace in bounded batches", async () => {
    delete process.env.CTS_REDIS_PROTECTED_PREFIXES
    const client = new InlineLocalRedis()
    for (let index = 0; index < 1_203; index++) await client.set(`k:${index}`, "x")
    for (let index = 0; index < 7; index++) await client.set(`cts-ga:k:${index}`, "keep")

    const before = await client.keys("*")
    const ownedBefore = before.filter((key) => !key.startsWith("cts-ga:")).length
    expect(ownedBefore).toBeGreaterThanOrEqual(1_203)

    const result = await flushOwnedKeys(client)

    expect(result.deleted).toBe(ownedBefore)
    expect(result.protected).toBe(7)
    expect(result.batches).toBe(Math.ceil(ownedBefore / 500))
    expect((await client.keys("*")).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `cts-ga:k:${i}`).sort())
  })

  it("is what flushAll delegates to, so every reset route is covered", async () => {
    const redisDb = require("@/lib/redis-db") as typeof import("@/lib/redis-db")
    expect(redisDb.flushAll).toBeInstanceOf(Function)
    const source = redisDb.flushAll.toString()
    expect(source).toContain("flushOwnedKeys")
    expect(source).not.toContain("flushDb")
  })
})
