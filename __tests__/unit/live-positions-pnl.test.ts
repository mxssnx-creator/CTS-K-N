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
  })
})
