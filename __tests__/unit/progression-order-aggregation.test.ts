jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
}))

const hgetall = jest.fn(async (key: string) => {
  if (key === "live_orders_by_symbol:conn-1") {
    return {
      "BTCUSDT:long:placed": "2",
      "BTCUSDT:long:filled": "1",
      "BTCUSDT:long:failed": "1",
      "BTCUSDT:short:placed": "3",
      "BTCUSDT:short:filled": "2",
      "ETHUSDT:short:failed": "4",
      SOLUSDT: JSON.stringify({ side: "sell", count: 2, failed: 1 }),
      XRPUSDT: JSON.stringify({ direction: "long", placed: 5, filled: 4, failed: 1 }),
      "BROKEN:side:ignored": "99",
      MALFORMED: "{not json",
    }
  }
  return {}
})

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    hgetall,
    scard: jest.fn(async () => 0),
    get: jest.fn(async () => null),
    dbSize: jest.fn(async () => 0),
  })),
  getSettings: jest.fn(async () => ({})),
  getConnection: jest.fn(async () => ({})),
  getAppSettings: jest.fn(async () => ({})),
}))
jest.mock("@/lib/volume-calculator", () => ({
  VolumeCalculator: {
    resolveLiveEngine: jest.fn(() => ({ mainVolumeFactor: 1, presetVolumeFactor: 1, tradeMode: "main" })),
  },
}))
jest.mock("@/lib/trade-engine/closed-position-aggregation", () => ({
  aggregateLastXClosedPositions: jest.fn(() => ({ positions: [], summary: {} })),
}))
jest.mock("@/lib/trade-engine", () => ({ getGlobalCoordinator: jest.fn(() => null) }))
jest.mock("@/lib/trade-engine/symbol-selection-ownership", () => ({
  normalizeSymbolList: jest.fn((value) => (Array.isArray(value) ? value : [])),
}))

const { GET } = require("@/app/api/connections/progression/[id]/stats/route")

describe("progression stats order aggregation", () => {
  it("uses one aggregation for mixed canonical and legacy rows in rows and direction totals", async () => {
    const response = await GET({} as Request, { params: Promise.resolve({ id: "conn-1" }) })
    expect(response.body.error).toBeUndefined()
    const live = response.body.liveExecution

    expect(live.ordersByDirection).toEqual({
      long: { placed: 7, filled: 5, failed: 2 },
      short: { placed: 5, filled: 4, failed: 5 },
    })

    expect(live.ordersBySymbol).toEqual([
      {
        symbol: "XRPUSDT",
        long: { placed: 5, filled: 4, failed: 1 },
        short: { placed: 0, filled: 0, failed: 0 },
      },
      {
        symbol: "BTCUSDT",
        long: { placed: 2, filled: 1, failed: 1 },
        short: { placed: 3, filled: 2, failed: 0 },
      },
      {
        symbol: "SOLUSDT",
        long: { placed: 0, filled: 0, failed: 0 },
        short: { placed: 2, filled: 2, failed: 1 },
      },
      {
        symbol: "ETHUSDT",
        long: { placed: 0, filled: 0, failed: 0 },
        short: { placed: 0, filled: 0, failed: 4 },
      },
    ])
  })
})
