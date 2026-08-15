import { GET } from "@/app/api/system/monitoring/route"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("system monitoring route", () => {
  const connectionId = `monitoring-test-${process.pid}`

  afterAll(async () => {
    const client = getRedisClient()
    await Promise.all([
      client.del(`connection:${connectionId}`),
      client.del(`progression:${connectionId}:main`),
      client.del(`settings:trade_engine_state:${connectionId}:main`),
      client.del(`engine_is_running:${connectionId}`),
      client.del(`realtime:${connectionId}`),
      client.del(`indication_sets:index:${connectionId}`),
      client.del(`indication_sets:outcome_keys:index:${connectionId}`),
      client.srem("connections", connectionId),
      client.srem("connections:main:enabled", connectionId),
    ])
  })

  test("discovers indexed scoped engines and reports their canonical cycles", async () => {
    await initRedis()
    const client = getRedisClient()
    await Promise.all([
      client.hset(`connection:${connectionId}`, {
        id: connectionId,
        name: "Monitoring route test",
        exchange: "bingx",
        engine_type: "main",
        is_enabled_dashboard: "1",
      }),
      client.sadd("connections", connectionId),
      client.sadd("connections:main:enabled", connectionId),
      client.hset(`progression:${connectionId}:main`, {
        indication_cycle_count: "11",
        strategy_cycle_count: "9",
        realtime_cycle_count: "13",
        live_positions_cycle_count: "17",
      }),
      client.hset(`settings:trade_engine_state:${connectionId}:main`, {
        status: "running",
        last_processor_heartbeat: String(Date.now()),
        realtime_cycle_count: "13",
      }),
      client.set(`engine_is_running:${connectionId}`, "1"),
      client.hset(`realtime:${connectionId}`, { cycle_count: "13" }),
      client.sadd(`indication_sets:index:${connectionId}`, "indication-set-a", "indication-set-b"),
      client.sadd(
        `indication_sets:outcome_keys:index:${connectionId}`,
        "indication-set-a:outcomes",
        "indication-set-a:outcome_stats",
      ),
    ])

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.services.tradeEngine).toBe(true)
    expect(body.engines.indications.cycleCount).toBeGreaterThanOrEqual(11)
    expect(body.engines.strategies.cycleCount).toBeGreaterThanOrEqual(9)
    expect(body.engines.realtime.cycleCount).toBeGreaterThanOrEqual(17)
    expect(body.database.requestsPerSecond).toBeGreaterThan(0)
    expect(body.database.indicationSetInventoryKeys).toBeGreaterThanOrEqual(2)
    expect(body.database.indicationOutcomeAuxiliaryKeys).toBeGreaterThanOrEqual(2)
  })
})
