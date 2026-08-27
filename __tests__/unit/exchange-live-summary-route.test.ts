const mockInitRedis = jest.fn()
const mockGetRedisClient = jest.fn()
const mockGetSettings = jest.fn()
const mockGetAllConnections = jest.fn()
const mockGetExchangeLiveStateSummary = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
}))

jest.mock("@/lib/exchange-live-state-summary", () => ({
  getExchangeLiveStateSummary: (...args: unknown[]) => mockGetExchangeLiveStateSummary(...args),
}))

jest.mock("@/lib/exchange-account-performance", () => ({
  calculateExchangeAccountPerformance15h: () => ({ dataAvailable: false }),
  recordAndCalculateExchangeAccountPerformance15h: jest.fn(),
}))

const { GET } = require("@/app/api/exchange/live-summary/route")

describe("exchange live summary route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetRedisClient.mockReturnValue({
      smembers: jest.fn().mockResolvedValue([]),
      hgetall: jest.fn().mockResolvedValue({}),
    })
    mockGetSettings.mockResolvedValue(null)
    mockGetAllConnections.mockResolvedValue([{
      id: "bingx-x02",
      name: "BingX X02 Prod-VST",
      exchange: "bingx",
      is_assigned: "1",
      is_active_inserted: "1",
      is_enabled_dashboard: "1",
      // Base-panel enablement is intentionally independent from Main.
      is_enabled: "0",
    }])
    mockGetExchangeLiveStateSummary.mockResolvedValue({
      source: "exchange-api",
      positionsStatus: { available: true },
      ordersStatus: { available: true },
      tracking: {
        attributionComplete: true,
        venuePositionsExcluded: 2,
        venueOrdersExcluded: 1,
      },
      openPositions: 3,
      longPositions: 2,
      shortPositions: 1,
      unrealizedPnl: 4.5,
      positionNotionalUsd: 75,
      positionsBySymbol: [],
      openOrders: 6,
    })
  })

  test("uses Main processing eligibility instead of the unrelated Base enable flag", async () => {
    const response = await GET(new Request(
      "http://localhost/api/exchange/live-summary?connectionId=bingx-x02",
    ))
    const body = await response.json()

    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]).toMatchObject({
      connectionId: "bingx-x02",
      openPositions: 3,
      openOrders: 6,
      exchangeScope: "cts_tracked_only",
      excludedUntrackedPositions: 2,
      excludedUntrackedOrders: 1,
    })
    expect(body.totals).toMatchObject({
      openPositions: 3,
      openOrders: 6,
      positionsDataAvailable: true,
      ordersDataAvailable: true,
      directionIntegrity: true,
    })
  })
})
