const mockGetLivePositions = jest.fn()
const mockGetClosedLivePositions = jest.fn()
const mockGetLiveExecutionSummary = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: unknown) => ({ body, init }),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
}))

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: (...args: unknown[]) => mockGetLivePositions(...args),
  getClosedLivePositions: (...args: unknown[]) => mockGetClosedLivePositions(...args),
}))

jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: (...args: unknown[]) => mockGetLiveExecutionSummary(...args),
}))

const { GET } = require("@/app/api/trade-engine/pnl-stats/route")

describe("trade-engine PnL statistics", () => {
  beforeEach(() => {
    mockGetLivePositions.mockReset()
    mockGetClosedLivePositions.mockReset()
    mockGetLiveExecutionSummary.mockReset()
    mockGetLiveExecutionSummary.mockResolvedValue({
      openPositions: 0,
      unrealizedPnl: 0,
      excludedUntrackedPositions: 0,
      excludedUntrackedOrders: 0,
      exchange: {
        positionsStatus: { available: false },
        ordersStatus: { available: false },
        tracking: { attributionComplete: false },
      },
    })
  })

  test("uses one CTS-attributed venue PnL for independently tracked Sets", async () => {
    mockGetClosedLivePositions.mockResolvedValue([])
    mockGetLivePositions.mockResolvedValue([
      {
        id: "set-a",
        status: "open",
        executionMode: "live",
        orderId: "venue-a",
        symbol: "BTCUSDT",
        direction: "long",
        executedQuantity: 0.0001,
        entryPrice: 100,
        markPrice: 110,
        marginUsd: 1,
      },
      {
        id: "set-b",
        status: "filled",
        executionMode: "live",
        orderId: "venue-b",
        symbol: "BTCUSDT",
        direction: "long",
        executedQuantity: 0.0001,
        entryPrice: 100,
        markPrice: 110,
        marginUsd: 1,
      },
    ])
    mockGetLiveExecutionSummary.mockResolvedValue({
      openPositions: 1,
      unrealizedPnl: 0.25,
      excludedUntrackedPositions: 25,
      excludedUntrackedOrders: 2,
      exchange: {
        positionsStatus: { available: true },
        ordersStatus: { available: true },
        tracking: { attributionComplete: true },
      },
    })

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-netted-sets",
    })

    expect(response.body.stats).toMatchObject({
      total_positions: 1,
      open_positions: 1,
      open_set_lifecycles: 2,
      open_exchange_positions: 1,
      open_positions_source: "cts_exchange_snapshot",
      excluded_untracked_positions: 25,
      excluded_untracked_orders: 2,
      unrealized_pnl: 0.25,
      total_pnl: 0.25,
    })
  })

  test("uses the canonical live ledger for realised and current PnL", async () => {
    mockGetClosedLivePositions.mockResolvedValue([
      {
        id: "win",
        status: "closed",
        symbol: "BTCUSDT",
        direction: "long",
        entryPrice: 100,
        closePrice: 110,
        totalExecutedQuantity: 1,
        createdAt: "2026-07-25T10:00:00.000Z",
        closedAt: "2026-07-25T11:00:00.000Z",
        realizedPnL: 10,
        marginUsd: 50,
        orderId: "entry-win",
      },
      {
        id: "loss",
        status: "closed",
        symbol: "ETHUSDT",
        direction: "short",
        entryPrice: 100,
        closePrice: 105,
        totalExecutedQuantity: 1,
        createdAt: "2026-07-25T12:00:00.000Z",
        closedAt: "2026-07-25T11:00:00.000Z",
        realizedPnL: -5,
        marginUsd: 50,
        orderId: "entry-loss",
      },
    ])
    mockGetLivePositions.mockResolvedValue([
      {
        id: "open",
        status: "open",
        symbol: "SOLUSDT",
        direction: "long",
        entryPrice: 100,
        markPrice: 102,
        executedQuantity: 1,
        marginUsd: 25,
        orderId: "entry-open",
      },
    ])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-stats",
    })
    const stats = response.body.stats

    expect(mockGetLivePositions).toHaveBeenCalledWith("conn-stats")
    expect(mockGetClosedLivePositions).toHaveBeenCalledWith("conn-stats", 75)
    expect(stats).toMatchObject({
      source: "live_position_ledger",
      total_positions: 3,
      closed_positions: 2,
      open_positions: 1,
      total_pnl: 7,
      realized_pnl: 5,
      unrealized_pnl: 2,
      total_margin: 125,
      total_pnl_percent: 5.6,
      wins: 1,
      losses: 1,
      win_rate: 50,
      last_25_win_rate: 50,
      profit_factor: 2,
      profit_factor_last_12: 2,
      profit_factor_last_25: 2,
      profit_factor_last_50: 2,
      profit_factor_last_75: 2,
      avg_holding_time_min: 30,
      history_limit: 50,
      analytics_history_limit: 75,
    })
    expect(stats.last_25_positions).toHaveLength(2)
    expect(stats.last_50_positions).toHaveLength(2)
    expect(stats.last_25_positions[1].holding_time_min).toBe(0)
  })

  test("excludes paper positions from the last-50 exchange PnL", async () => {
    mockGetClosedLivePositions.mockResolvedValue([{
      id: "paper-close",
      status: "simulated",
      executionMode: "simulation",
      symbol: "BTCUSDT",
      direction: "long",
      realizedPnL: 999,
    }, {
      id: "venue-close",
      status: "closed",
      executionMode: "live",
      orderId: "venue-entry",
      symbol: "BTCUSDT",
      direction: "long",
      realizedPnL: 2,
      totalExecutedQuantity: 1,
      entryPrice: 100,
      closePrice: 102,
    }])
    mockGetLivePositions.mockResolvedValue([])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-real-only",
    })

    expect(response.body.stats).toMatchObject({
      closed_positions: 1,
      realized_pnl: 2,
      last_50_pnl: 2,
    })
  })

  test("quarantines incomplete venue settlement and parses numeric millisecond timestamps", async () => {
    const openedAt = Date.UTC(2026, 7, 26, 10, 0, 0)
    const closedAt = openedAt + 30 * 60_000
    mockGetClosedLivePositions.mockResolvedValue([{
      id: "pending-venue-close",
      status: "closed",
      executionMode: "live",
      orderId: "entry-pending",
      symbol: "ETHUSDT",
      direction: "short",
      realizedPnL: 0,
      realizedPnlComplete: false,
      realizedPnlSource: "exchange_unresolved",
      totalExecutedQuantity: 1,
      entryPrice: 100,
      createdAt: openedAt,
      closedAt,
    }])
    mockGetLivePositions.mockResolvedValue([])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-pending",
    })
    const stats = response.body.stats

    expect(stats).toMatchObject({
      total_positions: 1,
      closed_positions: 1,
      settled_closed_positions: 0,
      accounting_pending: 1,
      accounting_complete: false,
      accounting_coverage_percent: 0,
      realized_pnl: 0,
      wins: 0,
      losses: 0,
      break_even: 0,
      profit_factor: null,
    })
    expect(stats.last_50_positions).toEqual([
      expect.objectContaining({
        id: "pending-venue-close",
        pnl: null,
        pnl_percent: null,
        holding_time_min: 30,
        accounting_status: "pending",
      }),
    ])
  })

  test("keeps settled PnL without an ROI denominator and represents loss-free PF explicitly", async () => {
    mockGetClosedLivePositions.mockResolvedValue([{
      id: "settled-win-without-margin",
      status: "closed",
      executionMode: "live",
      symbol: "BTCUSDT",
      direction: "long",
      averageExecutionPrice: "",
      entryPrice: null,
      entry_price: 100,
      closePrice: "",
      exit_price: 101,
      realizedPnL: 1,
      closedAt: "2026-08-26T10:00:00.000Z",
    }, {
      id: "settled-break-even",
      status: "closed",
      executionMode: "live",
      symbol: "ETHUSDT",
      direction: "short",
      realizedPnL: 0,
      closedAt: "2026-08-26T09:00:00.000Z",
    }])
    mockGetLivePositions.mockResolvedValue([])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-infinite",
    })
    const stats = response.body.stats

    expect(stats).toMatchObject({
      settled_closed_positions: 2,
      accounting_pending: 0,
      wins: 1,
      losses: 0,
      break_even: 1,
      win_rate: 100,
      profit_factor: null,
      profit_factor_infinite: true,
      profit_factor_last_50: null,
      profit_factor_last_50_infinite: true,
    })
    expect(stats.last_50_positions[0]).toMatchObject({
      id: "settled-win-without-margin",
      entry_price: 100,
      exit_price: 101,
      pnl: 1,
      pnl_percent: null,
      accounting_status: "settled",
    })
  })

  test("keeps the operational window at 50 while computing PF75 from 75 terminal rows", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `closed-${index}`,
      status: "closed",
      executionMode: "live",
      symbol: "BTCUSDT",
      direction: "long",
      realizedPnL: index < 50 ? (index % 2 === 0 ? 2 : -1) : -1,
      closedAt: new Date(Date.UTC(2026, 7, 26, 12, 0, 0) - index * 60_000).toISOString(),
    }))
    mockGetClosedLivePositions.mockResolvedValue(rows)
    mockGetLivePositions.mockResolvedValue([])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-windows",
    })
    const stats = response.body.stats

    expect(stats).toMatchObject({
      closed_positions: 50,
      settled_closed_positions: 50,
      wins: 25,
      losses: 25,
      realized_pnl: 25,
      profit_factor: 2,
      profit_factor_last_50: 2,
      profit_factor_last_75: 1,
      history_limit: 50,
      analytics_history_limit: 75,
    })
    expect(stats.last_50_positions).toHaveLength(50)
  })

  test("pending closes consume their chronological PF window without becoming break-even", async () => {
    mockGetClosedLivePositions.mockResolvedValue([
      {
        id: "pending-newest",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnl: 0,
        realizedPnlComplete: false,
        closedAt: "2026-08-26T12:00:00.000Z",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `settled-${index}`,
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        realizedPnL: index === 11 ? -10 : 1,
        closedAt: new Date(Date.UTC(2026, 7, 26, 11, 59, 0) - index * 60_000).toISOString(),
      })),
    ])
    mockGetLivePositions.mockResolvedValue([])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-window-pending",
    })
    const stats = response.body.stats

    // The loss is the 13th terminal close and therefore outside "last 12".
    expect(stats).toMatchObject({
      accounting_pending: 1,
      profit_factor_last_12: null,
      profit_factor_last_12_infinite: true,
      wins: 11,
      losses: 1,
    })
  })

  test("requires an explicit active connection instead of silently reading X01", async () => {
    const response = await GET({ url: "http://localhost/api/trade-engine/pnl-stats" })
    expect(response.init).toEqual({ status: 400 })
    expect(response.body.error).toContain("connection_id")
  })
})
