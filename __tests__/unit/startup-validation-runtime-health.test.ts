jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(),
  getRedisClient: jest.fn(),
  getSettings: jest.fn(),
}))

import { getRedisClient, getSettings, initRedis } from "@/lib/redis-db"
import { runtimeHealthCheck } from "@/lib/startup-validation"

const mockedInitRedis = initRedis as jest.MockedFunction<typeof initRedis>
const mockedGetRedisClient = getRedisClient as jest.MockedFunction<typeof getRedisClient>
const mockedGetSettings = getSettings as jest.MockedFunction<typeof getSettings>

describe("startup runtime health", () => {
  const now = Date.parse("2026-08-25T00:00:00.000Z")
  const hgetall = jest.fn()

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now)
    jest.clearAllMocks()
    mockedInitRedis.mockResolvedValue(undefined)
    mockedGetRedisClient.mockReturnValue({ hgetall } as unknown as ReturnType<typeof getRedisClient>)
    mockedGetSettings.mockImplementation(async (key: string) => {
      if (key === "engine_state") return { running: false, status: "stopped", updated_at: now - 300_000 }
      return null
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("reports running from a fresh canonical global worker heartbeat", async () => {
    hgetall.mockResolvedValue({
      status: "running",
      actual_status: "running",
      operator_intent: "running",
      last_heartbeat_at: String(now - 1_000),
      last_heartbeat_iso: new Date(now - 1_000).toISOString(),
    })

    const health = await runtimeHealthCheck()

    expect(health).toEqual(expect.objectContaining({
      redis: "ok",
      engineState: "running",
      engineReason: "fresh-heartbeat",
      engineHeartbeatAgeMs: 1_000,
    }))
  })

  test("keeps an explicit operator stop authoritative over a fresh heartbeat", async () => {
    hgetall.mockResolvedValue({
      status: "stopped",
      actual_status: "stopped",
      operator_intent: "stopped",
      last_heartbeat_at: String(now - 1_000),
    })

    const health = await runtimeHealthCheck()

    expect(health.engineState).toBe("stopped")
    expect(health.engineReason).toBe("operator-stopped")
  })

  test("does not turn retained running intent without fresh activity into liveness", async () => {
    hgetall.mockResolvedValue({
      status: "running",
      actual_status: "running",
      operator_intent: "running",
      updated_at: new Date(now - 300_000).toISOString(),
    })

    const health = await runtimeHealthCheck()

    expect(health.engineState).toBe("stopped")
    expect(health.engineReason).toBe("no-runtime-proof")
    expect(health.engineHeartbeatAgeMs).toBeNull()
  })
})
