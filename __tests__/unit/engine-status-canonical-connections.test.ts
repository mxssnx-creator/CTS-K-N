const mockActiveConnections = jest.fn()
const mockAllConnections = jest.fn()
const mockIsMainEnabled = jest.fn()
const mockGetEngineStatus = jest.fn()
const mockStartEngine = jest.fn()
const mockLoadConnections = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn().mockResolvedValue(undefined),
  getRedisClient: () => ({}),
  getActiveConnectionsForEngine: (...args: unknown[]) => mockActiveConnections(...args),
  getAllConnections: (...args: unknown[]) => mockAllConnections(...args),
  isConnectionMainEnabled: (...args: unknown[]) => mockIsMainEnabled(...args),
}))
jest.mock("@/lib/file-storage", () => ({
  loadConnections: (...args: unknown[]) => mockLoadConnections(...args),
  loadSettings: () => ({}),
}))
jest.mock("@/lib/settings-storage", () => ({
  loadSettingsAsync: jest.fn().mockResolvedValue({ mainEngineIntervalMs: 2000 }),
}))
jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: () => ({
    getEngineStatus: (...args: unknown[]) => mockGetEngineStatus(...args),
    startEngine: (...args: unknown[]) => mockStartEngine(...args),
  }),
}))
jest.mock("@/lib/system-logger", () => ({ SystemLogger: { logError: jest.fn() } }))
jest.mock("@/lib/runtime-maintenance", () => ({
  getRuntimeMaintenanceState: () => ({ active: false }),
  runtimeMaintenanceJson: (s: unknown) => s,
}))
jest.mock("@/lib/persistent-paths", () => ({ resolvePersistentDataDir: (p: string) => p }))

const { GET: healthGet } = require("@/app/api/trade-engine/health/route")
const { GET: startupDebugGet } = require("@/app/api/trade-engine/startup-debug/route")
const { GET: verifyStartupGet } = require("@/app/api/system/verify-startup/route")

// The legacy file catalog that used to drive these routes. It still exists on
// old installs and lists placeholder ids that the canonical Redis catalog no
// longer enables.
const legacyFileCatalog = [
  { id: "default-bybit-001", name: "Bybit Main", exchange: "bybit", is_enabled: true, is_active: true },
  { id: "default-bingx-001", name: "BingX Main", exchange: "bingx", is_enabled: true, is_active: true },
]

describe("canonical connection loaders for engine status surfaces", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadConnections.mockReturnValue(legacyFileCatalog)
  })

  it("health reports the running canonical engine, not the stale legacy catalog", async () => {
    mockActiveConnections.mockResolvedValue([{ id: "bingx-x02", name: "BingX X02", exchange: "bingx" }])
    mockGetEngineStatus.mockResolvedValue({
      updated_at: "2026-09-14T23:50:00.000Z",
      health: { overall: "healthy", components: { indications: { status: "healthy" }, strategies: { status: "healthy" }, realtime: { status: "healthy" } } },
    })

    const res = await healthGet()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.overall).toBe("healthy")
    expect(body.runningEngines).toBe(1)
    expect(body.totalEngines).toBe(1)
    expect(body.engines[0]).toMatchObject({ connectionId: "bingx-x02", isRunning: true, status: "running", lastUpdate: "2026-09-14T23:50:00.000Z" })
    expect(body.engines.map((e: { connectionId: string }) => e.connectionId)).not.toContain("default-bybit-001")
    expect(mockLoadConnections).not.toHaveBeenCalled()
  })

  it("health is idle only when the canonical engines report no healthy component", async () => {
    mockActiveConnections.mockResolvedValue([{ id: "bingx-x02", name: "BingX X02", exchange: "bingx" }])
    mockGetEngineStatus.mockResolvedValue({ health: { overall: "unhealthy", components: { indications: { status: "stale" }, strategies: { status: "stale" }, realtime: { status: "stale" } } } })

    const body = await (await healthGet()).json()
    expect(body.overall).toBe("idle")
    expect(body.runningEngines).toBe(0)
    expect(body.totalEngines).toBe(1)
  })

  it("startup-debug starts only canonical enabled connections and never touches the legacy catalog", async () => {
    mockActiveConnections.mockResolvedValue([{ id: "bingx-x02", name: "BingX X02", exchange: "bingx" }])
    mockStartEngine.mockResolvedValue(undefined)

    const body = await (await startupDebugGet()).json()

    expect(body.success).toBe(true)
    expect(body.enabledConnections).toBe(1)
    expect(mockStartEngine).toHaveBeenCalledTimes(1)
    expect(mockStartEngine).toHaveBeenCalledWith("bingx-x02", expect.objectContaining({ connectionId: "bingx-x02", indicationInterval: 2 }))
    expect(mockStartEngine).not.toHaveBeenCalledWith("default-bybit-001", expect.anything())
    expect(mockLoadConnections).not.toHaveBeenCalled()
  })

  it("verify-startup reports the Redis catalog and treats the legacy file as informational", async () => {
    mockAllConnections.mockResolvedValue([
      { id: "bingx-x02", name: "BingX X02", exchange: "bingx" },
      { id: "bingx-x01", name: "BingX X01", exchange: "bingx" },
    ])
    mockIsMainEnabled.mockImplementation((c: { id: string }) => c.id === "bingx-x02")

    const body = await (await verifyStartupGet()).json()
    const load = body.checks.find((c: { name: string }) => c.name === "Load Connections")
    const file = body.checks.find((c: { name: string }) => c.name.startsWith("File Storage"))

    expect(load.status).toBe("pass")
    expect(load.details.source).toBe("redis")
    expect(load.details.totalConnections).toBe(2)
    expect(load.details.enabledConnections).toBe(1)
    expect(load.details.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: "bingx-x02", enabled: true })]))
    // A missing legacy file must not degrade the verification result.
    expect(file.status).toBe("pass")
    expect(body.status).toBe("success")
    expect(mockLoadConnections).not.toHaveBeenCalled()
  })
})
