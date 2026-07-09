const mockGetRedisClient = jest.fn()
const mockGetAllConnections = jest.fn()
const mockSetSettings = jest.fn()
const mockIsEngineRunning = jest.fn()
const mockIsProcessorHeartbeatFresh = jest.fn()
const mockGetFreshestProcessorHeartbeat = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(),
  getAllConnections: (...args: any[]) => mockGetAllConnections(...args),
  getRedisClient: (...args: any[]) => mockGetRedisClient(...args),
  setSettings: (...args: any[]) => mockSetSettings(...args),
  cleanupVolatileRuntimeState: jest.fn(async () => ({ deleted: 0, preserved: 0 })),
}))

jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: () => ({ isEngineRunning: mockIsEngineRunning }),
}))

jest.mock("@/lib/engine-heartbeat", () => ({
  isProcessorHeartbeatFresh: (...args: any[]) => mockIsProcessorHeartbeatFresh(...args),
  getFreshestProcessorHeartbeat: (...args: any[]) => mockGetFreshestProcessorHeartbeat(...args),
}))

jest.mock("@/lib/database-validator", () => ({ validateDatabase: jest.fn() }))
jest.mock("@/lib/database-consolidation", () => ({ consolidateDatabase: jest.fn() }))
jest.mock("@/lib/redis-migrations", () => ({
  getMigrationStatus: jest.fn(),
  runProductionCoverageRepair: jest.fn(),
}))
jest.mock("@/lib/startup-diagnostics", () => ({
  recordMigrationStatus: jest.fn(),
  recordStartupError: jest.fn(),
  recordStartupPhase: jest.fn(),
}))

function createClient(values: Record<string, string | null> = {}, hashes: Record<string, Record<string, string>> = {}) {
  return {
    get: jest.fn(async (key: string) => values[key] ?? null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    hgetall: jest.fn(async (key: string) => hashes[key] ?? {}),
  }
}

describe("cleanupOrphanedProgress", () => {
  const realUptime = process.uptime
  const realDateNow = Date.now

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllConnections.mockResolvedValue([{ id: "conn-1" }])
    mockIsEngineRunning.mockReturnValue(false)
    mockIsProcessorHeartbeatFresh.mockResolvedValue(false)
    mockGetFreshestProcessorHeartbeat.mockResolvedValue(0)
    Date.now = jest.fn(() => 1_700_000_000_000)
    process.uptime = jest.fn(() => 300) as any
  })

  afterAll(() => {
    process.uptime = realUptime
    Date.now = realDateNow
  })

  test("preserves a fresh distributed owner heartbeat and clears pending cleanup marker", async () => {
    const client = createClient({ "engine_is_running:conn-1": "1" })
    mockGetRedisClient.mockReturnValue(client)
    mockIsProcessorHeartbeatFresh.mockResolvedValue(true)
    const { cleanupOrphanedProgress } = await import("@/lib/startup-coordinator")

    await cleanupOrphanedProgress()

    expect(client.set).not.toHaveBeenCalledWith("engine_is_running:conn-1", "0")
    expect(mockSetSettings).not.toHaveBeenCalledWith(
      "engine_progression:conn-1",
      expect.objectContaining({ phase: "idle", progress: 0 }),
    )
    expect(client.del).toHaveBeenCalledWith("engine_orphan_cleanup_pending:conn-1")
  })

  test("marks pending instead of resetting when heartbeat is missing during startup grace", async () => {
    process.uptime = jest.fn(() => 5) as any
    const client = createClient({ "engine_is_running:conn-1": "1" })
    mockGetRedisClient.mockReturnValue(client)
    const { cleanupOrphanedProgress } = await import("@/lib/startup-coordinator")

    await cleanupOrphanedProgress()

    expect(client.set).not.toHaveBeenCalledWith("engine_is_running:conn-1", "0")
    expect(client.set).toHaveBeenCalledWith("engine_orphan_cleanup_pending:conn-1", "1700000000000")
    expect(mockSetSettings).toHaveBeenCalledWith(
      "engine_progression:conn-1",
      expect.objectContaining({
        orphan_cleanup_pending: true,
        needs_reconcile: true,
        orphan_cleanup_reason: "startup_grace_waiting_for_owner_heartbeat",
      }),
    )
  })

  test("resets a truly stale owner after a second confirmation pass", async () => {
    const client = createClient({
      "engine_is_running:conn-1": "1",
      "engine_orphan_cleanup_pending:conn-1": String(1_700_000_000_000 - 31_000),
    })
    mockGetRedisClient.mockReturnValue(client)
    const { cleanupOrphanedProgress } = await import("@/lib/startup-coordinator")

    await cleanupOrphanedProgress()

    expect(client.set).toHaveBeenCalledWith("engine_is_running:conn-1", "0")
    expect(mockSetSettings).toHaveBeenCalledWith(
      "engine_progression:conn-1",
      expect.objectContaining({
        phase: "idle",
        progress: 0,
        orphan_cleanup_pending: false,
        needs_reconcile: true,
      }),
    )
  })
})
