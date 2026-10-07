/**
 * L6: /api/settings/connections/[id]/statistics read its Historic summary
 * from the bare prehistoric:{id} hash and field names nothing writes. The
 * Historic writer fills the engine-scoped hash with its own fields.
 */
const hashes = new Map<string, Record<string, string>>()

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getSettings: jest.fn(async () => ({})),
  getRedisClient: () => ({
    hgetall: async (key: string) => hashes.get(key) || {},
    smembers: async () => [],
  }),
}))
jest.mock("@/lib/live-execution-summary", () => ({
  getLiveExecutionSummary: jest.fn(async () => ({
    totalTrades: 0, totalPositions: 0, openPositions: 0, openSymbols: 0, openOrders: 0, openOrderSymbols: 0,
    entryOrders: 0, controlOrders: 0, positionsDataAvailable: false, ordersDataAvailable: false,
    positionsSnapshotError: null, ordersSnapshotError: null, excludedUntrackedPositions: 0,
    excludedUntrackedOrders: 0, exchange: { complete: false }, closedPositions: 0, settledClosedPositions: 0,
    accountingPending: 0, complete: true, wins: 0, losses: 0, breakEven: 0, realizedPnl: 0, unrealizedPnl: 0,
    effectivePnl: 0, avgLoss: null, winRate: null, sourceCounts: {},
  })),
}))

const { GET } = require("@/app/api/settings/connections/[id]/statistics/route")

describe("connection statistics Historic summary", () => {
  test("reads the engine-scoped prehistoric hash the Historic writer fills", async () => {
    hashes.set("connection:conn-l6", { id: "conn-l6", name: "L6", exchange: "bingx" })
    hashes.set("prehistoric:conn-l6:main", {
      symbols_processed: "18",
      symbols_total: "20",
      candles_loaded: "86400",
      indicators_calculated: "1234",
      intervals_processed: "512",
      historic_avg_profit_factor: "1.42",
      historic_avg_profit_factor_count: "37",
      updated_at: "2026-10-05T12:00:00.000Z",
    })

    const response = await GET({} as any, { params: Promise.resolve({ id: "conn-l6" }) })
    const body = await response.json()

    expect(body.prehistoric).toMatchObject({
      source: "scoped",
      symbols_analyzed: 18,
      symbols_total: 20,
      data_points_loaded: 86400,
      total_indications: 1234,
      intervals_processed: 512,
      avg_profit_factor: 1.42,
      avg_profit_factor_available: true,
      last_updated: "2026-10-05T12:00:00.000Z",
    })
  })
})
