/**
 * M7: the workflow snapshot behind monitoring/health/structure/logistics read
 * keys the running engine no longer writes: cycle counts only from the legacy
 * progression hash, realtime cycles only from engine state, positions/trades
 * from never-populated indexes, the legacy prehistoric set and an intervals
 * counter without a writer.
 */
const hashes = new Map<string, Record<string, string>>()
const setSizes = new Map<string, number>()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getAllConnections: jest.fn(async () => [{
    id: "conn-m7", name: "M7", exchange: "bingx",
    is_active_inserted: "1", is_enabled_dashboard: "1",
  }]),
  getAppSettings: jest.fn(async () => ({})),
  getSettings: jest.fn(async () => ({})),
  getRedisClient: () => ({
    hgetall: async (key: string) => hashes.get(key) || {},
    hget: async (key: string, field: string) => hashes.get(key)?.[field] ?? null,
    scard: async (key: string) => setSizes.get(key) || 0,
    exists: async (key: string) => (setSizes.has(key) ? 1 : 0),
    get: async () => null,
  }),
}))
jest.mock("@/lib/progression-state-manager", () => ({
  ProgressionStateManager: { getProgressionState: jest.fn(async () => ({ connectionId: "conn-m7" })) },
}))
jest.mock("@/lib/engine-progression-logs", () => ({ getProgressionLogs: jest.fn(async () => []) }))
jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: jest.fn(async () => ({ totalPositions: 7, totalTrades: 5, openPositions: 2 })),
}))

const { getDashboardWorkflowSnapshot } = require("@/lib/dashboard-workflow")

describe("dashboard workflow snapshot reads the keys the engine writes", () => {
  test("cycles, positions, trades, Historic symbols and intervals come from their current writers", async () => {
    // The long-lived engine increments the engine-scoped hash; the legacy
    // hash only holds an older value.
    hashes.set("progression:conn-m7:main", {
      indication_cycle_count: "40",
      strategy_cycle_count: "38",
      realtime_cycle_count: "41",
      indications_direction_count: "12",
    })
    hashes.set("progression:conn-m7", { indication_cycle_count: "3", strategy_cycle_count: "2" })
    hashes.set("prehistoric:conn-m7:main", { intervals_processed: "120" })
    setSizes.set("prehistoric:conn-m7:main:symbols", 5)
    setSizes.set("prehistoric:conn-m7:symbols", 2)

    const snapshot = await getDashboardWorkflowSnapshot({ preferredConnectionId: "conn-m7" })
    const metrics = snapshot.connectionMetrics

    expect(metrics.engineCycles).toEqual({ indication: 40, strategy: 38, realtime: 41, total: 119 })
    expect(metrics.positions).toBe(7)
    expect(metrics.trades).toBe(5)
    expect(metrics.comprehensiveStats.symbols).toMatchObject({ prehistoricLoaded: 5, intervalsProcessed: 120 })
    expect(metrics.comprehensiveStats.indicationsByType.direction).toBe(12)
    expect(metrics.comprehensiveStats.livePositions).toBe(2)
  })
})
