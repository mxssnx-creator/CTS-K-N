const mockGetOrCreateConnector = jest.fn()
const mockGetConnection = jest.fn()
const mockGetOpenLivePositionReadModelsStrict = jest.fn()
const mockGetClosedLivePositionReadModelsStrict = jest.fn()

jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: {
    getOrCreateConnector: (...args: unknown[]) => mockGetOrCreateConnector(...args),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
}))

jest.mock("@/lib/connection-state-utils", () => ({
  hasConnectionCredentials: () => true,
}))

jest.mock("@/lib/live-position-read-model", () => ({
  getOpenLivePositionReadModelsStrict: (...args: unknown[]) =>
    mockGetOpenLivePositionReadModelsStrict(...args),
  getClosedLivePositionReadModelsStrict: (...args: unknown[]) =>
    mockGetClosedLivePositionReadModelsStrict(...args),
}))

const {
  attributeSystemTrackedExchangePositions,
  clearExchangeLiveStateSummaryCache,
  buildSystemExchangeTrackingScope,
  getExchangeLiveStateSummary,
  isExchangeControlOrder,
  isSystemTrackedExchangeOrder,
  summarizeExchangeOrders,
  summarizeExchangePositions,
} = require("@/lib/exchange-live-state-summary")

describe("exchange live state summary", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearExchangeLiveStateSummaryCache()
    mockGetConnection.mockResolvedValue({ id: "bingx-real", api_key: "1234567890", api_secret: "1234567890" })
    mockGetOpenLivePositionReadModelsStrict.mockResolvedValue([])
    mockGetClosedLivePositionReadModelsStrict.mockResolvedValue([])
  })

  test("counts only non-zero venue positions and keeps directions independent", () => {
    expect(summarizeExchangePositions([
      { symbol: "BTC-USDT", positionAmt: "2", positionSide: "LONG", markPrice: "10", unrealizedPnl: "3" },
      { symbol: "BTC-USDT", positionAmt: "-1", positionSide: "SHORT", markPrice: "11", unrealizedPnl: "-1" },
      { symbol: "ETH-USDT", positionAmt: "0", positionSide: "LONG", markPrice: "20" },
    ])).toEqual({
      openPositions: 2,
      openPositionSymbols: 1,
      longPositions: 1,
      shortPositions: 1,
      positionQuantity: 3,
      positionNotionalUsd: 31,
      unrealizedPnl: 2,
      positionsBySymbol: [{
        symbol: "BTCUSDT",
        positions: 2,
        long: 1,
        short: 1,
        quantity: 3,
        notionalUsd: 31,
        unrealizedPnl: 2,
      }],
    })
  })

  test("separates entry orders from exchange control orders", () => {
    expect(isExchangeControlOrder({ type: "STOP_MARKET" })).toBe(true)
    expect(isExchangeControlOrder({ type: "LIMIT", reduceOnly: true })).toBe(true)
    expect(isExchangeControlOrder({ type: "LIMIT" })).toBe(false)
    expect(summarizeExchangeOrders([
      { symbol: "BTC-USDT", type: "LIMIT" },
      { symbol: "BTC-USDT", type: "STOP_MARKET" },
      { symbol: "ETH-USDT", type: "TAKE_PROFIT_MARKET" },
    ])).toMatchObject({
      openOrders: 3,
      openOrderSymbols: 2,
      entryOrders: 1,
      controlOrders: 2,
    })
  })

  test("attributes only CTS-tracked venue positions and orders", () => {
    const scope = buildSystemExchangeTrackingScope("bingx-real", [{
      id: "live-system-btc",
      status: "open",
      executionMode: "live",
      orderId: "entry-system-1",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 2,
      remainingQuantity: 0,
      stopLossOrderId: "sl-system-1",
      takeProfitOrderId: "tp-system-1",
      exchangeData: {
        clientOrderIds: [{ clientOrderId: "ctsbingxrealslBTCabc123" }],
      },
    }])

    expect(summarizeExchangePositions([
      { symbol: "BTCUSDT", positionAmt: 5, positionSide: "LONG", markPrice: 10, unrealizedPnl: 5 },
      { symbol: "ETHUSDT", positionAmt: 3, positionSide: "LONG", markPrice: 20, unrealizedPnl: 4 },
    ], scope)).toMatchObject({
      openPositions: 1,
      openPositionSymbols: 1,
      positionQuantity: 2,
      positionNotionalUsd: 20,
      unrealizedPnl: 2,
    })
    expect(attributeSystemTrackedExchangePositions([
      { symbol: "BTCUSDT", positionAmt: 5, positionSide: "LONG", unrealizedPnl: 5 },
      { symbol: "ETHUSDT", positionAmt: 3, positionSide: "LONG", unrealizedPnl: 4 },
    ], scope)).toEqual([expect.objectContaining({
      symbol: "BTCUSDT",
      direction: "long",
      venueQuantity: 5,
      quantity: 2,
      attributionRatio: 0.4,
    })])
    expect(isSystemTrackedExchangeOrder({ orderId: "sl-system-1" }, scope)).toBe(true)
    expect(isSystemTrackedExchangeOrder({ clientOrderId: "ctsbingxrealtpBTCxyz987" }, scope)).toBe(true)
    expect(isSystemTrackedExchangeOrder({ orderId: "manual-order" }, scope)).toBe(false)
    expect(summarizeExchangeOrders([
      { symbol: "BTCUSDT", orderId: "sl-system-1", type: "STOP_MARKET" },
      { symbol: "BTCUSDT", clientOrderId: "ctsbingxrealaccBTCxyz987", type: "LIMIT" },
      { symbol: "ETHUSDT", orderId: "manual-order", type: "LIMIT" },
    ], scope)).toMatchObject({
      openOrders: 2,
      openOrderSymbols: 1,
      entryOrders: 1,
      controlOrders: 1,
    })
  })

  test("reports untracked venue rows as excluded instead of account totals", async () => {
    mockGetOpenLivePositionReadModelsStrict.mockResolvedValue([{
      id: "live-system-btc",
      status: "open",
      executionMode: "live",
      orderId: "entry-system-1",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 1,
      stopLossOrderId: "sl-system-1",
    }])
    mockGetOrCreateConnector.mockResolvedValue({
      constructor: { name: "BingXConnector" },
      getPositions: jest.fn(async () => [
        { symbol: "BTCUSDT", positionAmt: 1, positionSide: "LONG", markPrice: 100 },
        { symbol: "ETHUSDT", positionAmt: 2, positionSide: "SHORT", markPrice: 50 },
      ]),
      getOpenOrders: jest.fn(async () => [
        { symbol: "BTCUSDT", orderId: "sl-system-1", type: "STOP_MARKET" },
        { symbol: "ETHUSDT", orderId: "manual-order", type: "LIMIT" },
      ]),
      getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: true, at: 1000 })),
      getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: true, at: 1001 })),
    })

    const snapshot = await getExchangeLiveStateSummary("bingx-real")

    expect(snapshot).toMatchObject({
      openPositions: 1,
      openPositionSymbols: 1,
      openOrders: 1,
      controlOrders: 1,
      tracking: {
        venuePositionsSeen: 2,
        venuePositionsExcluded: 1,
        venueOrdersSeen: 2,
        venueOrdersExcluded: 1,
        attributionComplete: true,
      },
    })
  })

  test("marks an empty successful exchange snapshot as authoritative", async () => {
    mockGetOrCreateConnector.mockResolvedValue({
      constructor: { name: "BingXConnector" },
      getPositions: jest.fn(async () => []),
      getOpenOrders: jest.fn(async () => []),
      getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: true, at: 1000 })),
      getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: true, at: 1001 })),
    })

    const snapshot = await getExchangeLiveStateSummary("bingx-real")

    expect(snapshot.complete).toBe(true)
    expect(snapshot.source).toBe("exchange-api")
    expect(snapshot.openPositions).toBe(0)
    expect(snapshot.openOrders).toBe(0)
  })

  test("never turns a failed connector snapshot into an authoritative zero", async () => {
    mockGetOrCreateConnector.mockResolvedValue({
      constructor: { name: "BingXConnector" },
      getPositions: jest.fn(async () => []),
      getOpenOrders: jest.fn(async () => []),
      getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: false, at: 1000, error: "rate_limit" })),
      getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: false, at: 1001, error: "rate_limit" })),
    })

    const snapshot = await getExchangeLiveStateSummary("bingx-real")

    expect(snapshot.complete).toBe(false)
    expect(snapshot.source).toBe("unavailable")
    expect(snapshot.positionsStatus.error).toBe("rate_limit")
    expect(snapshot.ordersStatus.error).toBe("rate_limit")
  })

  test("keeps overview routes available when connector creation fails", async () => {
    mockGetOrCreateConnector.mockRejectedValue(new Error("connector unavailable"))

    const snapshot = await getExchangeLiveStateSummary("bingx-real")

    expect(snapshot.complete).toBe(false)
    expect(snapshot.source).toBe("unavailable")
    expect(snapshot.positionsStatus).toMatchObject({
      available: false,
      error: "exchange_snapshot_unavailable",
    })
    expect(snapshot.ordersStatus).toMatchObject({
      available: false,
      error: "exchange_snapshot_unavailable",
    })
  })
})
