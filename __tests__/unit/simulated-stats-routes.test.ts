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
  isConnectionAssignedToMain: () => true,
}))

jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: (...args: unknown[]) => mockGetLiveExecutionSummary(...args),
}))

import { computePositionBookStats } from "@/lib/position-book-stats"

const { GET } = require("@/app/api/positions/stats/route")

const simulatedRows = [
  { status: "closed", executionMode: "simulation", symbol: "BCHUSDT", executedQuantity: 1, realizedPnL: 6, closedAt: 1 },
  { status: "closed", executionMode: "simulation", symbol: "BCHUSDT", executedQuantity: 1, realizedPnL: -2, closedAt: 2 },
  { status: "simulated", symbol: "XRPUSDT", executedQuantity: 3, entryPrice: 1, unrealizedPnL: 0.25 },
]

function summary(openPositions: number) {
  return {
    totalPositions: openPositions,
    openPositions,
    openSymbols: 0, openOrders: 0, openOrderSymbols: 0, entryOrders: 0, controlOrders: 0,
    closedPositions: 0, settledClosedPositions: 0, accountingPending: 0,
    wins: 0, losses: 0, breakEven: 0, realizedPnl: 0, unrealizedPnl: 0,
    avgWin: null, avgLoss: null, largestWin: null, largestLoss: null,
    excludedUntrackedPositions: 0, excludedUntrackedOrders: 0,
    positionsDataAvailable: true, ordersDataAvailable: true,
    complete: true,
    exchange: { complete: true },
    books: {
      real: computePositionBookStats([]),
      simulated: computePositionBookStats(simulatedRows),
      unknown: computePositionBookStats([]),
    },
  }
}

describe("positions stats route reports an independent simulated book", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetAllConnections.mockResolvedValue([{ id: "a" }, { id: "b" }])
    mockGetLiveExecutionSummary.mockImplementation(async () => summary(0))
  })

  test("real counters stay exchange-only while simulated block carries paper results", async () => {
    const response = await GET({ url: "http://localhost/api/positions/stats" })
    expect(response.body.stats).toMatchObject({ open_positions: 0, closed_positions: 0, realized_pnl: 0 })
    expect(response.body.simulated).toMatchObject({
      open: 2,
      closed: 4,
      wins: 2,
      losses: 2,
      netPnl: 8,
      profitFactor: 3,
      unrealizedPnl: 0.5,
    })
    expect(response.body.real).toMatchObject({ total: 0, profitFactor: null, winRate: 0 })
  })

  test("summaries without books still return a zero simulated block", async () => {
    mockGetLiveExecutionSummary.mockImplementation(async () => ({ ...summary(1), books: undefined }))
    const response = await GET({ url: "http://localhost/api/positions/stats" })
    expect(response.body.simulated).toMatchObject({ total: 0, netPnl: 0, profitFactor: null })
    expect(response.body.stats.open_positions).toBe(2)
  })
})
