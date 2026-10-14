/**
 * H5: a status poll whose read of the operator-intent hash fails must not be
 * treated as an operator Stop. It skips reconciliation (no stopAll) and
 * reports a degraded status instead of a false "stopped".
 */
const globalHash = jest.fn()
const stopAll = jest.fn(async () => undefined)
const writeTradeEngineStatusCache = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => ({
    hgetall: (key: string) => (key === "trade_engine:global" ? globalHash() : Promise.resolve({})),
  }),
  getActiveConnectionsForEngine: jest.fn(async () => []),
  getAllConnections: jest.fn(async () => []),
}))
jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: () => ({
    isRunning: () => true,
    stopAll: (...args: unknown[]) => (stopAll as any)(...args),
    getActiveEngineCount: () => 2,
    getEngineManager: () => null,
    engines: new Map(),
  }),
}))
jest.mock("@/lib/trade-engine-status-cache", () => ({
  readTradeEngineStatusCache: () => undefined,
  writeTradeEngineStatusCache: (...args: unknown[]) => (writeTradeEngineStatusCache as any)(...args),
}))
jest.mock("@/lib/progression-state-manager", () => ({
  ProgressionStateManager: { getProgressionState: jest.fn(async () => ({})) },
}))
jest.mock("@/lib/live-execution-summary", () => ({ getLiveExecutionSummary: jest.fn(async () => null) }))

const { GET } = require("@/app/api/trade-engine/status/route")

describe("trade-engine status with an unreadable operator intent", () => {
  beforeEach(() => {
    globalHash.mockReset()
    stopAll.mockClear()
    writeTradeEngineStatusCache.mockClear()
  })

  test("a failed read of trade_engine:global does not stop the running engines", async () => {
    globalHash.mockRejectedValue(new Error("READONLY You can't write against a read only replica"))

    const response = await GET()
    const body = await response.json()

    expect(stopAll).not.toHaveBeenCalled()
    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      degraded: true,
      status: "degraded",
      operatorIntent: "unknown",
      activeEngineCount: 2,
    })
    expect(body.degradedReason).toContain("READONLY")
    // A degraded answer is not cached as the current status.
    expect(writeTradeEngineStatusCache).not.toHaveBeenCalled()
  })

  test("an explicit stopped intent still stops an orphaned coordinator", async () => {
    globalHash.mockResolvedValue({ status: "stopped" })

    const response = await GET()
    const body = await response.json()

    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(body.degraded).toBeUndefined()
    expect(body.status).toBe("stopped")
  })
})
