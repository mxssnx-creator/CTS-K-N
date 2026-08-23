const getAllConnectionsMock = jest.fn()
const getRedisClientMock = jest.fn()
const verifyRedisHealthMock = jest.fn()
const getHealthReportMock = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  getAllConnections: (...args: unknown[]) => getAllConnectionsMock(...args),
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
  verifyRedisHealth: (...args: unknown[]) => verifyRedisHealthMock(...args),
}))

jest.mock("@/lib/health-check", () => ({
  HealthStatus: { HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy" },
  healthCheckService: {
    getHealthReport: (...args: unknown[]) => getHealthReportMock(...args),
  },
}))

describe("health route liveness budget", () => {
  beforeEach(() => {
    jest.resetModules()
    getRedisClientMock.mockReturnValue({
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue("OK"),
      hgetall: jest.fn().mockResolvedValue({}),
      scard: jest.fn().mockResolvedValue(0),
    })
    getAllConnectionsMock.mockReturnValue(new Promise(() => {}))
    verifyRedisHealthMock.mockResolvedValue({ healthy: true, latency: 1 })
    getHealthReportMock.mockResolvedValue({
      status: "healthy",
      timestamp: new Date(),
      uptime: 1,
      checks: {},
      summary: "healthy",
    })
  })

  test("returns a degraded alive response when a metrics dependency never settles", async () => {
    const { GET } = await import("@/app/api/health/route")
    const startedAt = Date.now()
    const response = await GET()
    const payload = await response.json()

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      alive: true,
      status: "degraded",
      diagnostics: { complete: false, budgetMs: 1_000 },
    })
  })

  test("reports a runtime deficit when operator intent is running but the heartbeat is stale", async () => {
    const now = Date.now()
    const client = {
      get: jest.fn(async (key: string) => key === "health:cached_metrics" ? null : "1"),
      setex: jest.fn().mockResolvedValue("OK"),
      hgetall: jest.fn(async (key: string) => {
        if (key === "trade_engine:global") return { operator_intent: "running", status: "running" }
        return { status: "running", last_processor_heartbeat: String(now - 10 * 60_000), updated_at: String(now - 10 * 60_000) }
      }),
      scard: jest.fn(async (key: string) => key.startsWith("trades:") ? 12 : 3),
    }
    getRedisClientMock.mockReturnValue(client)
    getAllConnectionsMock.mockResolvedValue([{ id: "bingx-x02", is_assigned: "1", is_enabled_dashboard: "1" }])

    const { GET } = await import("@/app/api/health/route")
    const response = await GET()
    const payload = await response.json()

    expect(payload.status).toBe("degraded")
    expect(payload.diagnostics).toMatchObject({ runtimeHealthy: false, runtimeDeficit: 1 })
    expect(payload.system).toMatchObject({
      expectedRunningEngines: 1,
      runningEngines: 0,
      runtimeDeficit: 1,
      totalTrades: 12,
      totalOpenPositions: 3,
    })
    expect(client.scard).toHaveBeenCalled()
  })

  test("accepts a fresh distributed processor heartbeat as the runtime authority", async () => {
    const now = Date.now()
    const client = {
      get: jest.fn(async (key: string) => key === "health:cached_metrics" ? null : "1"),
      setex: jest.fn().mockResolvedValue("OK"),
      hgetall: jest.fn(async (key: string) => {
        if (key === "trade_engine:global") return { operator_intent: "running", status: "running" }
        return { status: "running", last_processor_heartbeat: String(now - 1_000), updated_at: String(now - 1_000) }
      }),
      scard: jest.fn().mockResolvedValue(0),
    }
    getRedisClientMock.mockReturnValue(client)
    getAllConnectionsMock.mockResolvedValue([{ id: "bingx-x02", is_assigned: true, is_enabled_dashboard: true }])

    const { GET } = await import("@/app/api/health/route")
    const response = await GET()
    const payload = await response.json()

    expect(payload.status).toBe("healthy")
    expect(payload.diagnostics).toMatchObject({ runtimeHealthy: true, runtimeDeficit: 0 })
    expect(payload.system).toMatchObject({ expectedRunningEngines: 1, runningEngines: 1 })
  })
})
