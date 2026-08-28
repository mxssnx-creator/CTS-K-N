const mockInitRedis = jest.fn()
const mockGetAllConnections = jest.fn()
const mockGetLivePositions = jest.fn()
const mockGetClosedLivePositions = jest.fn()

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

const { GET } = require("@/app/api/exchange-positions/symbols-stats/route")

describe("exchange-position symbol statistics", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetAllConnections.mockResolvedValue([{
      id: "conn-symbols",
      is_enabled_dashboard: true,
      is_enabled: true,
      is_live_trade: true,
    }])
    mockGetLivePositions.mockResolvedValue([])
    mockGetClosedLivePositions.mockResolvedValue([])
  })

  test("requires an explicit connection scope", async () => {
    const response = await GET(new Request("http://localhost/api/exchange-positions/symbols-stats"))

    expect(response.init).toEqual({ status: 400 })
    expect(response.body.symbols).toEqual([])
    expect(mockGetLivePositions).not.toHaveBeenCalled()
  })

  test("deduplicates lifecycle ledgers and separates pending, break-even, and open states", async () => {
    mockGetLivePositions.mockResolvedValue([
      {
        id: "transitioning",
        status: "closing",
        executionMode: "live",
        symbol: "btcusdt",
        unrealizedPnL: 500,
      },
      {
        id: "open-unknown",
        status: " CLOSING_PARTIAL ",
        executionMode: "live",
        symbol: "BTCUSDT",
        executedQuantity: 1,
      },
      {
        id: "pending-request-only",
        status: "pending_fill",
        executionMode: "live",
        orderId: "pending-entry",
        symbol: "BTCUSDT",
        quantity: 5,
        unrealizedPnL: -999,
      },
      {
        id: "paper-open",
        status: "open",
        mode: "paper",
        symbol: "BTCUSDT",
        unrealizedPnL: 999,
      },
    ])
    mockGetClosedLivePositions.mockResolvedValue([
      {
        id: "transitioning",
        status: " CLOSED ",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: 4,
        closedAt: 1_777_000_000,
      },
      {
        id: "pending",
        status: "closed",
        executionMode: "live",
        symbol: "btcusdt",
        realizedPnlComplete: false,
        realizedPnL: 0,
      },
      {
        id: "missing-pnl",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
      },
      {
        id: "break-even",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: 0,
      },
    ])

    const response = await GET(new Request(
      "http://localhost/api/exchange-positions/symbols-stats?connection_id=conn-symbols",
    ))
    const [stats] = response.body.symbols

    expect(mockGetLivePositions).toHaveBeenCalledWith("conn-symbols")
    expect(mockGetClosedLivePositions).toHaveBeenCalledWith("conn-symbols", 250)
    expect(stats).toMatchObject({
      symbol: "BTCUSDT",
      livePositions: 5,
      openPositions: 1,
      closedPositions: 4,
      settledClosedPositions: 2,
      accountingPending: 2,
      accountingComplete: false,
      realizedPnl: 4,
      unrealizedPnl: 0,
      unrealizedPnlUnknown: 1,
      unrealizedPnlComplete: false,
      wins: 1,
      losses: 0,
      breakEven: 1,
      winRate: 100,
      profitFactor250: null,
      profitFactor250Infinite: true,
      profitFactor50: null,
      profitFactor50Infinite: true,
    })
  })

  test("sorts mixed timestamp formats before computing the last-50 PF", async () => {
    const newerSeconds = Math.floor(Date.UTC(2026, 7, 26, 12, 0, 0) / 1000)
    const olderIso = "2026-08-26T11:00:00.000Z"
    mockGetClosedLivePositions.mockResolvedValue([
      ...Array.from({ length: 49 }, (_, index) => ({
        id: `win-${index}`,
        status: "closed",
        executionMode: "live",
        symbol: "ETHUSDT",
        realizedPnL: 1,
        closedAt: new Date(Date.UTC(2026, 7, 26, 13, 0, 0) - index * 1_000).toISOString(),
      })),
      {
        id: "newer-seconds",
        status: "closed",
        executionMode: "live",
        symbol: "ETHUSDT",
        realizedPnL: -1,
        closedAt: newerSeconds,
      },
      {
        id: "older-iso",
        status: "closed",
        executionMode: "live",
        symbol: "ETHUSDT",
        realizedPnL: -100,
        closedAt: olderIso,
      },
    ])

    const response = await GET(new Request(
      "http://localhost/api/exchange-positions/symbols-stats?connectionId=conn-symbols",
    ))
    const [stats] = response.body.symbols

    expect(stats.profitFactor50).toBe(49)
    expect(stats.profitFactor250).toBeCloseTo(49 / 101, 2)
  })
})
