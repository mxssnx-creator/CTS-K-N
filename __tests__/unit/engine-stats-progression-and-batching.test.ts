/**
 * M8: /api/trading/engine-stats read only the legacy progression hash (the
 * long-lived engine increments the engine-scoped one) and issued one awaited
 * HGETALL per pseudo position.
 */
const hashes = new Map<string, Record<string, string>>()
const members = new Map<string, string[]>()
let inFlight = 0
let peakInFlight = 0

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => ({ id: "conn-m8", force_symbols: JSON.stringify(["BTCUSDT"]) })),
  getRedisClient: () => ({
    hgetall: async (key: string) => {
      if (!key.startsWith("pseudo_position:")) return hashes.get(key) || {}
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      inFlight--
      return hashes.get(key) || {}
    },
    hset: jest.fn(async () => 1),
    smembers: async (key: string) => members.get(key) || [],
  }),
}))

const { GET } = require("@/app/api/trading/engine-stats/route")

describe("engine-stats progression counters and pseudo-position reads", () => {
  test("counters come from the merged scoped/legacy progression and pseudo rows are read in batches", async () => {
    hashes.set("progression:conn-m8:main", {
      connection_id: "conn-m8",
      session_number: "2",
      indication_cycle_count: "25",
      strategy_cycle_count: "24",
      strategies_real_total: "30",
    })
    hashes.set("progression:conn-m8", { strategies_real_total: "30", cycles_completed: "9" })
    const ids = Array.from({ length: 600 }, (_, index) => `p${index}`)
    members.set("pseudo_positions:conn-m8", ids)
    ids.forEach((id, index) => {
      hashes.set(`pseudo_position:conn-m8:${id}`, { status: index % 3 === 0 ? "closed" : "open" })
    })

    const response = await GET({ url: "http://localhost/api/trading/engine-stats?connection_id=conn-m8" })
    const body = await response.json()

    expect(body.indicationCycleCount).toBe(25)
    expect(body.strategyCycleCount).toBe(24)
    // Mirrored into both hashes: counted once.
    expect(body.realStrategyCount).toBe(30)
    expect(body.cyclesCompleted).toBe(9)
    expect(body.positionsCount).toBe(400)
    // Parallel but bounded reads instead of 600 sequential round trips.
    expect(peakInFlight).toBeGreaterThan(1)
    expect(peakInFlight).toBeLessThanOrEqual(250)
  })
})
