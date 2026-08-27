const mockInitRedis = jest.fn()
const mockGetAllConnections = jest.fn()
const mockGetLiveExecutionSummary = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: unknown) => ({ body, init }),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
}))

jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: (...args: unknown[]) => mockGetLiveExecutionSummary(...args),
}))

const { GET } = require("@/app/api/positions/stats/route")

const summary = {
  totalPositions: 5,
  openPositions: 2,
  openSymbols: 2,
  openOrders: 3,
  openOrderSymbols: 2,
  entryOrders: 1,
  controlOrders: 2,
  closedPositions: 3,
  settledClosedPositions: 3,
  accountingPending: 0,
  wins: 2,
  losses: 1,
  breakEven: 0,
  realizedPnl: 4,
  unrealizedPnl: -1,
  avgWin: 3,
  avgLoss: -2,
  largestWin: 4,
  largestLoss: -2,
  complete: false,
  exchange: { complete: true },
}

describe("positions stats status views", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetAllConnections.mockResolvedValue([{ id: "x02" }])
    mockGetLiveExecutionSummary.mockResolvedValue(summary)
  })

  test("open view excludes closed outcomes and realized PnL", async () => {
    const response = await GET({
      url: "http://localhost/api/positions/stats?connectionId=x02&status=open",
    })

    expect(response.body.stats).toMatchObject({
      total_positions: 2,
      active_positions: 2,
      closed_positions: 0,
      settled_closed_positions: 0,
      accounting_pending: 0,
      total_pnl: -1,
      realized_pnl: 0,
      unrealized_pnl: -1,
      win_count: 0,
      loss_count: 0,
      win_rate: null,
      avg_win: null,
      data_available: true,
    })
  })

  test("closed view excludes current exposure, orders and unrealized PnL", async () => {
    const response = await GET({
      url: "http://localhost/api/positions/stats?connectionId=x02&status=closed",
    })

    expect(response.body.stats).toMatchObject({
      total_positions: 3,
      active_positions: 0,
      open_positions: 0,
      open_orders: 0,
      closed_positions: 3,
      settled_closed_positions: 3,
      total_pnl: 4,
      realized_pnl: 4,
      unrealized_pnl: 0,
      win_count: 2,
      loss_count: 1,
      win_rate: 2 / 3 * 100,
    })
  })

  test("accounting completeness includes bounded coverage and exchange state", async () => {
    const response = await GET({
      url: "http://localhost/api/positions/stats?connectionId=x02",
    })

    expect(response.body.stats.accounting_pending).toBe(0)
    expect(response.body.stats.accounting_complete).toBe(false)
  })
})
