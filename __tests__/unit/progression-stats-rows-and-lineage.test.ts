/**
 * H3 / L9: GET /stats must never delete stage rows of the active basket (the
 * overview shows them for 24 h) and must prune every field of a symbol that
 * left the basket, not a fixed subset.
 * A6: a live row is attributed to the Sets in its own lineage; the
 * symbol/direction match against pseudo rows is only for legacy rows.
 */
import {
  OVERVIEW_STAGE_ROW_MAX_RETAIN_MS,
  collectPrunableStageRowFields,
} from "@/lib/functional-overview-stage-snapshot"

const hashes = new Map<string, Record<string, string>>()
const strings = new Map<string, string>()
const lists = new Map<string, string[]>()
const sets = new Map<string, string[]>()
const hdel = jest.fn(async () => 1)

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => ({
    hgetall: async (key: string) => hashes.get(key) || {},
    get: async (key: string) => strings.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null),
    lrange: async (key: string) => lists.get(key) || [],
    llen: async (key: string) => (lists.get(key) || []).length,
    smembers: async (key: string) => sets.get(key) || [],
    scard: async (key: string) => (sets.get(key) || []).length,
    exists: async () => 0,
    dbSize: async () => 0,
    hdel: (...args: unknown[]) => (hdel as any)(...args),
  }),
  getConnection: async () => ({ id: "conn", exchange: "bingx" }),
  getSettings: async () => ({}),
  getAppSettings: async () => ({}),
}))
jest.mock("@/lib/trade-engine", () => ({ getGlobalCoordinator: () => null }))

const { GET } = require("@/app/api/connections/progression/[id]/stats/route")

const now = Date.now()
const HOUR = 60 * 60_000

function row(symbol: string, ageMs: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`s:${symbol}:created`]: "4",
    [`s:${symbol}:evaluated`]: "6",
    [`s:${symbol}:passed`]: "2",
    [`s:${symbol}:logical_passed_sets`]: "2",
    [`s:${symbol}:trailing`]: "1",
    [`s:${symbol}:axis_sets_after_hedge`]: "3",
    [`s:${symbol}:ts`]: String(now - ageMs),
    ...extra,
  }
}

async function stats(id: string) {
  const response = await GET(
    { url: `http://localhost/api/connections/progression/${id}/stats?view=full` },
    { params: Promise.resolve({ id }) },
  )
  const body = await response.json()
  expect(body.error).toBeUndefined()
  return body
}

describe("stage-row pruning", () => {
  test("active-basket rows are never pruned; other symbols only after 24 h, with every field", () => {
    const raw = {
      ...row("BTCUSDT", 30 * HOUR),
      ...row("OLDUSDT", 2 * HOUR),
      ...row("GONEUSDT", OVERVIEW_STAGE_ROW_MAX_RETAIN_MS + HOUR),
      "s:NOTSUSDT:created": "1",
      created_sets: "12",
    }
    const pruned = collectPrunableStageRowFields(raw, { activeSymbols: new Set(["BTCUSDT"]), now })
    expect(pruned.sort()).toEqual(Object.keys(row("GONEUSDT", 0)).sort())
  })

  test("GET /stats keeps an active symbol's 2 h old row and prunes only the departed symbol", async () => {
    const id = "conn-h3"
    hashes.clear(); strings.clear(); lists.clear(); sets.clear(); hdel.mockClear()
    hashes.set(`settings:connection_settings:${id}`, { force_symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]) })
    hashes.set(`strategy_detail:${id}:real`, {
      // Older than the previous 30 min prune budget while the engine paused.
      ...row("BTCUSDT", 2 * HOUR),
      // Left the basket recently: still inside the overview's retention.
      ...row("OLDUSDT", 2 * HOUR),
      // Left the basket more than 24 h ago.
      ...row("GONEUSDT", OVERVIEW_STAGE_ROW_MAX_RETAIN_MS + HOUR),
    })

    await stats(id)

    const realCalls = hdel.mock.calls.filter((call: any[]) => call[0] === `strategy_detail:${id}:real`)
    expect(realCalls).toHaveLength(1)
    const fields = (realCalls[0] as any[]).slice(1) as string[]
    expect(fields.sort()).toEqual(Object.keys(row("GONEUSDT", 0)).sort())
    expect(fields.some((field) => field.startsWith("s:BTCUSDT:") || field.startsWith("s:OLDUSDT:"))).toBe(false)
  })
})

