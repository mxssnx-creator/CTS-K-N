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

describe("BingX environment migration safety", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    jest.resetModules()
  })

  test("credentials never flip an existing Prod-VST connection to mainnet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bingx-vst-migration-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
      BINGX_API_KEY: "vst-api-key-long-enough",
      BINGX_API_SECRET: "vst-api-secret-long-enough",
    }
    delete process.env.BINGX_ENVIRONMENT
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "bingx-x01")
      await client.hset("connection:bingx-x01", {
        id: "bingx-x01",
        name: "BingX Demo",
        exchange: "bingx",
        api_type: "perpetual_futures",
        api_key: "old-demo-api-key",
        api_secret: "old-demo-api-secret",
        is_testnet: "1",
        is_enabled_dashboard: "0",
      })
      await client.set("_schema_version", "98")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })

      expect(await client.hget("connection:bingx-x01", "is_testnet")).toBe("1")
      expect(await client.hget("connection:bingx-x01", "api_key")).toBe("vst-api-key-long-enough")
      expect(await client.hget("connection:bingx-x01", "api_secret")).toBe("vst-api-secret-long-enough")

      process.env.BINGX_ENVIRONMENT = "prod-live"
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })
      expect(await client.hget("connection:bingx-x01", "is_testnet")).toBe("0")

      process.env.BINGX_ENVIRONMENT = "prod-vst"
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })
      expect(await client.hget("connection:bingx-x01", "is_testnet")).toBe("1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an explicit Prod-VST environment seeds new BingX connections as demo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bingx-vst-seed-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
      BINGX_ENVIRONMENT: "prod-vst",
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.set("_schema_version", "98")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })
      expect(await client.hget("connection:bingx-x01", "is_testnet")).toBe("1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("X02 remains Prod-VST and its credentials never leak into X01", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bingx-x02-seed-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
      BINGX_ENVIRONMENT: "prod-live",
      BINGX_X02_API_KEY: "x02-vst-api-key-long-enough",
      BINGX_X02_API_SECRET: "x02-vst-api-secret-long-enough",
    }
    delete process.env.BINGX_API_KEY
    delete process.env.BINGX_API_SECRET
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })

      expect(await client.hget("connection:bingx-x02", "is_testnet")).toBe("1")
      expect(await client.hget("connection:bingx-x02", "is_predefined")).toBe("1")
      expect(await client.hget("connection:bingx-x02", "environment")).toBe("prod-vst")
      expect(await client.hget("connection:bingx-x02", "base_url")).toBe("https://open-api-vst.bingx.com")
      expect(await client.hget("connection:bingx-x02", "api_key")).toBe("x02-vst-api-key-long-enough")
      expect(await client.hget("connection:bingx-x02", "api_secret")).toBe("x02-vst-api-secret-long-enough")
      expect(await client.hget("connection:bingx-x01", "is_testnet")).toBe("0")
      expect(await client.hget("connection:bingx-x01", "api_key")).toBe("")
      expect(await client.hget("connection:bingx-x01", "api_secret")).toBe("")

      // Re-running the idempotent base seeder must preserve the isolation.
      const seeder = await import("@/lib/default-exchanges-seeder")
      seeder.resetSeedingFlag()
      await seeder.ensureDefaultExchangesExist()
      expect(await client.hget("connection:bingx-x01", "api_key")).toBe("")
      expect(await client.hget("connection:bingx-x01", "api_secret")).toBe("")

      process.env.BINGX_ENVIRONMENT = "prod-live"
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 103 })
      expect(await client.hget("connection:bingx-x02", "is_testnet")).toBe("1")
      expect(await client.hget("connection:bingx-x02", "environment")).toBe("prod-vst")
      expect(await client.hget("connection:bingx-x02", "base_url")).toBe("https://open-api-vst.bingx.com")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
