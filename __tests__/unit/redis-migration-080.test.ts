import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

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
  ]) delete (globalThis as any)[key]
}

describe("migrations 080/081 exact Set indexes and Block PF defaults", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    jest.resetModules()
  })

  test("backfills lifetime/active/closed indexes, O(1) totals, and canonical Previous windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-080-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-ledger")
      await client.hset("connection:conn-ledger", {
        id: "conn-ledger",
        name: "Ledger",
        exchange: "bingx",
        is_enabled_dashboard: "0",
      })
      await client.hset("strategy_set_entry_counts:conn-ledger", { "set:a": "2", "set:b": "1" })
      await client.hset("strategy_set_active_entry_counts:conn-ledger", { "set:a": "1" })
      await client.hset("strategy_set_closed_counts:conn-ledger", { "set:a": "1", "set:b": "1" })
      await client.hset("axis_pos_acc:conn-ledger", { "parent|axis:a": "7" })
      await client.hset("connection_settings:conn-ledger", {
        axisPrevMaxWindow: "5",
        blockProfitFactorRatio: "1.7",
      })
      await client.hset("settings:connection_settings:conn-ledger", { axisPrevMaxWindow: "11" })
      await client.set("_schema_version", "79")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 81 })

      expect(await client.get("_schema_version")).toBe("81")
      expect(new Set(await client.smembers("strategy_set_keys:conn-ledger"))).toEqual(new Set(["set:a", "set:b"]))
      expect(await client.smembers("strategy_active_set_keys:conn-ledger")).toEqual(["set:a"])
      expect(new Set(await client.smembers("strategy_closed_set_keys:conn-ledger"))).toEqual(new Set(["set:a", "set:b"]))
      expect(await client.hgetall("strategy_ledger_totals:conn-ledger")).toMatchObject({
        exact_entries: "3",
        axis_entries: "7",
        active_memberships: "1",
        exact_closed: "2",
      })
      expect(await client.hget("connection_settings:conn-ledger", "axisPrevMaxWindow")).toBe("4")
      expect(await client.hget("settings:connection_settings:conn-ledger", "axisPrevMaxWindow")).toBe("10")
      expect(await client.hget("connection_settings:conn-ledger", "blockProfitFactorRatio")).toBe("1.7")
      expect(await client.hget("settings:connection_settings:conn-ledger", "blockProfitFactorRatio")).toBe("0.8")
      expect(await client.hget("system:database:coordination:performance", "inline_snapshot_interval_ms")).toBe("60000")
      expect(await client.hget("system:database:coordination:performance", "independent_block_profit_factor"))
        .toBe("default-pf-x-ratio-x-volume-increment-v1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