describe("live position Set lineage", () => {
  test("a live row is attributed to its own setKey lineage, not to pseudo rows on the same pair", async () => {
    const id = "conn-a6"
    hashes.clear(); strings.clear(); lists.clear(); sets.clear(); hdel.mockClear()
    const ownSet = "BTCUSDT:direction:own"
    const memberSet = "BTCUSDT:direction:member"
    // An unrelated Set holds open pseudo rows on the same symbol/direction.
    sets.set(`pseudo_positions:${id}`, ["p1", "p2", "p3"])
    hashes.set(`pseudo_position:${id}:p1`, {
      status: "open", symbol: "BTCUSDT", direction: "long",
      config_set_key: "direction:long:other", strategy_set_key: "BTCUSDT:direction:other",
    })
    hashes.set(`pseudo_position:${id}:p2`, {
      status: "open", symbol: "BTCUSDT", direction: "long",
      config_set_key: "direction:long:other", strategy_set_key: "BTCUSDT:direction:other",
    })
    hashes.set(`pseudo_position:${id}:p3`, {
      status: "open", symbol: "BTCUSDT", direction: "long",
      config_set_key: "direction:long:own", strategy_set_key: ownSet,
    })
    lists.set(`live:positions:${id}`, ["live-1", "live-legacy"])
    strings.set("live:position:live-1", JSON.stringify({
      id: "live-1", connectionId: id, symbol: "BTCUSDT", direction: "long", status: "open",
      orderId: "ord-1", executedQuantity: 1, entryPrice: 100,
      setKey: ownSet, accumulatedSetKeys: [ownSet, memberSet],
    }))
    // Legacy row without lineage: falls back to the symbol/direction match.
    strings.set("live:position:live-legacy", JSON.stringify({
      id: "live-legacy", connectionId: id, symbol: "BTCUSDT", direction: "long", status: "open",
      orderId: "ord-2", executedQuantity: 1, entryPrice: 100,
    }))

    const body = await stats(id)
    const positions = body.openPositions.live.positions as Array<Record<string, any>>
    const own = positions.find((position) => position.id === "live-1")!
    const legacy = positions.find((position) => position.id === "live-legacy")!

    expect(own.resolution).toBe("lineage")
    expect(own.mirroredSets).toEqual([
      { setKey: ownSet, count: 1 },
      { setKey: memberSet, count: 0 },
    ])
    expect(legacy.resolution).toBe("pseudo")
    expect(legacy.mirroredSets[0]).toEqual({ setKey: "direction:long:other", count: 2 })
    expect(body.openPositions.live.resolution).toMatchObject({ lineage: 1, pseudo: 1, realFallback: 0, unresolved: 0 })
  })
})

describe("exchange-judged Sets per stage", () => {
  test("each performance tier says how many Sets were judged on settled exchange results", async () => {
    const id = "conn-a3"
    hashes.clear(); strings.clear(); lists.clear(); sets.clear(); hdel.mockClear()
    const published = String(Date.now() - 20_000)
    hashes.set(`strategy_detail:${id}:real`, {
      ...row("BTCUSDT", 60_000),
      exchange_judged_sets: "4", exchange_pending_sets: "7", exchange_min_closes: "3", outcome_source_ts: published,
    })
    hashes.set(`strategy_detail:${id}:live`, {
      exchange_judged_sets: "2", exchange_pending_sets: "1", exchange_min_closes: "3",
      // Ten minutes old: the engine stopped judging live results.
      outcome_source_ts: String(Date.now() - 10 * 60_000),
      loss_gate_deactivated: "5",
    })

    const body = await stats(id)

    expect(body.performanceTiers.real.outcomeSource).toMatchObject({ exchangeJudged: 4, exchangePending: 7, minCloses: 3, fresh: true })
    expect(body.performanceTiers.live.outcomeSource).toMatchObject({ exchangeJudged: 2, fresh: false })
    expect(body.performanceTiers.base.outcomeSource).toBeNull()
    expect(body.performanceTiers.live.lossGateDeactivated).toBe(5)
  })
})
