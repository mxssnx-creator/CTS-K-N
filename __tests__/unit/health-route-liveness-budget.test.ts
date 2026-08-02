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
      smembers: jest.fn().mockResolvedValue([]),
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
})
