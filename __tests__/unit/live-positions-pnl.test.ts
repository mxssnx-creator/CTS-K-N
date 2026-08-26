import { GET } from "@/app/api/trading/live-positions/route"

const mockGetLivePositions = jest.fn()
const mockGetClosedLivePositions = jest.fn()
const mockCalculateLivePositionStats = jest.fn()
const mockInitRedis = jest.fn()
const mockGetConnection = jest.fn()
const mockKeys = jest.fn()
const mockGet = jest.fn()

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: (...args: unknown[]) => mockGetLivePositions(...args),
  getClosedLivePositions: (...args: unknown[]) => mockGetClosedLivePositions(...args),
  calculateLivePositionStats: (...args: unknown[]) => mockCalculateLivePositionStats(...args),
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getRedisClient: () => ({ keys: mockKeys, get: mockGet }),
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
}))

jest.mock("@/lib/connection-state-utils", () => ({
  isTruthyFlag: (value: unknown) => value === true || value === "1" || value === 1,
  isConnectionLiveTradeEnabled: (connection: Record<string, unknown>) =>
    connection?.is_live_trade === true || connection?.is_live_trade === "1" || connection?.is_live_trade === 1,
}))

describe("live positions PnL enrichment", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetClosedLivePositions.mockResolvedValue([])
    mockCalculateLivePositionStats.mockResolvedValue({
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    })
    mockGetConnection.mockResolvedValue({ is_live_trade: "1", live_trade_requested: "1" })
    mockKeys.mockResolvedValue([])
  })

  test("preserves exchange unrealizedPnl zero instead of recalculating from mark price", async () => {
    mockGetLivePositions.mockResolvedValue([
      {
        id: "pos-zero-pnl",
        status: "open",
        direction: "long",
        averageExecutionPrice: 100,
        executedQuantity: 2,
        leverage: 10,
        exchangeData: {
          source: "exchange",
          exchangePositionId: "exchange-pos-zero-pnl",
          unrealizedPnl: 0,
          markPrice: 120,
        },
        createdAt: 1,
      },
    ])

    const response = await GET(new Request("http://localhost/api/trading/live-positions?connection_id=bingx-x01"))
    const body = await response.json()

    expect(body.positions).toHaveLength(1)
    expect(body.positions[0]).toMatchObject({
      id: "pos-zero-pnl",
      unrealizedPnL: 0,
      unrealizedRoi: 0,
    })
    expect(body.positions[0].unrealizedPnL).not.toBe(40)
    expect(body.stats.all.totalUnrealizedPnL).toBe(0)
    expect(body.stats.totalFilled).toBe(1)
    expect(body.counts.executed).toBe(1)
  })

  test("returns a compact read model instead of repeating recovery lineage on every poll", async () => {
    mockGetLivePositions.mockResolvedValue([
      {
        id: "pos-compact",
        status: "simulated",
        direction: "long",
        symbol: "BTCUSDT",
        averageExecutionPrice: 100,
        executedQuantity: 1,
        fills: [{ id: "fill-1", diagnostics: { veryLarge: "x".repeat(2_000) } }],
        accumulatedSetKeys: ["set-a", "set-b"],
        partialOrderExecutions: [{ id: "partial-1", details: { veryLarge: "x".repeat(2_000) } }],
        exchangeData: {
          markPrice: 101,
          source: "simulation",
          internalRecoveryPayload: { veryLarge: "x".repeat(2_000) },
        },
        createdAt: 1,
      },
    ])

    const response = await GET(new Request("http://localhost/api/trading/live-positions?connection_id=bingx-x01"))
    const body = await response.json()
    const row = body.positions[0]

    expect(row).toMatchObject({ id: "pos-compact", symbol: "BTCUSDT", exchangeData: { markPrice: 101 } })
    expect(row).not.toHaveProperty("fills")
    expect(row).not.toHaveProperty("accumulatedSetKeys")
    expect(row).not.toHaveProperty("partialOrderExecutions")
    expect(row.exchangeData).not.toHaveProperty("internalRecoveryPayload")
  })

  test("preserves Signal-Trailing lane identity and dynamic profile in the compact view", async () => {
    mockGetLivePositions.mockResolvedValue([
      {
        id: "pos-signal-trailing",
        status: "simulated",
        direction: "long",
        symbol: "BTCUSDT",
        indicationType: "signal",
        setVariant: "trailing",
        executionLane: "signal_trailing",
        averageExecutionPrice: 100,
        executedQuantity: 1,
        trailingProfile: {
          mode: "signal_dynamic",
          startRatio: 0,
          stopRatio: 0.008,
          stepRatio: 0.004,
          minStopRatio: 0.008,
          positiveMoveRatio: 0.4,
          updateStopRangeRatio: 0.5,
        },
        createdAt: 1,
      },
    ])

    const response = await GET(new Request("http://localhost/api/trading/live-positions?connection_id=bingx-x01"))
    const body = await response.json()

    expect(body.positions[0]).toMatchObject({
      id: "pos-signal-trailing",
      indicationType: "signal",
      setVariant: "trailing",
      executionLane: "signal_trailing",
      trailingProfile: {
        mode: "signal_dynamic",
        minStopRatio: 0.008,
        positiveMoveRatio: 0.4,
        updateStopRangeRatio: 0.5,
      },
    })
  })

  test("exposes protection coverage and recoverable processing states without private mutation tokens", async () => {
    mockGetLivePositions.mockResolvedValue([{
      id: "pos-protection-state",
      status: " CLOSING_PARTIAL ",
      direction: "long",
      symbol: "ETHUSDT",
      averageExecutionPrice: 100,
      executedQuantity: 0.8,
      totalExecutedQuantity: 1,
      closedQuantity: 0.2,
      stopLossOrderId: "sl-1",
      takeProfitOrderId: "tp-1",
      stopLossArmedQuantity: 0.8,
      takeProfitArmedQuantity: 0.8,
      protectionArmedQuantity: 0.8,
      submissionState: "confirmed",
      pendingProtectionOrders: {
        stop_loss: { clientOrderId: "sl-client", triggerPrice: 99, quantity: 0.8 },
      },
      pendingSystemAction: {
        token: "private-system-token",
        phase: "partial_wait",
        reason: "operator close",
        startedAt: 10,
        updatedAt: 11,
        requestedQuantity: 1,
        appliedFilledQuantity: 0.2,
      },
      pendingQuantityMutation: {
        token: "private-quantity-token",
        phase: "position_verify",
        reason: "partial close",
        quantityBefore: 1,
        startedAt: 10,
        updatedAt: 11,
      },
      fills: [{ quantity: 1, price: 100 }],
      createdAt: 1,
    }])

    const response = await GET(new Request("http://localhost/api/trading/live-positions?connection_id=bingx-x01"))
    const body = await response.json()

    expect(body.counts).toMatchObject({
      open: 1,
      closing_partial: 1,
      executed: 1,
    })
    expect(body.positions[0]).toMatchObject({
      stopLossArmedQuantity: 0.8,
      takeProfitArmedQuantity: 0.8,
      protectionArmedQuantity: 0.8,
      submissionState: "confirmed",
      pendingProtectionLegs: ["stop_loss"],
      pendingProtectionOrders: {
        stop_loss: { clientOrderId: "sl-client", triggerPrice: 99, quantity: 0.8 },
      },
      pendingSystemAction: { phase: "partial_wait", appliedFilledQuantity: 0.2 },
      pendingQuantityMutation: { phase: "position_verify", quantityBefore: 1 },
    })
    expect(JSON.stringify(body.positions[0])).not.toContain("private-system-token")
    expect(JSON.stringify(body.positions[0])).not.toContain("private-quantity-token")
  })

  test("deduplicates open-to-closed transitions, sorts ISO timestamps, and sanitizes invalid limits", async () => {
    mockGetLivePositions.mockResolvedValue([
      {
        id: "transition",
        status: "closing",
        executionMode: "live",
        symbol: "BTCUSDT",
        createdAt: "2026-08-26T10:00:00.000Z",
        unrealizedPnL: 50,
      },
      {
        id: "older-open",
        status: "open",
        executionMode: "live",
        symbol: "ETHUSDT",
        createdAt: "2026-08-26T09:00:00.000Z",
        unrealizedPnL: 1,
      },
    ])
    mockGetClosedLivePositions.mockResolvedValue([
      {
        id: "transition",
        status: "closed",
        executionMode: "live",
        symbol: "BTCUSDT",
        createdAt: "2026-08-26T10:00:00.000Z",
        closedAt: "2026-08-26T11:00:00.000Z",
        realizedPnL: -2,
      },
      {
        id: "newer-closed",
        status: "closed",
        executionMode: "live",
        symbol: "SOLUSDT",
        createdAt: "2026-08-26T12:00:00.000Z",
        closedAt: "2026-08-26T12:30:00.000Z",
        realizedPnL: 3,
      },
    ])

    const response = await GET(new Request(
      "http://localhost/api/trading/live-positions?connection_id=bingx-x01&closedLimit=invalid",
    ))
    const body = await response.json()

    expect(mockGetClosedLivePositions).toHaveBeenCalledWith("bingx-x01", 200)
    expect(body.positions.map((position: any) => position.id)).toEqual([
      "newer-closed",
      "transition",
      "older-open",
    ])
    expect(body.counts).toMatchObject({
      total: 3,
      open: 1,
      closed: 2,
      settledClosed: 2,
    })
    expect(body.stats.all).toMatchObject({
      total: 3,
      open: 1,
      closed: 2,
      totalRealizedPnL: 1,
      totalUnrealizedPnL: 1,
    })
  })
})
