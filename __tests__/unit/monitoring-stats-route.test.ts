const mockInitRedis = jest.fn()
const mockGetAllConnections = jest.fn()
const mockGetRedisClient = jest.fn()
const mockGetPositions = jest.fn()
const mockGetTrades = jest.fn()
const mockGetStatistics = jest.fn()
const mockGetLiveExecutionSummary = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: unknown) => ({ body, init }),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
}))

jest.mock("@/lib/redis-operations", () => ({
  RedisMonitoring: { getStatistics: (...args: unknown[]) => mockGetStatistics(...args) },
}))

jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: (...args: unknown[]) => mockGetLiveExecutionSummary(...args),
}))

const { GET } = require("@/app/api/monitoring/stats/route")

describe("monitoring statistics route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetAllConnections.mockResolvedValue([
      {
        id: "bingx-selected",
        exchange: "bingx",
        is_assigned: true,
        is_enabled_dashboard: true,
      },
      {
        id: "bybit-other",
        exchange: "bybit",
        is_assigned: true,
        is_enabled_dashboard: true,
      },
    ])
    mockGetTrades.mockResolvedValue([{ id: "trade-1" }])
    mockGetLiveExecutionSummary.mockResolvedValue({
      totalPositions: 6,
      openPositions: 1,
      totalTrades: 4,
      dailyRealizedPnl: 2,
      dailyPnlTimestampUnknown: 0,
      realizedPnl: 1,
      unrealizedPnl: 3,
      accountingPending: 2,
      sourceCounts: { real: 6, simulated: 1, unknown: 0 },
    })
    mockGetStatistics.mockResolvedValue({
      winRate250: null,
      profitFactor250: "",
      winRate50: "25.5",
      profitFactor50: false,
    })
  })

  test("scopes all ledgers and progression counters and separates daily from lifetime PnL", async () => {
    const now = Date.now()
    const today = new Date(now)
    today.setUTCHours(12, 0, 0, 0)
    const yesterday = today.getTime() - 24 * 60 * 60 * 1000
    mockGetPositions.mockResolvedValue([
      {
        id: "today-settled",
        status: " CLOSED ",
        executionMode: "live",
        realizedPnL: 2,
        closedAt: today.toISOString(),
      },
      {
        id: "older-settled",
        status: "closed",
        executionMode: "live",
        realizedPnL: -1,
        closedAt: yesterday,
      },
      {
        id: "pending",
        status: "closed",
        executionMode: "live",
        pnlAccountingComplete: false,
        realizedPnL: 0,
        closedAt: today.toISOString(),
      },
      {
        id: "missing-pnl",
        status: "closed",
        executionMode: "live",
        closedAt: today.toISOString(),
      },
      {
        id: "closing",
        status: " closing_partial ",
        mode: "live",
        unrealizedPnL: 3,
      },
      {
        id: "rejected",
        status: "rejected",
        executionMode: "live",
        unrealizedPnL: 999,
      },
      {
        id: "paper",
        status: "simulated",
        mode: "paper",
        unrealizedPnL: 5,
      },
    ])
    const keys = jest.fn()
    const hgetall = jest.fn(async (key: string) => {
      expect(key).toBe("progression:bingx-selected")
      return {
        indication_cycle_count: "3",
        indications_count: "bad",
        strategies_count: "2.9",
      }
    })
    mockGetRedisClient.mockReturnValue({ hgetall, keys })

    const response = await GET({
      nextUrl: new URL("http://localhost/api/monitoring/stats?exchange=bingx"),
    })

    expect(mockGetLiveExecutionSummary).toHaveBeenCalledTimes(1)
    expect(mockGetLiveExecutionSummary).toHaveBeenCalledWith("bingx-selected")
    expect(mockGetPositions).not.toHaveBeenCalled()
    expect(mockGetTrades).not.toHaveBeenCalled()
    expect(keys).not.toHaveBeenCalled()
    expect(response.body).toMatchObject({
      activeConnections: 1,
      totalConnections: 1,
      totalPositions: 6,
      openPositions: 1,
      totalTrades: 4,
      dailyPnL: 2,
      dailyPnlWindow: "UTC calendar day",
      realizedPnL: 1,
      unrealizedPnL: 3,
      effectivePnL: 4,
      totalBalance: 4,
      accountingPending: 2,
      positionSourceCounts: { real: 6, simulated: 1, unknown: 0 },
      statistics: {
        totalCycles: 3,
        totalIndications: 0,
        totalStrategies: 2,
        winRate250: null,
        profitFactor250: null,
        winRate50: 25.5,
        profitFactor50: null,
      },
    })
  })
})
