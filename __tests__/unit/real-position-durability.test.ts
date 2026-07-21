import { getRedisClient } from "@/lib/redis-db"
import { updateRealPositionStatus } from "@/lib/trade-engine/stages/real-stage"

describe("active Real-stage position durability", () => {
  const connectionId = `real-durable-${Date.now()}`
  const positionId = `${connectionId}:position`
  const positionKey = `real:position:${positionId}`
  const indexKey = `real:positions:index:${connectionId}`

  afterAll(async () => {
    await getRedisClient().del(positionKey, indexKey)
  })

  test("heals legacy TTLs and keeps the record/index until explicit close", async () => {
    const position = {
      id: positionId,
      connectionId,
      symbol: "BTCUSDT",
      direction: "long",
      status: "ready",
    }
    const client = getRedisClient()
    await client.setex(positionKey, 5, JSON.stringify(position))
    await client.sadd(indexKey, positionId)
    await client.expire(indexKey, 5)
    expect(await client.ttl(positionKey)).toBeGreaterThan(0)
    expect(await client.ttl(indexKey)).toBeGreaterThan(0)

    await updateRealPositionStatus(positionId, "trading")
    expect(await client.ttl(positionKey)).toBe(-1)
    expect(await client.ttl(indexKey)).toBe(-1)
    expect(JSON.parse(String(await client.get(positionKey)))).toMatchObject({ status: "trading" })
    expect(await client.sismember(indexKey, positionId)).toBe(1)
  })
})
