const mockGetLivePositions = jest.fn()
const mockGetClosedLivePositions = jest.fn()

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

const { GET } = require("@/app/api/trade-engine/pnl-stats/route")

describe("trade-engine PnL statistics", () => {
  beforeEach(() => {
    mockGetLivePositions.mockReset()
    mockGetClosedLivePositions.mockReset()
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
      },
    ])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-stats",
    })
    const stats = response.body.stats

    expect(mockGetLivePositions).toHaveBeenCalledWith("conn-stats")
    expect(mockGetClosedLivePositions).toHaveBeenCalledWith("conn-stats", 1000)
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
      profit_factor_last_75: 2,
      avg_holding_time_min: 30,
    })
    expect(stats.last_25_positions).toHaveLength(2)
    expect(stats.last_25_positions[1].holding_time_min).toBe(0)
  })

  test("requires an explicit active connection instead of silently reading X01", async () => {
    const response = await GET({ url: "http://localhost/api/trade-engine/pnl-stats" })
    expect(response.init).toEqual({ status: 400 })
    expect(response.body.error).toContain("connection_id")
  })
})
