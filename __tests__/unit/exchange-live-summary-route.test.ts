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
  recordAndCalculateExchangeAccountPerformance15h: jest.fn(async () => ({ dataAvailable: true })),
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

  test("does not turn a failed Redis read into a successful empty account", async () => {
    mockGetAllConnections.mockRejectedValueOnce(new Error("Redis unavailable"))
    const response = await GET(new Request("http://localhost/api/exchange/live-summary?connectionId=bingx-x02"))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      success: false, error: "live_summary_unavailable",
      totals: { positionsDataAvailable: false, ordersDataAvailable: false, accountDataAvailable: false },
    })
  })

  test.each([null, undefined, ""])("does not certify a missing balance as zero (%s)", async (balance) => {
    mockGetSettings.mockResolvedValue({ balance, timestamp: Date.now() })
    const response = await GET(new Request("http://localhost/api/exchange/live-summary?connectionId=bingx-x02"))
    expect((await response.json()).totals.accountDataAvailable).toBe(false)
  })

  test("uses account equity and available margin independently of tracked CTS exposure", async () => {
    mockGetSettings.mockResolvedValue({ balance: 100, equity: 123, availableMargin: 87, timestamp: Date.now(), is_fallback: false })
    const response = await GET(new Request("http://localhost/api/exchange/live-summary?connectionId=bingx-x02"))
    const body = await response.json()
    expect(body.connections[0].balance).toMatchObject({
      total: 100, equity: 123, available: 87, dataAvailable: true, equityDataAvailable: true, availableDataAvailable: true,
    })
    expect(body.totals).toMatchObject({ totalBalance: 100, equity: 123, availableBalance: 87, accountDataAvailable: true })
  })

  test("a legacy wallet-only cache never fabricates account equity or free margin", async () => {
    mockGetSettings.mockResolvedValue({ balance: 100, timestamp: Date.now(), is_fallback: false })
    const response = await GET(new Request("http://localhost/api/exchange/live-summary?connectionId=bingx-x02"))
    const body = await response.json()
    expect(body.connections[0].balance).toMatchObject({ total: 100, dataAvailable: true, equityDataAvailable: false, availableDataAvailable: false })
    expect(body.totals.accountDataAvailable).toBe(false)
    expect(body.connections[0].balance.equity).not.toBe(104.5)
  })

  test("preserves measured zero free margin and negative equity", async () => {
    mockGetSettings.mockResolvedValue({ balance: 100, equity: -5, availableMargin: 0, timestamp: Date.now(), is_fallback: false })
    const response = await GET(new Request("http://localhost/api/exchange/live-summary?connectionId=bingx-x02"))
    expect((await response.json()).connections[0].balance).toMatchObject({ equity: -5, available: 0, equityDataAvailable: true, availableDataAvailable: true })
  })
})
