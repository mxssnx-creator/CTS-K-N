const mockInitRedis = jest.fn()
const mockGetAllConnections = jest.fn()
const mockGetLivePositions = jest.fn()
const mockGetClosedLivePositions = jest.fn()
const mockGetLiveExecutionSummary = jest.fn()
const mockLogError = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: unknown) => ({ body, init }),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
}))

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: (...args: unknown[]) => mockGetLivePositions(...args),
  getClosedLivePositions: (...args: unknown[]) => mockGetClosedLivePositions(...args),
}))

jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: (...args: unknown[]) => mockGetLiveExecutionSummary(...args),
}))

jest.mock("@/lib/system-logger", () => ({
  SystemLogger: { logError: (...args: unknown[]) => mockLogError(...args) },
}))

const { GET } = require("@/app/api/trading/stats/route")

describe("trading statistics route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetAllConnections.mockResolvedValue([{
      id: "conn-trading-stats",
      is_enabled: true,
      is_enabled_dashboard: true,
      is_live_trade: true,
    }])
    mockGetLivePositions.mockResolvedValue([])
    mockGetClosedLivePositions.mockResolvedValue([])
    mockGetLiveExecutionSummary.mockResolvedValue({
      openPositions: 0,
      openSymbols: 0,
      openOrders: 0,
      entryOrders: 0,
      controlOrders: 0,
      unrealizedPnl: 0,
      exchange: { complete: false },
    })
  })

  test("uses closed-trade windows, deduplicates transitions, and exposes incomplete accounting", async () => {
    mockGetLiveExecutionSummary.mockResolvedValue({
      openPositions: 2,
      openSymbols: 2,
      openOrders: 0,
      entryOrders: 0,
      controlOrders: 0,
      unrealizedPnl: 3,
      exchange: { complete: false },
    })
    mockGetLivePositions.mockResolvedValue([
      {
        id: "transition",
        status: "closing",
        executionMode: "live",
        symbol: "BTCUSDT",
        unrealizedPnL: 99,
      },
      {
        id: "open",
        status: " CLOSING_PARTIAL ",
        executionMode: "live",
        symbol: "ETHUSDT",
        executedQuantity: 1,
        unrealizedPnL: 3,
      },
      {
        id: "open-unknown-pnl",
        status: "open",
        executionMode: "live",
        symbol: "SOLUSDT",
        executedQuantity: 1,
      },
      {
        id: "pending-request-only",
        status: "pending_fill",
        executionMode: "live",
        orderId: "pending-entry",
        symbol: "XRPUSDT",
        quantity: 100,
        unrealizedPnL: -999,
      },
      {
        id: "paper",
        status: "simulated",
        mode: "paper",
        orderId: "synthetic-order",
        unrealizedPnL: 1000,
      },
    ])
    mockGetClosedLivePositions.mockResolvedValue([
      {
        id: "transition",
        status: " CLOSED ",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: 2,
        closedAt: "2026-08-26T12:00:00.000Z",
      },
      {
        id: "loss",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: -1,
        closedAt: "2026-08-26T11:00:00.000Z",
      },
      {
        id: "break-even",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: 0,
        closedAt: "2026-08-26T10:00:00.000Z",
      },
      {
        id: "pending",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        pnlAccountingComplete: false,
        realizedPnL: 0,
        closedAt: "2026-08-26T09:00:00.000Z",
      },
      {
        id: "missing",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        closedAt: "2026-08-26T08:00:00.000Z",
      },
    ])

    const response = await GET(new Request(
      "http://localhost/api/trading/stats?connection_id=conn-trading-stats",
    ))

    expect(mockGetLivePositions).toHaveBeenCalledWith("conn-trading-stats")
    expect(mockGetClosedLivePositions).toHaveBeenCalledWith("conn-trading-stats", 250)
    expect(response.body.last50).toMatchObject({
      total: 7,
      openPositions: 2,
      closedPositions: 5,
      settledClosedPositions: 3,
      accountingPending: 2,
      accountingComplete: false,
      wins: 1,
      losses: 1,
      breakEven: 1,
      winRate: 50,
      profitFactor: 2,
      profitFactorInfinite: false,
      realizedPnl: 1,
      unrealizedPnl: 3,
      unrealizedPnlUnknown: 1,
      unrealizedPnlComplete: false,
      effectivePnl: 4,
    })
  })

  test("represents a loss-free profit factor as infinity rather than a finite sentinel", async () => {
    mockGetClosedLivePositions.mockResolvedValue([{
      id: "only-win",
      status: "closed",
      executionMode: "live",
      realizedPnL: 7,
      closedAt: Date.now(),
    }])

    const response = await GET(new Request(
      "http://localhost/api/trading/stats?connectionId=conn-trading-stats",
    ))

    expect(response.body.last50).toMatchObject({
      profitFactor: null,
      profitFactorInfinite: true,
      wins: 1,
      losses: 0,
    })
  })
})
