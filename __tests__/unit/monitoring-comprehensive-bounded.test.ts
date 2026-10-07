/**
 * M15: /api/monitoring/comprehensive (polled every 3 s) loaded the pseudo and
 * live position rows of every stored connection plus 500 logs and INFO on
 * each request. It now counts only processed connections from cardinalities
 * and the results ledger and serves repeated/concurrent polls from one build.
 */
const hashes = new Map<string, Record<string, string>>()
const scard = jest.fn(async (key: string) => (key === "pseudo_positions:conn-a" ? 3 : key === "pseudo_positions:conn-b" ? 10 : 0))
const info = jest.fn(async () => "used_memory:1048576\r\n")
const getLogs = jest.fn(async () => [])
const getOpenLivePositionReadModels = jest.fn(async () => [])
const getClosedLivePositionReadModels = jest.fn(async () => [])

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => {
  const enabled = { id: "conn-a", name: "A", exchange: "bingx", is_enabled_dashboard: "1" }
  const disabled = { id: "conn-b", name: "B", exchange: "bingx", is_enabled_dashboard: "0" }
  return {
    initRedis: jest.fn(async () => undefined),
    getAllConnections: jest.fn(async () => [enabled, disabled]),
    getAssignedAndEnabledConnections: jest.fn(async () => [enabled]),
    getObservedRedisRequestsPerSecond: jest.fn(async () => 0),
    getRedisClient: () => ({
      scard: (key: string) => scard(key),
      dbSize: async () => 42,
      info: () => info(),
      hgetall: async (key: string) => hashes.get(key) || {},
    }),
  }
})
jest.mock("@/lib/system-logger", () => ({
  SystemLogger: { getLogs: (...args: unknown[]) => (getLogs as any)(...args), logError: jest.fn() },
}))
jest.mock("@/lib/dashboard-workflow", () => ({
  getDashboardWorkflowSnapshot: jest.fn(async () => ({
    globalStatus: "running",
    connectionMetrics: { engineCycles: {}, engineDurations: {}, progression: null },
  })),
}))
jest.mock("@/lib/live-position-read-model", () => ({
  getOpenLivePositionReadModels: (...args: unknown[]) => (getOpenLivePositionReadModels as any)(...args),
  getClosedLivePositionReadModels: (...args: unknown[]) => (getClosedLivePositionReadModels as any)(...args),
  LIVE_POSITION_OPEN_READ_LIMIT: 500,
  LIVE_POSITION_CLOSED_READ_LIMIT: 500,
}))

const { GET } = require("@/app/api/monitoring/comprehensive/route")

const entry = (id: string, status: "open" | "closed") => JSON.stringify({
  id, sym: "BTCUSDT", dir: "long", opened: 1, closed: status === "closed" ? 2 : 0, status, qty: 1, entry: 1,
  notional: 1, lev: 1, sl: 0, tp: 0, pnl: status === "closed" ? 1 : null, fees: 0, settled: status === "closed",
  pnlSource: "", reason: "", type: "", lane: "", variant: "", intent: "", slip: null, exit: 0, oid: "", coid: "", setKey: "",
})

describe("comprehensive monitoring stays bounded", () => {
  beforeAll(() => {
    hashes.set("results:ledger:v3:conn-a:entries", { a1: entry("a1", "open"), a2: entry("a2", "closed"), a3: entry("a3", "closed") })
    hashes.set("results:ledger:v3:conn-a:meta", { complete: "1", keys: "3" })
  })

  test("counts only processed connections, without loading position rows", async () => {
    const body = await (await GET()).json()

    expect(body.trading.pseudoPositions).toEqual({ total: 3, open: 3, pending: 0 })
    expect(body.trading.realPositions).toEqual({ total: 3, open: 1, closed: 2 })
    expect(body.trading).toMatchObject({ livePositions: 1, closedPositions: 2, health: "active" })
    // All stored connections are still listed.
    expect(body.connections.total).toBe(2)
    expect(scard).not.toHaveBeenCalledWith("pseudo_positions:conn-b")
    expect(getOpenLivePositionReadModels).not.toHaveBeenCalled()
    expect(getClosedLivePositionReadModels).not.toHaveBeenCalled()
  })

  test("repeated and concurrent polls share one build", async () => {
    const before = getLogs.mock.calls.length
    await GET()
    expect(getLogs.mock.calls.length).toBe(before)

    const realNow = Date.now()
    const clock = jest.spyOn(Date, "now").mockReturnValue(realNow + 60_000)
    try {
      await Promise.all([GET(), GET(), GET()])
    } finally {
      clock.mockRestore()
    }
    expect(getLogs.mock.calls.length).toBe(before + 1)
    expect(info).toHaveBeenCalledTimes(2)
  })
})
