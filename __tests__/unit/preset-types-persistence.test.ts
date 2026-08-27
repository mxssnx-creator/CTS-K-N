import { PUT } from "@/app/api/preset-types/[id]/route"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("preset type durable settings", () => {
  const id = `preset-durable-${Date.now()}`
  const key = `preset_type:${id}`

  beforeAll(async () => {
    await initRedis()
    const client = getRedisClient()
    await client.hset(key, {
      id,
      name: "Existing preset",
      normal_enabled: "false",
      trailing_enabled: "true",
      block_enabled: "false",
      dca_enabled: "true",
      auto_evaluate: "false",
      is_active: "true",
    })
    await client.expire(key, 60)
  })

  afterAll(async () => {
    const client = getRedisClient()
    await Promise.all([
      client.del(key),
      client.srem("preset_types:all", id),
    ])
  })

  test("partial updates preserve omitted family switches and remove cache TTLs", async () => {
    const response = await PUT(
      new Request(`http://localhost/api/preset-types/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed preset" }),
      }) as any,
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      name: "Renamed preset",
      normal_enabled: false,
      trailing_enabled: true,
      block_enabled: false,
      dca_enabled: true,
      auto_evaluate: false,
      is_active: true,
    }))
    expect(await getRedisClient().ttl(key)).toBe(-1)
  })
})
