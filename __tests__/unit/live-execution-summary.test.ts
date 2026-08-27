const mockGetOpen = jest.fn()
const mockGetClosed = jest.fn()
const mockGetExchange = jest.fn()

jest.mock("@/lib/live-position-read-model", () => ({
  getOpenLivePositionReadModels: (...args: unknown[]) => mockGetOpen(...args),
  getClosedLivePositionReadModels: (...args: unknown[]) => mockGetClosed(...args),
  LIVE_POSITION_OPEN_READ_LIMIT: 2000,
  LIVE_POSITION_CLOSED_READ_LIMIT: 1000,
}))

jest.mock("@/lib/exchange-live-state-summary", () => ({
  getExchangeLiveStateSummary: (...args: unknown[]) => mockGetExchange(...args),
}))

const {
  clearLiveExecutionSummaryCache,
  getLiveExecutionSummary,
} = require("@/lib/live-execution-summary")

describe("live execution summary", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearLiveExecutionSummaryCache()
    mockGetOpen.mockResolvedValue([])
    mockGetClosed.mockResolvedValue([])
    mockGetExchange.mockResolvedValue({
      connectionId: "bingx-real",
      source: "unavailable",
      complete: false,
      positionsStatus: { available: false, fetchedAt: 0, error: "not mocked" },
      ordersStatus: { available: false, fetchedAt: 0, error: "not mocked" },
      openPositions: 0,
      openPositionSymbols: 0,
      longPositions: 0,
      shortPositions: 0,
      positionQuantity: 0,
      positionNotionalUsd: 0,
      unrealizedPnl: 0,
      positionsBySymbol: [],
      openOrders: 0,
      openOrderSymbols: 0,
      entryOrders: 0,
      controlOrders: 0,
      ordersBySymbol: [],
      generatedAt: 0,
    })
  })

  test("uses only executed exchange rows for headline PnL and results", async () => {
    mockGetOpen.mockResolvedValue([
      {
        id: "real-open",
        status: "open",
        executionMode: "live",
        orderId: "order-open",
        symbol: "BTCUSDT",
        executedQuantity: 2,
        averageExecutionPrice: 10,
        unrealizedPnL: 3,
      },
      {
        id: "paper-open",
        status: "simulated",
        executionMode: "simulation",
        executedQuantity: 9,
        averageExecutionPrice: 10,
        unrealizedPnL: 99,
      },
      // Compatibility indexes can briefly contain a terminal lifecycle. The
      // archive row below must replace it instead of double-counting it.
      {
        id: "real-win",
        status: "open",
        executionMode: "live",
        orderId: "order-win",
        executedQuantity: 1,
        averageExecutionPrice: 10,
      },
    ])
    mockGetClosed.mockResolvedValue([
      {
        id: "real-win",
        status: "closed",
        executionMode: "live",
        orderId: "order-win",
        totalExecutedQuantity: 1,
        averageExecutionPrice: 10,
        realizedPnL: 2,
        closedAt: Date.now(),
      },
      {
        id: "real-zero",
        status: "closed",
        executionMode: "live",
        orderId: "order-zero",
        totalExecutedQuantity: 1,
        averageExecutionPrice: 10,
        realizedPnL: 0,
        closedAt: Date.now(),
      },
      {
        id: "real-unsettled",
        status: "closed",
        executionMode: "live",
        orderId: "order-pending",
        totalExecutedQuantity: 1,
        averageExecutionPrice: 10,
        pnlAccountingComplete: false,
        realizedPnL: 0,
        closedAt: Date.now(),
      },
      {
        id: "real-missing",
        status: "closed",
        executionMode: "live",
        orderId: "order-missing",
        totalExecutedQuantity: 1,
        averageExecutionPrice: 10,
        closedAt: Date.now(),
      },
      {
        id: "legacy-price-domain-mismatch",
        status: "closed",
        executionMode: "live",
        orderId: "legacy-order",
        totalExecutedQuantity: 2,
        averageExecutionPrice: 100,
        closePrice: 0.001,
        realizedPnL: 100_000,
        openedAt: Date.now() - 60_000,
        closedAt: Date.now(),
      },
      {
        id: "paper-win",
        status: "closed",
        executionMode: "simulation",
        totalExecutedQuantity: 1,
        realizedPnL: 500,
        closedAt: Date.now(),
      },
      {
        id: "real-rejected",
        status: "rejected",
        executionMode: "live",
        orderId: "order-rejected",
        executedQuantity: 0,
      },
    ])

    const summary = await getLiveExecutionSummary("bingx-real")

    expect(mockGetOpen).toHaveBeenCalledWith("bingx-real", 2000)
    expect(mockGetClosed).toHaveBeenCalledWith("bingx-real", 1000)
    expect(summary.totalPositions).toBe(6)
    expect(summary.openPositions).toBe(1)
    expect(summary.openSymbols).toBe(1)
    expect(summary.openOrders).toBe(0)
    expect(summary.closedPositions).toBe(5)
    expect(summary.totalTrades).toBe(5)
    expect(summary.settledClosedPositions).toBe(2)
    expect(summary.accountingPending).toBe(3)
    expect(summary.realizedPnl).toBe(2)
    expect(summary.unrealizedPnl).toBe(3)
    expect(summary.wins).toBe(1)
    expect(summary.losses).toBe(0)
    expect(summary.breakEven).toBe(1)
    expect(summary.winRate).toBe(100)
    expect(summary.sourceCounts).toEqual({ real: 6, simulated: 2, unknown: 0 })
    expect(summary.coverage).toEqual({
      openRows: 3,
      closedRows: 7,
      openLimit: 2000,
      closedLimit: 1000,
      truncated: false,
    })
    expect(summary.complete).toBe(false)
  })

  test("uses authoritative exchange snapshots for current positions, symbols and orders", async () => {
    mockGetOpen.mockResolvedValue([{
      id: "stale-local",
      status: "open",
      executionMode: "live",
      orderId: "old-order",
      executedQuantity: 1,
      symbol: "OLDUSDT",
      unrealizedPnL: 99,
    }])
    mockGetExchange.mockResolvedValue({
      connectionId: "bingx-real",
      source: "exchange-api",
      complete: true,
      positionsStatus: { available: true, fetchedAt: Date.now(), error: null },
      ordersStatus: { available: true, fetchedAt: Date.now(), error: null },
      openPositions: 2,
      openPositionSymbols: 2,
      longPositions: 1,
      shortPositions: 1,
      positionQuantity: 3,
      positionNotionalUsd: 75,
      unrealizedPnl: 4.5,
      positionsBySymbol: [
        { symbol: "BTCUSDT", positions: 1, long: 1, short: 0, quantity: 1, notionalUsd: 50, unrealizedPnl: 3 },
        { symbol: "ETHUSDT", positions: 1, long: 0, short: 1, quantity: 2, notionalUsd: 25, unrealizedPnl: 1.5 },
      ],
      openOrders: 5,
      openOrderSymbols: 2,
      entryOrders: 1,
      controlOrders: 4,
      ordersBySymbol: [],
      generatedAt: Date.now(),
    })

    const summary = await getLiveExecutionSummary("bingx-real")

    expect(summary.openPositions).toBe(2)
    expect(summary.openSymbols).toBe(2)
    expect(summary.openOrders).toBe(5)
    expect(summary.entryOrders).toBe(1)
    expect(summary.controlOrders).toBe(4)
    expect(summary.positionsDataAvailable).toBe(true)
    expect(summary.ordersDataAvailable).toBe(true)
    expect(summary.positionsSnapshotError).toBeNull()
    expect(summary.ordersSnapshotError).toBeNull()
    expect(summary.unrealizedPnl).toBe(4.5)
    expect(summary.openVolumeUsd).toBe(75)
    expect(summary.complete).toBe(true)
  })

  test("keeps an unavailable exchange snapshot explicitly incomplete", async () => {
    const summary = await getLiveExecutionSummary("bingx-unavailable")

    expect(summary.exchange.complete).toBe(false)
    expect(summary.complete).toBe(false)
    expect(summary.positionsDataAvailable).toBe(false)
    expect(summary.ordersDataAvailable).toBe(false)
    expect(summary.positionsSnapshotError).toBe("not mocked")
    expect(summary.ordersSnapshotError).toBe("not mocked")
  })

  test("returns null performance metrics when no settled exchange result exists", async () => {
    mockGetClosed.mockResolvedValue([{
      id: "pending",
      status: "closed",
      executionMode: "live",
      orderId: "pending-order",
      totalExecutedQuantity: 1,
      pnlAccountingComplete: false,
      realizedPnL: 0,
    }])

    const summary = await getLiveExecutionSummary("bingx-empty")

    expect(summary.winRate).toBeNull()
    expect(summary.avgWin).toBeNull()
    expect(summary.avgLoss).toBeNull()
    expect(summary.largestWin).toBeNull()
    expect(summary.largestLoss).toBeNull()
    expect(summary.accountingPending).toBe(1)
  })
})
