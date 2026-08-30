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
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 105 })

      const prefix = "direct_trade:connection:bingx-custom-v100"
      expect(JSON.parse(String(await client.get(`${prefix}:state`)))).toMatchObject({
        enabled: true,
        liveMode: true,
        connectionId: "bingx-custom-v100",
        lastRecalcAt: null,
        connectionScopeMigrationVersion: 100,
        minVolFactor: 0.1,
        trailingMinTakeProfitRatio: 5,
        processingIntervalMs: 280,
        directTradeExecutionDefaultsVersion: 1,
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

  test("schema 101 upgrades only bounded execution defaults and keeps explicit cadence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-101-direct-defaults-"))
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
      await client.set("direct_trade:connection:bounded:state", JSON.stringify({
        enabled: true,
        minVolFactor: 99,
        trailingMinStep: 4.6,
        processingIntervalMs: 500,
        minProfitFactor: 4,
        minRecentProfitFactor: 25,
        fullHistoryPfDefaultsVersion: 1,
      }))
      await client.set("direct_trade:connection:custom-cadence:state", JSON.stringify({
        enabled: false,
        minVolFactor: 0,
        processingIntervalMs: 333,
        minProfitFactor: 1.17,
        minRecentProfitFactor: 1.29,
      }))
      await client.hset("app_settings", {
        baseProfitFactor: "1",
        mainProfitFactor: "1.111",
        profitFactorMinPreset: "0.7",
        connection_settings: JSON.stringify({
          profitFactorMin: { base: 1.01, main: 1.13, real: 2.8, live: 1.1 },
          measured: { profitFactor: 0.5 },
        }),
      })
      await client.set("_schema_version", "100")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 105 })

      expect(JSON.parse(String(await client.get("direct_trade:connection:bounded:state"))))
        .toMatchObject({
          enabled: true,
          minVolFactor: 0.1,
          trailingMinTakeProfitRatio: 5,
          processingIntervalMs: 280,
          directTradeExecutionDefaultsVersion: 1,
          minProfitFactor: 1.1,
          minRecentProfitFactor: 1.1,
          fullHistoryPfDefaultsVersion: 2,
        })
      expect(JSON.parse(String(await client.get("direct_trade:connection:custom-cadence:state"))))
        .toMatchObject({
          enabled: false,
          minVolFactor: 0.1,
          trailingMinTakeProfitRatio: 5,
          processingIntervalMs: 333,
          directTradeExecutionDefaultsVersion: 1,
          minProfitFactor: 1.18,
          minRecentProfitFactor: 1.3,
          fullHistoryPfDefaultsVersion: 2,
        })
      expect(await client.hget("system:database:coordination:performance", "schema_version")).toBe("105")
      expect(await client.hget("system:database:coordination:performance", "direct_trade_effective_volume_ratio")).toBe("0.2")
      expect(await client.hget("app_settings", "baseProfitFactor")).toBe("1.02")
      expect(await client.hget("app_settings", "mainProfitFactor")).toBe("1.12")
      expect(await client.hget("app_settings", "profitFactorMinPreset")).toBe("1.02")
      expect(JSON.parse(String(await client.hget("app_settings", "connection_settings"))))
        .toEqual({
          profitFactorMin: { base: 1.02, main: 1.14, real: 2.3, live: 1.1 },
          measured: { profitFactor: 0.5 },
        })
      expect(await client.hget("system:database:coordination:performance", "main_trade_pf_selection_range"))
        .toBe("1.02-2.30")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("schema 102 disables only inactive auto-injected mainnet live state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-102-credential-live-safety-"))
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
      await client.sadd("connections", "bingx-x01", "bingx-x02", "operator-live")
      await client.sadd("connections:main:enabled", "bingx-x01", "bingx-x02", "operator-live")
      await client.hset("connection:bingx-x01", {
        id: "bingx-x01",
        name: "BingX X01",
        exchange: "bingx",
        is_assigned: "1",
        is_enabled_dashboard: "0",
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_enabled: "1",
        state_switch_action: "credential_injection",
      })
      await client.hset("connection:bingx-x02", {
        id: "bingx-x02",
        name: "BingX X02",
        exchange: "bingx",
        is_testnet: "1",
        is_assigned: "1",
        is_enabled_dashboard: "1",
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_enabled: "1",
        state_switch_action: "production_vst_credential_injection",
      })
      await client.hset("connection:operator-live", {
        id: "operator-live",
        name: "Operator Live",
        exchange: "bingx",
        is_assigned: "1",
        is_enabled_dashboard: "0",
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_enabled: "1",
        state_switch_action: "live_trade_enable",
      })
      await client.set("_schema_version", "101")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 105 })

      await expect(client.hgetall("connection:bingx-x01")).resolves.toMatchObject({
        is_live_trade: "0",
        live_trade_requested: "0",
        live_trade_enabled: "0",
        state_switch_action: "credential_injection_safety_normalized",
      })
      await expect(client.hgetall("connection:bingx-x02")).resolves.toMatchObject({
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_enabled: "1",
      })
      await expect(client.hgetall("connection:operator-live")).resolves.toMatchObject({
        is_live_trade: "1",
        state_switch_action: "live_trade_enable",
      })
      await expect(client.smembers("connections:main:enabled")).resolves.toEqual(["bingx-x02"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
