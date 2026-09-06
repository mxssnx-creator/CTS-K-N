const mockHashes = new Map<string, Record<string, string>>()
const mockConnection = jest.fn()
const mockHgetall = jest.fn(async (key: string) => mockHashes.get(key) || {})
jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => ({
    hgetall: mockHgetall,
    scard: async () => 20,
    get: async () => null,
    dbSize: async () => 0,
  }),
  getConnection: async () => mockConnection(),
  getSettings: async () => ({}),
  getAppSettings: async () => ({}),
}))
jest.mock("@/lib/trade-engine", () => ({ getGlobalCoordinator: () => null }))
const { GET } = require("@/app/api/connections/progression/[id]/stats/route")

describe("progression uses the engine's durable operator basket", () => {
  beforeEach(() => {
    mockHashes.clear()
    mockHgetall.mockClear()
    mockConnection.mockReturnValue({
      force_symbols: Array.from({ length: 20 }, (_, i) => `CURRENT${i}`),
      connection_settings: { force_symbols: Array.from({ length: 32 }, (_, i) => `OLD${i}`) },
    })
  })

  test.each(["runtime", "full"])("%s view prefers the canonical operator mirror over stale nested selection", async view => {
    const id = `basket-${view}`
    mockHashes.set(`connection_settings:${id}`, { force_symbols: JSON.stringify(["LEGACY"]) })
    mockHashes.set(`settings:connection_settings:${id}`, {
      force_symbols: JSON.stringify(Array.from({ length: 20 }, (_, i) => `CURRENT${i}`)),
    })
    const response = await GET({ url: `http://localhost/api/connections/progression/${id}/stats?view=${view}` },
      { params: Promise.resolve({ id }) })
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.historic).toMatchObject({ symbolsProcessed: 20, symbolsTotal: 20, progressPercent: 100 })
    if (view === "runtime") expect(body.symbolCount).toBe(20)
    else expect(body.strategyRows.snapshot.coverage.total).toBe(20)
  })

  test("keeps existing snapshot fallback when no durable operator selection exists", async () => {
    const response = await GET({ url: "http://localhost/api/connections/progression/no-overlay/stats?view=runtime" },
      { params: Promise.resolve({ id: "no-overlay" }) })
    const body = await response.json()
    expect(body.historic).toMatchObject({ symbolsProcessed: 20, symbolsTotal: 32, progressPercent: 63 })
  })
})
