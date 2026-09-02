import { mkdtemp, readFile, readdir, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

import {
  InlineLocalRedis,
  moveRedisListMembershipToHead,
  upsertRedisListHead,
} from "@/lib/redis-db"

function resetInlineGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_snapshot_save_promise
  delete (globalThis as any).__redis_snapshot_mutation_version
  delete (globalThis as any).__redis_snapshot_persisted_version
  delete (globalThis as any).__redis_snapshot_write_counter
  delete (globalThis as any).__redis_persistence_tick_started
  delete (globalThis as any).__redis_persistence_signals_attached
  delete (globalThis as any).__redis_snapshot_last_error_warn
  delete (globalThis as any).__redis_live_position_wal_promise
  delete (globalThis as any).__redis_live_position_wal_batch_scheduled
  delete (globalThis as any).__redis_live_position_wal_pending
  delete (globalThis as any).__redis_live_position_wal_write_counter
  delete (globalThis as any).__redis_cleanup_started
  delete (globalThis as any).__db_ops_tracker
  delete (globalThis as any).__kilo_snapshot_revision
  delete (globalThis as any).__kilo_snapshot_last_synced_at
  delete (globalThis as any).__kilo_snapshot_schema_promise
  delete (globalThis as any).__kilo_snapshot_refresh_promise
  delete (globalThis as any).__kilo_database_query
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
    await expect(redis.zcount("z:key", 1, 2)).resolves.toBe(2)

    await expect(redis.expire("string:key", 30)).resolves.toBe(1)
    await expect(redis.ttl("string:key")).resolves.toBeGreaterThan(0)
    await expect(redis.keys("*:key")).resolves.toEqual(expect.arrayContaining(["string:key", "hash:key", "set:key", "z:key"]))
    await expect(redis.dbSize()).resolves.toBeGreaterThanOrEqual(4)

    // Monitoring must be able to inspect a large local keyspace without first
    // building a full KEYS("*") array. The bounded sample is round-robin over
    // Redis data types, so the dashboard retains representative metrics.
    await expect(redis.sampleKeys(3)).resolves.toEqual(expect.arrayContaining([
      "string:key",
      "hash:key",
      "set:key",
    ]))
    await expect(redis.sampleKeys(3)).resolves.toHaveLength(3)

    const pipelineResult = await redis
      .multi()
      .set("pipe:key", "ok")
      .get("pipe:key")
      .hset("pipe:hash", { field: "value" })
      .hgetall("pipe:hash")
      .exec()

    expect(pipelineResult).toEqual(["OK", "ok", 1, { field: "value" }])
  })

  it("keeps Redis LPUSH ordering for a dense historic batch", async () => {
    const redis = new InlineLocalRedis()
    const batch = Array.from({ length: 30_000 }, (_, index) => `historic-${index}`)

    await redis.rpush("historic:batch", "older")
    await expect(redis.lpush("historic:batch", ...batch)).resolves.toBe(30_001)

    // Redis evaluates LPUSH arguments left-to-right, making the last supplied
    // value the new head. This guards the linear batch implementation used by
    // long historical fills without relying on brittle wall-clock timings.
    await expect(redis.lrange("historic:batch", 0, 2)).resolves.toEqual([
      "historic-29999",
      "historic-29998",
      "historic-29997",
    ])
    await expect(redis.lrange("historic:batch", -2, -1)).resolves.toEqual([
      "historic-0",
      "older",
    ])
  })

  it("scans a large mixed keyspace incrementally without duplicates", async () => {
    const redis = new InlineLocalRedis()
    for (let index = 0; index < 240; index++) {
      await redis.set(`historic:aggregate-marker:conn:${index}`, "1")
      await redis.hset(`unrelated:hash:${index}`, { value: String(index) })
    }

    const collected: string[] = []
    let cursor = "0"
    let pages = 0
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "historic:aggregate-marker:conn:*",
        "COUNT",
        17,
      )
      cursor = next
      collected.push(...keys)
      pages++
    } while (cursor !== "0")

    expect(pages).toBeGreaterThan(1)
    expect(collected).toHaveLength(240)
    expect(new Set(collected).size).toBe(240)
    expect(collected).toEqual(expect.arrayContaining([
      "historic:aggregate-marker:conn:0",
      "historic:aggregate-marker:conn:239",
    ]))
  })

  it("finishes a marker cleanup-sized scan after more than two thousand examined keys", async () => {
    const redis = new InlineLocalRedis()
    for (let index = 0; index < 2_400; index++) {
      await redis.set(`historic:aggregate-marker:large:${index}`, "1")
      await redis.hset(`unrelated:large:${index}`, { value: String(index) })
    }

    const collected: string[] = []
    let cursor = "0"
    let pages = 0
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "historic:aggregate-marker:large:*",
        "COUNT",
        100,
      )
      cursor = next
      collected.push(...keys)
      pages++
    } while (cursor !== "0" && pages < 100)

    expect(cursor).toBe("0")
    expect(pages).toBeGreaterThan(20)
    expect(collected).toHaveLength(2_400)
    expect(new Set(collected).size).toBe(2_400)
  })

  it("never evicts durable all-indicator configuration records under advisory pressure", async () => {
    const redis = new InlineLocalRedis()
    for (let index = 0; index < 150; index++) {
      await redis.set(`indication:connection:config:cfg-${index}`, JSON.stringify({ id: index }))
    }

    ;(redis as any).evictOldRecords()

    await expect(redis.get("indication:connection:config:cfg-0")).resolves.toContain('"id":0')
    await expect(redis.get("indication:connection:config:cfg-149")).resolves.toContain('"id":149')
  })

  it("reclaims expired TTL keys in bounded engine-safe slices", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-08-11T00:00:00.000Z"))
    const redis = new InlineLocalRedis()
    for (let index = 0; index < 25; index++) {
      await redis.set(`cooldown:${index}`, "1", { PX: 500 })
    }
    expect(await redis.dbSize()).toBe(25)

    jest.advanceTimersByTime(1_000)
    expect((redis as any).cleanupExpiredKeys(7)).toBe(7)
    expect(await redis.dbSize()).toBe(18)
    expect((redis as any).cleanupExpiredKeys(7)).toBe(7)
    expect(await redis.dbSize()).toBe(11)
    expect((redis as any).cleanupExpiredKeys(20)).toBe(11)
    expect(await redis.dbSize()).toBe(0)
  })

  it("moves an existing list member to the head without leaving duplicates", async () => {
    const redis = new InlineLocalRedis()
    await redis.rpush("open:index", "position-a", "position-b", "position-a")

    await upsertRedisListHead(redis, "open:index", "position-a")

    await expect(redis.lrange("open:index", 0, -1)).resolves.toEqual([
      "position-a",
      "position-b",
    ])
  })

  it("atomically moves a position from the open index to the closed head", async () => {
    const redis = new InlineLocalRedis()
    await redis.rpush("open:index", "position-a", "position-b", "position-a")
    await redis.rpush("closed:index", "position-c", "position-a")

    await moveRedisListMembershipToHead(
      redis,
      "open:index",
      "closed:index",
      "position-a",
    )

    await expect(redis.lrange("open:index", 0, -1)).resolves.toEqual([
      "position-b",
    ])
    await expect(redis.lrange("closed:index", 0, -1)).resolves.toEqual([
      "position-a",
      "position-c",
    ])
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
      // Exhaustive indication snapshots and Main fingerprints are deterministic
      // cache/projection products. They must not bloat restart snapshots; the
      // engine recreates them from durable config, market and outcome state.
      await writer.set("indications_snapshot:conn:BTCUSDT", "derived")
      await writer.sadd("indications_snapshot:index:conn", "BTCUSDT")
      await writer.hset("strategies:conn:BTCUSDT:main:fp:v3", { fp: "derived" })
      await writer.expire("indications_snapshot:conn:BTCUSDT", 60)

      await expect(writer.saveToDisk()).resolves.toBe(true)
      const snapshot = await readFile(snapshotPath, "utf8")
      expect(JSON.parse(snapshot.slice(0, snapshot.indexOf("\n")))).toMatchObject({
        v: 2,
        mutationVersion: expect.any(Number),
      })
      expect(snapshot).not.toContain("indications_snapshot:conn:BTCUSDT")
      expect(snapshot).not.toContain("indications_snapshot:index:conn")
      expect(snapshot).not.toContain("strategies:conn:BTCUSDT:main:fp:v3")

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)

      await expect(reader.get("string:persist")).resolves.toBe("value")
      await expect(reader.hgetall("hash:persist")).resolves.toEqual({ field: "value" })
      await expect(reader.smembers("set:persist")).resolves.toEqual(["member"])
      await expect(reader.lrange("list:persist", 0, -1)).resolves.toEqual(["first", "second"])
      await expect(reader.zscore("z:persist", "member")).resolves.toBe("10")
      await expect(reader.ttl("string:persist")).resolves.toBeGreaterThan(0)
      await expect(reader.get("indications_snapshot:conn:BTCUSDT")).resolves.toBeNull()
      await expect(reader.smembers("indications_snapshot:index:conn")).resolves.toEqual([])
      await expect(reader.hgetall("strategies:conn:BTCUSDT:main:fp:v3")).resolves.toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("treats an acquired engine lease as active before the first heartbeat", async () => {
    const redis = new InlineLocalRedis()
    expect((redis as any).hasActiveInlineEngineOwner()).toBe(false)

    await redis.set("engine_lock:paper-coordination", "engine-manager:paper-coordination:1700000000000")
    expect((redis as any).hasActiveInlineEngineOwner()).toBe(true)

    await redis.del("engine_lock:paper-coordination")
    await redis.hset("trade_engine:global", { actual_status: "starting" })
    expect((redis as any).hasActiveInlineEngineOwner()).toBe(true)
  })

  it("coalesces concurrent live-position checkpoints without losing recovery rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-live-wal-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      const count = 96
      await expect(Promise.all(Array.from({ length: count }, (_, index) =>
        writer.persistLivePositionCheckpoint({
          id: `paper-${index}`,
          connectionId: "paper-coordination",
          status: "simulated",
          version: 1,
          updatedAt: 1_700_000_000_000 + index,
        }),
      ))).resolves.toEqual(Array(count).fill(true))

      const lines = (await readFile(`${snapshotPath}.live-wal`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(lines).toHaveLength(count)
      expect(new Set(lines.map((line) => line.positionId)).size).toBe(count)
      expect((globalThis as any).__redis_live_position_wal_write_counter).toBe(count)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("streams large snapshots without materialising one aggregate JSON payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-stream-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      const payload = "x".repeat(32_768)
      for (let index = 0; index < 160; index++) {
        await writer.hset(`indication_set:stream:${index}`, {
          id: String(index),
          payload,
        })
      }
      await expect(writer.saveToDisk()).resolves.toBe(true)
      const snapshotStat = await stat(snapshotPath)
      expect(snapshotStat.size).toBeGreaterThan(5_000_000)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.hget("indication_set:stream:159", "payload")).resolves.toHaveLength(payload.length)
      await expect(reader.dbSize()).resolves.toBe(160)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps Direct-Trade runtime durable while omitting its reconstructible maximum grid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-direct-runtime-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.set("direct_trade:state", JSON.stringify({ enabled: false, minProfitFactor: 4 }))
      await writer.set("direct_trade:positions", JSON.stringify([{ id: "paper-open", status: "open" }]))
      await writer.set("direct_trade:open-position-stage", JSON.stringify({ counts: { total: 1 } }))
      await writer.set("direct_trade:configs:manifest", JSON.stringify({ generation: "large-grid" }))
      await writer.set("direct_trade:configs:chunk:large-grid:0", "x".repeat(1024 * 1024))
      await writer.set("direct_trade:statistics-index", JSON.stringify({ schemaVersion: 2, rows: [] }))
      await writer.set("direct_trade:calculation", JSON.stringify({ calculatedAt: "stale-generation" }))

      await expect(writer.persistNow()).resolves.toBe(true)
      expect((await stat(snapshotPath)).size).toBeLessThan(100_000)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.get("direct_trade:state")).resolves.toContain('"minProfitFactor":4')
      await expect(reader.get("direct_trade:positions")).resolves.toContain("paper-open")
      await expect(reader.get("direct_trade:open-position-stage")).resolves.toContain('"total":1')
      await expect(reader.get("direct_trade:configs:manifest")).resolves.toBeNull()
      await expect(reader.get("direct_trade:configs:chunk:large-grid:0")).resolves.toBeNull()
      await expect(reader.get("direct_trade:statistics-index")).resolves.toBeNull()
      await expect(reader.get("direct_trade:calculation")).resolves.toBeNull()
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

  it("replays a newer live-position WAL checkpoint after an abrupt crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-live-wal-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath
    const connectionId = "conn-live"
    const positionId = "live:conn-live:BTCUSDT:short:default:1"
    const hashKey = `live_positions:${connectionId}:${positionId}`
    const jsonKey = `live:position:${positionId}`

    try {
      const writer = new InlineLocalRedis()
      const baseline = {
        id: positionId,
        connectionId,
        symbol: "BTCUSDT",
        direction: "short",
        status: "simulated",
        version: 1,
        updatedAt: 100,
        quantity: 1,
        executedQuantity: 1,
        totalExecutedQuantity: 1,
      }
      await writer.hset(hashKey, baseline as any)
      await writer.set(jsonKey, JSON.stringify(baseline))
      await writer.lpush(`live:positions:${connectionId}`, positionId)
      await expect(writer.persistNow()).resolves.toBe(true)

      const latest = {
        ...baseline,
        version: 2,
        updatedAt: 200,
        quantity: 2,
        executedQuantity: 2,
        totalExecutedQuantity: 2,
        accumulatedSetKeys: ["base", "block:1"],
      }
      await writer.hset(hashKey, latest as any)
      await writer.set(jsonKey, JSON.stringify(latest))
      await expect(writer.persistLivePositionCheckpoint(latest)).resolves.toBe(true)

      // Simulate SIGKILL: drop every in-memory map without a full snapshot.
      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.hgetall(hashKey)).resolves.toMatchObject({
        version: "2",
        quantity: "2",
        executedQuantity: "2",
        totalExecutedQuantity: "2",
        accumulatedSetKeys: JSON.stringify(["base", "block:1"]),
      })
      const restoredMirror = JSON.parse((await reader.get(jsonKey)) || "{}")
      expect(restoredMirror).toMatchObject({
        liveMirrorVersion: 2,
        id: positionId,
        version: 2,
        quantity: 2,
        executedQuantity: 2,
        totalExecutedQuantity: 2,
        updatedAt: 200,
      })
      expect(restoredMirror).not.toHaveProperty("accumulatedSetKeys")
      await expect(reader.lrange(`live:positions:${connectionId}`, 0, -1)).resolves.toEqual([positionId])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("serializes concurrent critical snapshots and keeps the newest valid generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-concurrent-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      const barriers: Array<Promise<boolean>> = []
      for (let index = 0; index < 40; index++) {
        await writer.set("concurrent:latest", String(index))
        barriers.push(writer.persistNow())
      }
      await expect(Promise.all(barriers)).resolves.toEqual(Array(40).fill(true))

      const records = (await readFile(snapshotPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records[0]).toMatchObject({ v: 2 })
      expect(records.find((record) => record[0] === "s" && record[1] === "concurrent:latest")).toEqual([
        "s",
        "concurrent:latest",
        "39",
      ])
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
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

  it("keeps paper live-position checkpoints in memory in loopback-only Kilo Workerd preview", async () => {
    process.env.KILO_LOCAL_PREVIEW_INLINE_REDIS = "1"
    process.env.KILO_DEPLOYMENT = "1"
    process.env.CTS_DEPLOYMENT_RUNTIME = "kilo-deploy"
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:8787"
    process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = "0"

    const redis = new InlineLocalRedis()
    await redis.set("paper:checkpoint:mutation", "1")
    await expect(redis.persistLivePositionCheckpoint({
      id: "paper-live-position-1",
      connectionId: "bingx-x01",
      status: "simulated",
    })).resolves.toBe(true)

    expect((globalThis as any).__redis_live_position_wal_pending).toBeUndefined()
    expect((globalThis as any).__redis_live_position_wal_write_counter).toBeUndefined()
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

  it("persists and restores a versioned Kilo managed snapshot with an owned lease", async () => {
    process.env.DB_URL = "https://db.example.test/query"
    process.env.DB_TOKEN = "test-db-token"
    let stored: { revision: number; payload: string; updated_at: number; lease_owner?: string | null } | null = null
    const originalFetch = global.fetch
    global.fetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { sql: string; params: any[] }
      const sql = body.sql.replace(/\s+/g, " ").trim()
      let rows: any[] = []
      if (sql.startsWith("SELECT revision, payload")) {
        if (stored) rows = [{ ...stored }]
      } else if (sql.startsWith("INSERT INTO cts_runtime_snapshot")) {
        const [payload, updatedAt, expectedRevision] = body.params
        if (!stored) stored = { revision: 1, payload, updated_at: updatedAt }
        else if (stored.revision === expectedRevision) stored = { ...stored, revision: stored.revision + 1, payload, updated_at: updatedAt }
        if (stored && (stored.revision === 1 || stored.revision === Number(expectedRevision) + 1)) {
          rows = [{ revision: stored.revision }]
        }
      } else if (sql.includes("SET lease_owner = ?")) {
        if (stored && (!stored.lease_owner || stored.lease_owner === body.params[0])) {
          stored.lease_owner = body.params[0]
          rows = [{ lease_owner: stored.lease_owner }]
        }
      } else if (sql.includes("SET lease_owner = NULL")) {
        if (stored?.lease_owner === body.params[0]) stored.lease_owner = null
      }
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const writer = new InlineLocalRedis()
      await writer.hset("connection_settings:kilo", { symbols: "BTCUSDT", generation: "7" })
      await expect(writer.persistNow()).resolves.toBe(true)
      expect(stored?.revision).toBe(1)

      const lease = await writer.acquireSharedSnapshotLease("unit-test", 10_000, 0)
      expect(lease).toContain("unit-test:")
      await writer.releaseSharedSnapshotLease(String(lease))
      expect(stored?.lease_owner).toBeNull()

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)
      await expect(reader.hgetall("connection_settings:kilo")).resolves.toEqual({
        symbols: "BTCUSDT",
        generation: "7",
      })
    } finally {
      global.fetch = originalFetch
      delete process.env.DB_URL
      delete process.env.DB_TOKEN
    }
  })
})
