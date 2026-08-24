import { GET, PATCH } from "@/app/api/preset-types/[id]/config/route"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("preset type runtime config", () => {
  const id = `preset-config-${Date.now()}`
  const key = `preset_type:${id}`

  beforeAll(async () => {
    await initRedis()
    await getRedisClient().hset(key, {
      id,
      name: "Volume contract",
      volume_factor: "0.2",
      profit_factor_min: "0.7",
      max_drawdown_time: "18",
      trailing_enabled: "true",
      block_enabled: "true",
      dca_enabled: "false",
    })
  })

  afterAll(async () => {
    await getRedisClient().del(key)
  })

  test("normalizes legacy sub-unit identity factors on read", async () => {
    const response = await GET(
      new Request(`http://localhost/api/preset-types/${id}/config`) as any,
      { params: Promise.resolve({ id }) },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      volume_factor: 1,
      profit_factor_min: 1.02,
      max_drawdown_time: 18,
      trailing_enabled: true,
      block_enabled: true,
      dca_enabled: false,
    })
  })

  test("persists the canonical factor and all preset toggles", async () => {
    const response = await PATCH(
      new Request(`http://localhost/api/preset-types/${id}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          volumeFactor: 0.4,
          profitFactorMin: 1.25,
          maxDrawdownTime: 24,
          trailingEnabled: false,
          blockEnabled: true,
          dcaEnabled: true,
        }),
      }) as any,
      { params: Promise.resolve({ id }) },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: true,
      volume_factor: 1,
      profit_factor_min: 1.26,
      max_drawdown_time: 24,
      trailing_enabled: false,
      block_enabled: true,
      dca_enabled: true,
    }))
    expect(await getRedisClient().hget(key, "volume_factor")).toBe("1")
  })
})
