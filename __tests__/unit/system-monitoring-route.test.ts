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
      client.del(`realtime:${connectionId}`),
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
      }),
      client.sadd("connections", connectionId),
      client.sadd("connections:main:enabled", connectionId),
      client.hset(`progression:${connectionId}:main`, {
        indication_cycle_count: "11",
        strategy_cycle_count: "9",
        realtime_cycle_count: "13",
      }),
      client.hset(`settings:trade_engine_state:${connectionId}:main`, {
        status: "running",
        realtime_cycle_count: "13",
      }),
      client.hset(`realtime:${connectionId}`, { cycle_count: "13" }),
    ])

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.services.tradeEngine).toBe(true)
    expect(body.engines.indications.cycleCount).toBeGreaterThanOrEqual(13)
    expect(body.engines.strategies.cycleCount).toBeGreaterThanOrEqual(13)
    expect(body.database.requestsPerSecond).toBeGreaterThan(0)
  })
})
