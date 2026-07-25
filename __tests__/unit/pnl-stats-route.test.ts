const mockQuery = jest.fn()

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: unknown) => ({ body, init }),
  },
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
}))

jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

const { GET } = require("@/app/api/trade-engine/pnl-stats/route")

describe("trade-engine PnL statistics", () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  test("counts each valid win once and computes last-12/25/75 profit factors exactly", async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          id: "win",
          symbol: "BTCUSDT",
          direction: "long",
          entry_price: 100,
          exit_price: 110,
          quantity: 1,
          opened_at: "2026-07-25T10:00:00.000Z",
          closed_at: "2026-07-25T11:00:00.000Z",
          realized_pnl: 10,
          realized_pnl_percent: 10,
        },
        {
          id: "loss",
          symbol: "ETHUSDT",
          direction: "short",
          entry_price: 100,
          exit_price: 105,
          quantity: 1,
          opened_at: "2026-07-25T12:00:00.000Z",
          closed_at: "2026-07-25T11:00:00.000Z",
          realized_pnl: -5,
          realized_pnl_percent: -5,
        },
        {
          id: "invalid",
          realized_pnl: "not-a-number",
          realized_pnl_percent: 1,
        },
      ])
      .mockResolvedValueOnce([{ count: "3" }])

    const response = await GET({
      url: "http://localhost/api/trade-engine/pnl-stats?connection_id=conn-stats",
    })
    const stats = response.body.stats

    expect(stats).toMatchObject({
      total_positions: 2,
      closed_positions: 2,
      open_positions: 3,
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
})
