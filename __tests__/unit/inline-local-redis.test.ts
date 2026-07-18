import { mkdtemp, readdir, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

import { InlineLocalRedis } from "@/lib/redis-db"

function resetInlineGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_cleanup_started
  delete (globalThis as any).__db_ops_tracker
}

describe("InlineLocalRedis compatibility and persistence", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.useRealTimers()
    process.env = { ...originalEnv, NODE_ENV: "test" }
    resetInlineGlobals()
  })

  afterEach(() => {
    resetInlineGlobals()
    process.env = originalEnv
  })

  it("supports the Redis command surface used by application callers", async () => {
    const redis = new InlineLocalRedis()

    await expect(redis.ping()).resolves.toBe("PONG")
    await expect(redis.set("string:key", "value")).resolves.toBe("OK")
    await expect(redis.get("string:key")).resolves.toBe("value")
    await expect(redis.mget("string:key", "missing")).resolves.toEqual(["value", null])

    await expect(redis.hset("hash:key", { a: "1", b: "2" })).resolves.toBe(2)
    await expect(redis.hset("hash:key", "c", "3")).resolves.toBe(1)
    await expect(redis.hget("hash:key", "a")).resolves.toBe("1")
    await expect(redis.hgetall("hash:key")).resolves.toEqual({ a: "1", b: "2", c: "3" })
    await expect(redis.hincrby("hash:key", "a", 2)).resolves.toBe(3)
    await expect(redis.hincrbyfloat("hash:key", "float", 1.5)).resolves.toBe(1.5)
    await expect(redis.hdel("hash:key", "b")).resolves.toBe(1)

    await expect(redis.sadd("set:key", "one", "two", "two")).resolves.toBe(2)
    await expect(redis.scard("set:key")).resolves.toBe(2)
    await expect(redis.sismember("set:key", "one")).resolves.toBe(1)
    await expect(redis.smembers("set:key")).resolves.toEqual(expect.arrayContaining(["one", "two"]))
    await expect(redis.srem("set:key", "two")).resolves.toBe(1)

    await expect(redis.lpush("list:key", "b", "a")).resolves.toBe(2)
    await expect(redis.rpush("list:key", "c")).resolves.toBe(3)
    await expect(redis.lrange("list:key", 0, -1)).resolves.toEqual(["a", "b", "c"])
    await expect(redis.lpos("list:key", "b")).resolves.toBe(1)
    await expect(redis.lrem("list:key", 1, "b")).resolves.toBe(1)
    await expect(redis.lpop("list:key")).resolves.toBe("a")
    await expect(redis.rpop("list:key")).resolves.toBe("c")

    await expect(redis.zadd("z:key", 2, "two")).resolves.toBe(1)
    await expect(redis.zadd("z:key", 1, "one")).resolves.toBe(1)
    await expect(redis.zrange("z:key", 0, -1)).resolves.toEqual(["one", "two"])
    await expect(redis.zrevrange("z:key", 0, -1)).resolves.toEqual(["two", "one"])
    await expect(redis.zscore("z:key", "two")).resolves.toBe("2")
    await expect(redis.zrangebyscore("z:key", 1, 2)).resolves.toEqual(["one", "two"])

    await expect(redis.expire("string:key", 30)).resolves.toBe(1)
    await expect(redis.ttl("string:key")).resolves.toBeGreaterThan(0)
    await expect(redis.keys("*:key")).resolves.toEqual(expect.arrayContaining(["string:key", "hash:key", "set:key", "z:key"]))
    await expect(redis.dbSize()).resolves.toBeGreaterThanOrEqual(4)

    const pipelineResult = await redis
      .multi()
      .set("pipe:key", "ok")
      .get("pipe:key")
      .hset("pipe:hash", { field: "value" })
      .hgetall("pipe:hash")
      .exec()

    expect(pipelineResult).toEqual(["OK", "ok", 1, { field: "value" }])
  })

  it("preserves active-owner pipeline keys while deleting stale or unowned volatile keys", async () => {
    const redis = new InlineLocalRedis()
    const now = Date.now()

    await redis.hset("settings:trade_engine_state:active-conn", {
      last_processor_heartbeat: String(now),
    })
    await redis.hset("pseudo_position:active-conn:pos-1", { id: "pos-1" })
    await redis.sadd("pseudo_positions:active-conn", "pos-1")
    await redis.set("settings:pseudo_position:active-conn:pos-1", "present")
    await redis.set("settings:pseudo_positions:active-conn:active_config_keys", "present")
    await redis.set("strategies:active-conn:BTCUSDT:main:sets", "present")
    await redis.set("settings:strategies:active-conn:BTCUSDT:sets", "present")
    await redis.set("indication_set:active-conn:BTCUSDT:direction:cfg", "present")
    await redis.set("indication_outcomes_pending:active-conn:BTCUSDT", "present")

    await redis.hset("settings:trade_engine_state:stale-conn", {
      last_processor_heartbeat: String(now - 120_000),
    })
    await redis.hset("pseudo_position:stale-conn:pos-1", { id: "pos-1" })
    await redis.sadd("pseudo_positions:stale-conn", "pos-1")
    await redis.set("strategies:unowned-conn:BTCUSDT:main:sets", "present")

    await redis.set("live:lock:stale", String(now - 7 * 60 * 60 * 1000))
    await redis.set("live:position:tracking:active-conn:BTCUSDT:long", "pointer")
    await redis.set("live:position:active-conn:BTCUSDT:long:moved:flag", "1")
    await redis.hset("live:position:active-conn:BTCUSDT:long", { id: "durable-position" })

    const result = await redis.cleanupVolatileRuntimeState({ mode: "activeOwnerSafe", reason: "unit-test" })

    expect(result.deleted).toBeGreaterThanOrEqual(5)
    await expect(redis.exists("pseudo_position:active-conn:pos-1")).resolves.toBe(1)
    await expect(redis.exists("pseudo_positions:active-conn")).resolves.toBe(1)
    await expect(redis.exists("settings:pseudo_position:active-conn:pos-1")).resolves.toBe(1)
    await expect(redis.exists("settings:pseudo_positions:active-conn:active_config_keys")).resolves.toBe(1)
    await expect(redis.exists("strategies:active-conn:BTCUSDT:main:sets")).resolves.toBe(1)
    await expect(redis.exists("settings:strategies:active-conn:BTCUSDT:sets")).resolves.toBe(1)
    await expect(redis.exists("indication_set:active-conn:BTCUSDT:direction:cfg")).resolves.toBe(1)
    await expect(redis.exists("indication_outcomes_pending:active-conn:BTCUSDT")).resolves.toBe(1)

    await expect(redis.exists("pseudo_position:stale-conn:pos-1")).resolves.toBe(0)
    await expect(redis.exists("pseudo_positions:stale-conn")).resolves.toBe(0)
    await expect(redis.exists("strategies:unowned-conn:BTCUSDT:main:sets")).resolves.toBe(0)
    await expect(redis.exists("live:lock:stale")).resolves.toBe(0)
    await expect(redis.exists("live:position:tracking:active-conn:BTCUSDT:long")).resolves.toBe(0)
    await expect(redis.exists("live:position:active-conn:BTCUSDT:long:moved:flag")).resolves.toBe(0)
    await expect(redis.exists("live:position:active-conn:BTCUSDT:long")).resolves.toBe(1)
  })

  it("persists and restores all supported data structures from the snapshot file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.set("string:persist", "value")
      await writer.hset("hash:persist", { field: "value" })
      await writer.sadd("set:persist", "member")
      await writer.rpush("list:persist", "first", "second")
      await writer.zadd("z:persist", 10, "member")
      await writer.expire("string:persist", 60)

      await expect(writer.saveToDisk()).resolves.toBe(true)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)

      await expect(reader.get("string:persist")).resolves.toBe("value")
      await expect(reader.hgetall("hash:persist")).resolves.toEqual({ field: "value" })
      await expect(reader.smembers("set:persist")).resolves.toEqual(["member"])
      await expect(reader.lrange("list:persist", 0, -1)).resolves.toEqual(["first", "second"])
      await expect(reader.zscore("z:persist", "member")).resolves.toBe("10")
      await expect(reader.ttl("string:persist")).resolves.toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("writes the synchronous production shutdown snapshot without global require", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-sync-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.set("shutdown:persist", "stable")
      expect(writer.saveToDiskSync()).toBe(true)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.get("shutdown:persist")).resolves.toBe("stable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("restores settings, pending order ownership, and exact Set indexes after abrupt memory loss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-crash-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.hset("connection_settings:conn-live", {
        settings_version: "generation-2",
        dcaMaxSteps: "4",
        blockVolumeRatio: "0.75",
      })
      await writer.hset("live_positions:conn-live:position-1", {
        id: "position-1",
        status: "placed_unconfirmed",
        pendingEntryClientOrderId: "cts-entry-position-1",
        setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0",
      })
      await writer.sadd("live_positions:conn-live", "position-1")
      await writer.hset("strategy_set_entry_counts:conn-live", { "set:exact": "1" })
      await writer.hset("strategy_set_active_entry_counts:conn-live", { "set:exact": "1" })
      await writer.sadd("strategy_active_set_keys:conn-live", "set:exact")
      await writer.hset("strategy_ledger_totals:conn-live", {
        exact_entries: "1",
        active_memberships: "1",
      })

      await expect(writer.persistNow()).resolves.toBe(true)
      const firstMtime = (await stat(snapshotPath)).mtimeMs
      await expect(writer.saveToDisk()).resolves.toBe(true)
      expect((await stat(snapshotPath)).mtimeMs).toBe(firstMtime)
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])

      // Drop every in-memory Map without running a graceful-exit flush. The new
      // instance must reconstruct the last crossed disk barrier exactly.
      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.hget("connection_settings:conn-live", "settings_version")).resolves.toBe("generation-2")
      await expect(reader.hgetall("live_positions:conn-live:position-1")).resolves.toMatchObject({
        status: "placed_unconfirmed",
        pendingEntryClientOrderId: "cts-entry-position-1",
      })
      await expect(reader.smembers("live_positions:conn-live")).resolves.toEqual(["position-1"])
      await expect(reader.smembers("strategy_active_set_keys:conn-live")).resolves.toEqual(["set:exact"])
      await expect(reader.hgetall("strategy_ledger_totals:conn-live")).resolves.toMatchObject({
        exact_entries: "1",
        active_memberships: "1",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("caps the periodic recovery checkpoint at exactly one minute", () => {
    const fs = require("fs")
    const source = fs.readFileSync(join(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(source).toContain("const defaultInterval = 60_000")
    expect(source).toContain("Math.max(5_000, Math.min(60_000, Math.floor(configuredInterval)))")
    expect(source).toContain("if (evicted > 0) this.markDirty()")
  })

  it("keeps sorted sets ordered while updating duplicate members and slicing score ranges", async () => {
    const redis = new InlineLocalRedis()

    await expect(redis.zadd("z:updates", 30, "thirty")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 10, "ten")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 20, "twenty")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 20, "twenty-b")).resolves.toBe(1)

    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["ten", "twenty", "twenty-b", "thirty"])
    await expect(redis.zrangebyscore("z:updates", 15, 25)).resolves.toEqual(["twenty", "twenty-b"])

    await expect(redis.zadd("z:updates", 5, "twenty")).resolves.toBe(0)
    await expect(redis.zscore("z:updates", "twenty")).resolves.toBe("5")
    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["twenty", "ten", "twenty-b", "thirty"])
    await expect(redis.zrangebyscore("z:updates", "-inf", 10)).resolves.toEqual(["twenty", "ten"])
    await expect(redis.zcard("z:updates")).resolves.toBe(4)

    await expect(redis.zremrangebyscore("z:updates", 10, 20)).resolves.toBe(2)
    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["twenty", "thirty"])
    await expect(redis.zscore("z:updates", "ten")).resolves.toBeNull()
    await expect(redis.zrangebyscore("z:updates", 0, "+inf")).resolves.toEqual(["twenty", "thirty"])
  })

  it("rebuilds sorted-set member indexes after snapshot reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-zset-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.zadd("z:snapshot", 100, "hundred")
      await writer.zadd("z:snapshot", 50, "fifty")
      await writer.zadd("z:snapshot", 75, "seventy-five")
      await writer.zadd("z:snapshot", 60, "fifty")
      await expect(writer.saveToDisk()).resolves.toBe(true)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)

      await expect(reader.zrange("z:snapshot", 0, -1)).resolves.toEqual(["fifty", "seventy-five", "hundred"])
      await expect(reader.zscore("z:snapshot", "fifty")).resolves.toBe("60")
      await expect(reader.zadd("z:snapshot", 40, "hundred")).resolves.toBe(0)
      await expect(reader.zrangebyscore("z:snapshot", 0, 70)).resolves.toEqual(["hundred", "fifty"])
      await expect(reader.zremrangebyscore("z:snapshot", 50, 80)).resolves.toBe(2)
      await expect(reader.zrange("z:snapshot", 0, -1)).resolves.toEqual(["hundred"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
