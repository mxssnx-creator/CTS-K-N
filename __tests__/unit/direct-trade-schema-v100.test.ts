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
    "__v0_devBootGuardDone",
  ]) delete (globalThis as any)[key]
}

describe("migration 100 Direct-Trade scopes and operational PF thresholds", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    jest.resetModules()
  })

  test("adopts a legacy live scope without deleting recovery evidence or mixing settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-100-direct-scope-"))
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
      await client.sadd("connections", "bingx-custom-v100")
      await client.hset("connection:bingx-custom-v100", {
        id: "bingx-custom-v100",
        name: "Scoped migration",
        exchange: "bingx",
      })
      await client.hset("connection_settings:bingx-custom-v100", {
        profitFactorMinPreset: "0.7",
        strategy_min_profit_factor: "0.5",
        blockProfitFactorRatio: "0.8",
        connection_settings: JSON.stringify({
          profitFactorMin: { base: 0.9, main: 0.9, real: 0.9, live: 0.9 },
          measured: { profitFactor: 0.5 },
        }),
      })
      await client.set("direct_trade:state", JSON.stringify({
        enabled: true,
        liveMode: true,
        connectionId: "bingx-custom-v100",
        lastRecalcAt: "2026-08-01T00:00:00.000Z",
      }))
      await client.set("direct_trade:positions", JSON.stringify([{
        id: "dt-open-1",
        status: "open",
        exchangeOrderId: "venue-order-1",
        symbol: "BTCUSDT",
      }]))
      await client.set("direct_trade:stats", JSON.stringify({ totalOrders: 1 }))
      await client.set("direct_trade:calculation", JSON.stringify({ symbols: ["BTCUSDT"] }))
      await client.set("_schema_version", "99")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 100 })

      const prefix = "direct_trade:connection:bingx-custom-v100"
      expect(JSON.parse(String(await client.get(`${prefix}:state`)))).toMatchObject({
        enabled: true,
        liveMode: true,
        connectionId: "bingx-custom-v100",
        lastRecalcAt: null,
        connectionScopeMigrationVersion: 100,
      })
      expect(JSON.parse(String(await client.get(`${prefix}:positions`)))).toEqual([
        expect.objectContaining({ id: "dt-open-1", exchangeOrderId: "venue-order-1" }),
      ])
      expect(JSON.parse(String(await client.get(`${prefix}:stats`)))).toMatchObject({ totalOrders: 1 })
      expect(await client.get(`${prefix}:calculation`)).toBeNull()
      expect(JSON.parse(String(await client.get(`${prefix}:calculation-progress`)))).toMatchObject({
        status: "rebuild-required",
        connectionId: "bingx-custom-v100",
      })
      expect(await client.sismember("direct_trade:connections", "bingx-custom-v100")).toBe(1)
      // Legacy evidence remains available for rollback and manual recovery.
      expect(await client.get("direct_trade:positions")).not.toBeNull()
      expect(await client.get("direct_trade:calculation")).not.toBeNull()

      expect(await client.hget("connection_settings:bingx-custom-v100", "profitFactorMinPreset")).toBe("1.1")
      expect(await client.hget("connection_settings:bingx-custom-v100", "strategy_min_profit_factor")).toBe("1.1")
      expect(await client.hget("connection_settings:bingx-custom-v100", "blockProfitFactorRatio")).toBe("0.8")
      expect(JSON.parse(String(
        await client.hget("connection_settings:bingx-custom-v100", "connection_settings"),
      ))).toMatchObject({
        profitFactorMin: { base: 1.1, main: 1.1, real: 1.1, live: 1.1 },
        measured: { profitFactor: 0.5 },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
