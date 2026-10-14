import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { GET } from "@/app/api/trade-engine/detailed-logs/route"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("detailed logging position counts", () => {
  const connectionId = `detailed-logs-${process.pid}`
  const keys = [
    `connection:${connectionId}`,
    `pseudo_positions:${connectionId}`,
    `pseudo_positions:${connectionId}:active_by_direction:long`,
    `pseudo_positions:${connectionId}:active_by_direction:long:signal_trailing`,
    `pseudo_positions:${connectionId}:active_by_direction:short`,
    `live:positions:${connectionId}`,
    `prehistoric:${connectionId}:main`,
    // Legacy keys that the running engine never writes; they must not count.
    `base_pseudo:${connectionId}`,
    `positions:${connectionId}:live`,
    `intervals:${connectionId}:processed_count`,
  ]

  afterAll(async () => {
    const client = getRedisClient()
    await Promise.all([...keys.map((key) => client.del(key)), client.srem("connections", connectionId)])
  })

  test("counts come from the PseudoPositionManager and LiveStage indexes with cardinality reads", async () => {
    await initRedis()
    const client = getRedisClient()
    await Promise.all([
      client.hset(`connection:${connectionId}`, {
        id: connectionId,
        name: "Detailed logs test",
        exchange: "bingx",
        engine_type: "main",
      }),
      client.sadd("connections", connectionId),
      client.sadd(`pseudo_positions:${connectionId}`, "p1", "p2", "p3"),
      client.sadd(`pseudo_positions:${connectionId}:active_by_direction:long`, "p1"),
      client.sadd(`pseudo_positions:${connectionId}:active_by_direction:long:signal_trailing`, "p2"),
      client.sadd(`pseudo_positions:${connectionId}:active_by_direction:short`, "p3"),
      client.rpush(`live:positions:${connectionId}`, "l1", "l2"),
      client.hset(`prehistoric:${connectionId}:main`, { intervals_processed: "120" }),
      client.sadd(`base_pseudo:${connectionId}`, "legacy-1", "legacy-2", "legacy-3", "legacy-4"),
      client.sadd(`positions:${connectionId}:live`, "legacy-live"),
      client.set(`intervals:${connectionId}:processed_count`, "999"),
    ])

    const response = await GET(new Request(`http://localhost/api/trade-engine/detailed-logs?connectionId=${connectionId}`))
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.summary.pseudoPositions).toMatchObject({ open: 3, long: 2, short: 1, total: 3 })
    expect(body.summary.livePositions).toBe(2)
    expect(body.summary.intervalsProcessed).toBe(120)
    expect(body.summary).not.toHaveProperty("pseudoPositionsRaw")
    expect(body.summary).not.toHaveProperty("pseudoPositionsByType")
  })

  test("the route never loads position rows to count them", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/trade-engine/detailed-logs/route.ts"), "utf8")
    expect(route).toContain("client.scard(`pseudo_positions:${conn.id}`)")
    expect(route).toContain("client.llen(`live:positions:${conn.id}`)")
    expect(route).not.toContain("base_pseudo:")
    expect(route).not.toContain("positions:${conn.id}:live")
    expect(route).not.toContain("intervals:${conn.id}:processed_count")
    expect(route).not.toContain("pseudo_position:${")
  })
})
