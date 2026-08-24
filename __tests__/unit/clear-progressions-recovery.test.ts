import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const stopAllMock = jest.fn()

jest.mock("@/lib/admin-auth", () => ({
  authorizeAdminRequest: jest.fn().mockResolvedValue({ ok: true }),
}))
jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: () => ({ stopAll: stopAllMock }),
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

describe("Reset DB Direct-Trade recovery contract", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    stopAllMock.mockReset()
    jest.resetModules()
  })

  test("clears calculations and closed rows while preserving open venue tracking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clear-progressions-recovery-"))
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
      await client.set("_schema_version", "101")
      await client.set("_migrations_run", "true")
      await client.sadd("connections", "bingx-x02")
      await client.hset("connection:bingx-x02", {
        id: "bingx-x02",
        name: "BingX X02",
        exchange: "bingx",
        api_key: "credential-preserved",
        api_secret: "secret-preserved",
        is_enabled_dashboard: "1",
      })
      await client.hset("connection_settings:bingx-x02", {
        settings_version: "x02-settings-generation-1",
        processingIntervalMs: "280",
        strategyBaseTrailingEnabled: "true",
      })
      const prefix = "direct_trade:connection:bingx-x02"
      await client.sadd("direct_trade:connections", "bingx-x02")
      await client.set(`${prefix}:state`, JSON.stringify({
        enabled: true,
        liveMode: true,
        connectionId: "bingx-x02",
      }))
      await client.set(`${prefix}:positions`, JSON.stringify([
        { id: "open-1", status: "open", exchangeOrderId: "entry-1", stopLossOrderId: "sl-1" },
        { id: "opening-1", status: "opening", clientOrderId: "client-1" },
        { id: "closed-1", status: "closed", realizedPnlUsdt: 12.3 },
      ]))
      await client.set(`${prefix}:stats`, JSON.stringify({ totalPnlUsdt: 12.3 }))
      await client.set(`${prefix}:calculation`, JSON.stringify({ symbols: ["BTCUSDT"] }))
      await client.set(`${prefix}:processor:lease`, "old-owner")

      const { POST } = await import("@/app/api/admin/clear-progressions/route")
      const response = await POST(new Request("http://localhost/api/admin/clear-progressions", { method: "POST" }))
      const payload = await response.json()

      expect(response.status).toBe(200)
      expect(payload).toMatchObject({
        success: true,
        directTradeRecoveryScopes: 1,
        directTradeOpenPositionsPreserved: 2,
      })
      expect(stopAllMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(await client.get(`${prefix}:state`)))).toMatchObject({
        enabled: false,
        liveMode: true,
        resetRecoveryPending: true,
      })
      expect(JSON.parse(String(await client.get(`${prefix}:positions`)))).toEqual([
        expect.objectContaining({ id: "open-1", exchangeOrderId: "entry-1", stopLossOrderId: "sl-1" }),
        expect.objectContaining({ id: "opening-1", clientOrderId: "client-1" }),
      ])
      expect(await client.get(`${prefix}:stats`)).toBeNull()
      expect(await client.get(`${prefix}:calculation`)).toBeNull()
      expect(await client.get(`${prefix}:processor:lease`)).toBeNull()
      expect(await client.sismember("direct_trade:connections", "bingx-x02")).toBe(1)
      expect(await client.hget("connection:bingx-x02", "api_key")).toBe("credential-preserved")
      expect(await client.hget("connection:bingx-x02", "api_secret")).toBe("secret-preserved")
      expect(await client.hgetall("connection_settings:bingx-x02")).toMatchObject({
        settings_version: "x02-settings-generation-1",
        processingIntervalMs: "280",
        strategyBaseTrailingEnabled: "true",
      })
      expect(await client.hget("trade_engine:global", "status")).toBe("stopped")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
