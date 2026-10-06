/**
 * H2 / M16: the functional overview must use the basket the engine trades
 * (operator settings, force_symbols first) rather than a stale
 * `selected_symbols` on the raw connection hash, report the configured basket
 * separately from the symbols that already have stage rows, and define
 * `strategiesEvaluated` as the Real-stage figure like /stats does.
 */
const hashes = new Map<string, Record<string, string>>()
const basket = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT"]
const now = Date.now()

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/results/ledger", () => ({
  readResultLedger: jest.fn(async () => null),
  computeResultBook: jest.fn(),
}))
jest.mock("@/lib/redis-db", () => {
  const connection = {
    id: "conn-h2",
    name: "H2",
    exchange: "bingx",
    // Stale mirror on the raw connection hash.
    selected_symbols: JSON.stringify(["STALEUSDT", "OLDUSDT"]),
  }
  return {
    initRedis: jest.fn(async () => undefined),
    getAllConnections: jest.fn(async () => [connection]),
    getAssignedAndEnabledConnections: jest.fn(async () => [connection]),
    getSettings: jest.fn(async () => ({})),
    getRedisClient: () => ({
      hgetall: async (key: string) => hashes.get(key) || {},
      scard: async () => 0,
      exists: async () => 0,
      llen: async () => 0,
      dbSize: async () => 0,
    }),
  }
})

const { GET } = require("@/app/api/trade-engine/functional-overview/route")

function stageRows(rows: Record<string, { evaluated: number; created?: number }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [symbol, row] of Object.entries(rows)) {
    out[`s:${symbol}:evaluated`] = String(row.evaluated)
    out[`s:${symbol}:created`] = String(row.created ?? 1)
    out[`s:${symbol}:ts`] = String(now - 60_000)
  }
  return out
}

describe("functional overview symbol basket and evaluation count", () => {
  beforeEach(() => {
    hashes.clear()
    hashes.set("connection:conn-h2", { selected_symbols: JSON.stringify(["STALEUSDT", "OLDUSDT"]) })
    // Operator settings: the basket the engine actually trades.
    hashes.set("settings:connection_settings:conn-h2", { force_symbols: JSON.stringify(basket) })
    hashes.set("strategy_detail:conn-h2:base", stageRows({ BTCUSDT: { evaluated: 40 }, SOLUSDT: { evaluated: 30 }, ETHUSDT: { evaluated: 20 } }))
    hashes.set("strategy_detail:conn-h2:main", stageRows({ BTCUSDT: { evaluated: 12 }, SOLUSDT: { evaluated: 8 } }))
    hashes.set("strategy_detail:conn-h2:real", stageRows({
      BTCUSDT: { evaluated: 5 },
      SOLUSDT: { evaluated: 4 },
      ETHUSDT: { evaluated: 1 },
      // A removed symbol's row is not part of the basket.
      STALEUSDT: { evaluated: 900 },
    }))
    hashes.set("strategy_detail:conn-h2:live", stageRows({ BTCUSDT: { evaluated: 2 } }))
  })

  test("uses the operator basket and separates configured symbols from symbols with rows", async () => {
    const body = await (await GET()).json()

    expect(body.symbolsConfigured).toBe(5)
    expect(body.symbolsActive).toBe(5)
    expect(body.symbolsWithRows).toBe(3)
    // The stale symbol's row is filtered by the canonical basket.
    expect(body.counts.realStrategiesEvaluated).toBe(10)
  })

  test("strategiesEvaluated is the Real-stage figure; per-stage values are separate", async () => {
    const body = await (await GET()).json()

    expect(body.strategiesEvaluated).toBe(10)
    expect(body.strategiesEvaluatedByStage).toEqual({ base: 90, main: 20, real: 10, live: 2 })
  })

  test("the fallback resolver prefers force_symbols over a stale selected_symbols", () => {
    const { resolveOverviewActiveSymbols } = require("@/lib/functional-overview-stage-snapshot")
    expect([...resolveOverviewActiveSymbols({
      selected_symbols: JSON.stringify(["STALEUSDT"]),
      force_symbols: JSON.stringify(basket),
    })]).toEqual(basket)
  })
})
