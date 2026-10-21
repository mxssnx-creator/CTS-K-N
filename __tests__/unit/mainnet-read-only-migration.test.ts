/** Migration 111 and the code-level gate keep BingX mainnet (X01) and Bybit read-only (AGENTS.md). */
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { evaluateRealTradeReadiness, isMainnetReadOnlyConnection } from "@/lib/real-trade-gates"

const credentialed = {
  api_key: "k".repeat(24), api_secret: "s".repeat(24),
  is_live_trade: "1", live_trade_requested: "1",
  is_preset_trade: "1", preset_trade_requested: "1",
  is_signal_trade: "1", signal_trade_requested: "1",
}

function resetRedisGlobals(): void {
  for (const key of ["__redis_data", "__redis_load_promise", "__redis_snapshot_loaded", "__redis_core_promise", "__redis_init_promise", "__redis_fully_connected", "__redis_backend", "__migration_run_promise", "__migrations_run", "__v0_devBootGuardDone"]) delete (globalThis as any)[key]
}

describe("mainnet read-only policy", () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  test("code gate blocks BingX mainnet and Bybit regardless of env flags and allow-list", () => {
    process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
    process.env.LIVE_ORDER_CONNECTION_IDS = "bingx-x01,bybit-x03"
    for (const settings of [
      { ...credentialed, id: "bingx-x01", exchange: "bingx", is_testnet: "0" },
      { ...credentialed, id: "bingx-x01", exchange: "bingx" },
      { ...credentialed, id: "bybit-x03", exchange: "bybit", is_testnet: "1" },
    ]) {
      expect(isMainnetReadOnlyConnection(settings)).toBe(true)
      expect(evaluateRealTradeReadiness(settings, "main")).toMatchObject({ canPlaceRealOrders: false, blockCode: "mainnet_read_only" })
      expect(evaluateRealTradeReadiness(settings, "preset")).toMatchObject({ canPlaceRealOrders: false, blockCode: "mainnet_read_only" })
      expect(evaluateRealTradeReadiness(settings, "signal")).toMatchObject({ canPlaceRealOrders: false, blockCode: "mainnet_read_only" })
    }
  })

  test("BingX Prod-VST is not caught by the gate", () => {
    expect(isMainnetReadOnlyConnection({ exchange: "bingx", is_testnet: "1" })).toBe(false)
  })

  test("migration 111 clears the live flags on existing X01/Bybit hashes only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mainnet-read-only-"))
    process.env = { ...saved, NODE_ENV: "test", V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json") }
    delete process.env.BINGX_API_KEY
    delete process.env.BINGX_API_SECRET
    resetRedisGlobals()
    jest.resetModules()
    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.hset("connection:bingx-x01", { id: "bingx-x01", exchange: "bingx", is_live_trade: "1", live_trade_enabled: "1", live_trade_requested: "1", name: "keep" })
      await client.hset("connection:bingx-x02", { id: "bingx-x02", exchange: "bingx", is_testnet: "1", is_live_trade: "1" })
      await client.set("_schema_version", "110")
      await client.set("_migrations_run", "true")
      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 111 })
      expect(await client.hgetall("connection:bingx-x01")).toMatchObject({ is_live_trade: "0", live_trade_enabled: "0", live_trade_requested: "0", name: "keep" })
      expect(await client.hget("connection:bingx-x02", "is_live_trade")).toBe("1")
      expect(await client.hget("connection:bybit-x03", "is_live_trade")).not.toBe("1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
