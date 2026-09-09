import { getRedisClient, initRedis, setSettings } from "@/lib/redis-db"

describe("engine state settings mirror", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test"
    process.env.REDIS_URL = ""
    process.env.KV_URL = ""
    process.env.UPSTASH_REDIS_REST_URL = ""
    process.env.KV_REST_API_URL = ""
    await initRedis()
    await getRedisClient().flushDb()
  })

  test("mirrors legacy trade-engine state updates into the scoped Main hash", async () => {
    await getRedisClient().hset("trade_engine_state:bingx-x02", {
      pause_requested: "1",
      pause_reason: "global_coordinator",
      paused_by: "global_coordinator",
      stopped_at: "2026-09-09T14:00:00.000Z",
      operator_stopped_at: "2026-09-09T14:00:00.000Z",
    })
    await setSettings("trade_engine_state:bingx-x02", {
      status: "running",
      prehistoric_bootstrap_status: "complete",
      prehistoric_data_loaded: true,
      entry_processors_gated: false,
      engine_ready: true,
      updated_at: "2026-09-09T15:30:00.000Z",
    })

    await expect(getRedisClient().hgetall("settings:trade_engine_state:bingx-x02:main")).resolves.toMatchObject({
      status: "running",
      prehistoric_bootstrap_status: "complete",
      prehistoric_data_loaded: "1",
      entry_processors_gated: "0",
      engine_ready: "1",
      updated_at: "2026-09-09T15:30:00.000Z",
    })
    await expect(getRedisClient().hgetall("trade_engine_state:bingx-x02")).resolves.not.toHaveProperty("pause_requested")
    await expect(getRedisClient().hgetall("trade_engine_state:bingx-x02")).resolves.not.toHaveProperty("stopped_at")
    await expect(getRedisClient().hgetall("trade_engine_state:bingx-x02")).resolves.not.toHaveProperty("operator_stopped_at")
    await expect(getRedisClient().hgetall("settings:trade_engine_state:bingx-x02:main")).resolves.not.toHaveProperty("pause_reason")
    await expect(getRedisClient().hgetall("settings:trade_engine_state:bingx-x02:main")).resolves.not.toHaveProperty("stopped_at")
    await expect(getRedisClient().hgetall("settings:trade_engine_state:bingx-x02:main")).resolves.not.toHaveProperty("operator_stopped_at")
  })

  test("does not mirror unrelated settings or engine-type-specific keys", async () => {
    await setSettings("app_settings", { foo: "bar" })
    await setSettings("trade_engine_state:bingx-x02:live", { status: "running" })

    await expect(getRedisClient().exists("settings:app_settings:main")).resolves.toBe(0)
    await expect(getRedisClient().exists("settings:trade_engine_state:bingx-x02:live:main")).resolves.toBe(0)
  })
})
