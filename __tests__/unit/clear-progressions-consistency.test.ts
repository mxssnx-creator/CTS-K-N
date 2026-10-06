/**
 * H6: "Reset DB" must be consistent. Each connection's progression hashes
 * (legacy and engine-scoped) and logs are cleared with the rest of the
 * runtime state, while the real trading records (live position rows, their
 * indexes, the results ledger) and keys of co-located projects survive.
 */
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { matchesRedisGlob } from "@/lib/redis-scan"

jest.mock("@/lib/admin-auth", () => ({
  authorizeAdminRequest: jest.fn().mockResolvedValue({ ok: true }),
}))
jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: () => ({ stopAll: jest.fn(async () => undefined) }),
}))
jest.mock("@/lib/system-logger", () => ({
  SystemLogger: {
    logTradeEngine: jest.fn().mockResolvedValue(undefined),
    logError: jest.fn().mockResolvedValue(undefined),
  },
}))

function resetRedisGlobals(): void {
  for (const key of [
    "__redis_data",
    "__redis_load_promise",
    "__redis_snapshot_loaded",
    "__redis_core_promise",
    "__redis_init_promise",
    "__redis_fully_connected",
    "__redis_backend",
    "__migration_run_promise",
    "__migrations_run",
    "__v0_devBootGuardDone",
  ]) delete (globalThis as any)[key]
}

const ID = "bingx-x02"

describe("Reset DB keeps trading records and clears progression consistently", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    jest.resetModules()
  })

  test("in-process Redis: progression cleared, live rows and results ledger preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clear-progressions-consistency-"))
    process.env = { ...originalEnv, NODE_ENV: "test", V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json") }
    resetRedisGlobals()
    jest.resetModules()
    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.set("_schema_version", "102")
      await client.set("_migrations_run", "true")
      await client.sadd("connections", ID)
      await client.hset(`connection:${ID}`, { id: ID, name: "X02", exchange: "bingx" })
      // Progression counters / logs of the connection (scoped and legacy).
      await client.hset(`progression:${ID}`, { cycles_completed: "500", strategies_real_total: "90" })
      await client.hset(`progression:${ID}:main`, { indication_cycle_count: "480", strategies_real_total: "90" })
      await client.hset(`progression:${ID}:main:history:1`, { cycles_completed: "12" })
      await client.lpush(`progression:${ID}:logs`, JSON.stringify({ message: "old session" }))
      await client.hset("progression:index", { total_connections: "1" })
      // Runtime stage rows.
      await client.hset(`strategy_detail:${ID}:real`, { "s:BTCUSDT:created": "3" })
      // Real trading records and their indexes.
      await client.hset(`live_positions:${ID}:pos-1`, { id: "pos-1", status: "closed", symbol: "BTCUSDT" })
      await client.set("live:position:pos-1", JSON.stringify({ id: "pos-1", status: "closed" }))
      await client.lpush(`live:positions:${ID}:closed`, "pos-1")
      await client.hset(`results:ledger:v3:${ID}:entries`, { "pos-1": JSON.stringify({ id: "pos-1" }) })
      await client.hset(`results:ledger:v3:${ID}:meta`, { complete: "1", keys: "1" })
      await client.sadd(`results:ledger:v3:${ID}:ids`, "pos-1")
      // Settled real results per Set (exchange-only rings).
      await client.lpush(`strategy_set_live_ring:${ID}:BTCUSDT:direction:long`, "1|0|0|1|0.1")
      await client.sadd(`strategy_set_live_close_ids:${ID}`, "pos-1|BTCUSDT:direction:long")
      await client.hset(`strategy_set_live_closed_counts:${ID}`, { "BTCUSDT:direction:long": "1" })
      // Another project on the same Redis DB.
      await client.set("cts-ga:state", "foreign")

      const { POST } = await import("@/app/api/admin/clear-progressions/route")
      const response = await POST(new Request("http://localhost/api/admin/clear-progressions", { method: "POST" }))
      const payload = await response.json()

      expect(response.status).toBe(200)
      expect(payload.success).toBe(true)
      expect(payload.progressionKeysCleared).toBe(4)
      expect(await client.hgetall(`progression:${ID}`)).toEqual({})
      expect(await client.hgetall(`progression:${ID}:main`)).toEqual({})
      expect(await client.hgetall(`progression:${ID}:main:history:1`)).toEqual({})
      expect(await client.lrange(`progression:${ID}:logs`, 0, -1)).toEqual([])
      expect(await client.hgetall(`strategy_detail:${ID}:real`)).toEqual({})
      // Global progression metadata stays.
      expect(await client.hgetall("progression:index")).toEqual({ total_connections: "1" })
      // The index and the rows it points at both survive.
      expect(await client.lrange(`live:positions:${ID}:closed`, 0, -1)).toEqual(["pos-1"])
      expect(await client.hgetall(`live_positions:${ID}:pos-1`)).toMatchObject({ id: "pos-1", status: "closed" })
      expect(await client.get("live:position:pos-1")).not.toBeNull()
      expect(await client.hgetall(`results:ledger:v3:${ID}:entries`)).toHaveProperty("pos-1")
      expect(await client.hgetall(`results:ledger:v3:${ID}:meta`)).toMatchObject({ complete: "1" })
      expect(await client.sismember(`results:ledger:v3:${ID}:ids`, "pos-1")).toBe(1)
      expect(await client.lrange(`strategy_set_live_ring:${ID}:BTCUSDT:direction:long`, 0, -1)).toEqual(["1|0|0|1|0.1"])
      expect(await client.sismember(`strategy_set_live_close_ids:${ID}`, "pos-1|BTCUSDT:direction:long")).toBe(1)
      expect(await client.hgetall(`strategy_set_live_closed_counts:${ID}`)).toEqual({ "BTCUSDT:direction:long": "1" })
      expect(await client.get("cts-ga:state")).toBe("foreign")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("external Redis adapter: the scan-and-delete path keeps the same protected keys", async () => {
    const store = new Map<string, string>([
      [`progression:${ID}`, "h"],
      [`progression:${ID}:main`, "h"],
      [`progression:${ID}:logs`, "l"],
      ["progression:index", "h"],
      [`strategy_detail:${ID}:base`, "h"],
      [`prehistoric:${ID}:main`, "h"],
      [`live_positions:${ID}:pos-1`, "h"],
      [`live:positions:${ID}`, "l"],
      [`results:ledger:v3:${ID}:entries`, "h"],
      [`connection:${ID}`, "h"],
      ["cts-ga:engine", "s"],
      ["cts-g:lock", "s"],
    ])
    const client = {
      keys: async (pattern: string) => [...store.keys()].filter((key) => matchesRedisGlob(key, pattern)),
      del: async (...keys: string[]) => keys.reduce((n, key) => n + (store.delete(key) ? 1 : 0), 0),
      exists: async () => 0,
      get: async () => null,
      set: async () => "OK",
      hset: async () => 1,
      sadd: async () => 1,
      incr: async () => 1,
      incrby: async () => 1,
      dbSize: async () => store.size,
    }
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn(async () => undefined),
      getRedisClient: () => client,
      getAllConnections: jest.fn(async () => [{ id: ID }]),
      updateConnectionState: jest.fn(async () => undefined),
      protectedRedisKeyPrefixes: () => ["cts-ga:", "cts-g:"],
    }))

    const { POST } = await import("@/app/api/admin/clear-progressions/route")
    const response = await POST(new Request("http://localhost/api/admin/clear-progressions", { method: "POST" }))
    expect(response.status).toBe(200)

    expect([...store.keys()].sort()).toEqual([
      "cts-g:lock",
      "cts-ga:engine",
      `connection:${ID}`,
      `live:positions:${ID}`,
      `live_positions:${ID}:pos-1`,
      "progression:index",
      `results:ledger:v3:${ID}:entries`,
    ].sort())
  })
})
