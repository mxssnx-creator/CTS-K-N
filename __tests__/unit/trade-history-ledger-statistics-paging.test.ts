/**
 * H7: `view=statistics` is built from the complete results ledger instead of
 * the capped closed-position index.
 * M17: without a complete ledger, page zero merges the venue overlay into the
 * local page; every local row must still appear exactly once across pages.
 */
const hashes = new Map<string, Record<string, string>>()
const strings = new Map<string, string>()
const lists = new Map<string, string[]>()

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async (id: string) => ({ id, exchange: "bingx" })),
  getRedisClient: () => ({
    hgetall: async (key: string) => hashes.get(key) || {},
    get: async (key: string) => strings.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null),
    lrange: async (key: string, start: number, stop: number) =>
      (lists.get(key) || []).slice(start, stop < 0 ? undefined : stop + 1),
    llen: async (key: string) => (lists.get(key) || []).length,
    smembers: async () => [],
    set: async () => "OK",
  }),
}))
jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: { getOrCreateConnector: jest.fn(async () => null) },
}))
jest.mock("@/lib/live-position-read-model", () => ({
  getClosedLivePositionReadModels: jest.fn(async () => []),
}))

const { GET } = require("@/app/api/trading/trade-history/route")

const T = 1_790_000_000_000
const MINUTE = 60_000

function venueRow(id: string, symbol: string, closedAt: number, closeOrderId?: string) {
  return {
    id: `exchange:${id}`, symbol, direction: "long", entryPrice: 10, exitPrice: 11, quantity: 1,
    volumeUsd: 10, grossPnl: 1, fees: 0, realizedPnl: 1, pnlPct: 10, openedAt: closedAt - MINUTE,
    closedAt, holdMinutes: 1, source: "exchange", environment: "exchange",
    closeOrderId: closeOrderId || id,
  }
}

async function history(query: string) {
  const response = await GET(new Request(`http://localhost/api/trading/trade-history?${query}`))
  const body = await response.json()
  expect(body.success).toBe(true)
  return body
}

describe("statistics view from the results ledger", () => {
  test("uses every closed ledger trade although the closed index holds only one", async () => {
    const id = "conn-h7"
    hashes.clear(); strings.clear(); lists.clear()
    const entry = (n: number, pnl: number | null, coid: string) => JSON.stringify({
      id: `pos-${n}`, sym: "BTCUSDT", dir: "long", opened: T - n * 10 * MINUTE, closed: T - n * 10 * MINUTE + MINUTE,
      status: "closed", qty: 1, entry: 100, notional: 100, lev: 5, sl: 0, tp: 0, pnl,
      fees: 0.1, settled: pnl !== null, pnlSource: "", reason: "", type: "direction", lane: "", variant: "",
      intent: "main", slip: null, exit: 101, oid: `o-${n}`, coid, setKey: "",
    })
    hashes.set(`results:ledger:v3:${id}:entries`, {
      "pos-1": entry(1, 2.5, "c-1"),
      "pos-2": entry(2, -1, "c-2"),
      "pos-3": entry(3, null, "c-3"),
    })
    hashes.set(`results:ledger:v3:${id}:meta`, { complete: "1", keys: "7", remaining: "0" })
    hashes.set(`results:ledger:v3:${id}:funnel`, { simulated: "4" })
    // The capped closed index only still holds the newest trade.
    lists.set(`live:positions:${id}:closed`, ["pos-1"])
    strings.set("live:position:pos-1", JSON.stringify({
      id: "pos-1", symbol: "BTCUSDT", direction: "long", status: "closed", executedQuantity: 1,
      entryPrice: 100, closePrice: 101, realizedPnl: 2.5, createdAt: T - 10 * MINUTE, closedAt: T - 9 * MINUTE,
    }))
    // Venue overlay: our own close c-1 plus one foreign trade.
    strings.set(`trade_history:exchange:${id}`, JSON.stringify({
      fetchedAt: Date.now(),
      rows: [venueRow("c-1", "BTCUSDT", T - 9 * MINUTE, "c-1"), venueRow("f-1", "DOGEUSDT", T)],
    }))

    const body = await history(`connection_id=${id}&view=statistics`)

    expect(body.historySource).toBe("results-ledger")
    expect(body.tupleVersion).toBe(1)
    // Two settled own trades are counted; the pending one is not.
    expect(body.attributedRows).toBe(2)
    expect(body.unattributedExchange.rows).toBe(1)
    expect(body.rows).toHaveLength(3)
    expect(body.rows.map((tuple: unknown[]) => tuple[0]).sort()).toEqual(["exchange:f-1", "pos-1", "pos-2"])
    expect(body.archive).toMatchObject({
      indexed: 3,
      normalizedSnapshots: 2,
      unresolvedTradeSnapshots: 1,
      excludedNonTradeSnapshots: 4,
      complete: false,
    })
    expect(body.analytics).toBeTruthy()
  })
})

describe("trade history paging without a complete ledger", () => {
  test("every local row appears exactly once across pages despite newer venue rows", async () => {
    const id = "conn-m17"
    hashes.clear(); strings.clear(); lists.clear()
    const local = ["l1", "l2", "l3", "l4"]
    lists.set(`live:positions:${id}:closed`, local)
    local.forEach((positionId, index) => {
      const closedAt = T - (index + 1) * 10 * MINUTE
      strings.set(`live:position:${positionId}`, JSON.stringify({
        id: positionId, symbol: `L${index}USDT`, direction: "long", status: "closed", executedQuantity: 1,
        entryPrice: 100, closePrice: 101, realizedPnl: 1, createdAt: closedAt - MINUTE, closedAt,
      }))
    })
    // Foreign venue trades, all newer than every local row.
    strings.set(`trade_history:exchange:${id}`, JSON.stringify({
      fetchedAt: Date.now(),
      rows: [venueRow("f-1", "XAUSDT", T + MINUTE), venueRow("f-2", "XBUSDT", T + 2 * MINUTE), venueRow("f-3", "XCUSDT", T + 3 * MINUTE)],
    }))

    const seen: string[] = []
    let offset: number | null = 0
    let pages = 0
    while (offset !== null && pages < 5) {
      const body = await history(`connection_id=${id}&scope=all&limit=2&offset=${offset}`)
      expect(body.rows.length).toBeLessThanOrEqual(2)
      seen.push(...body.rows.filter((row: any) => row.attribution === "cts").map((row: any) => row.id))
      offset = body.paging.hasMore ? body.paging.nextOffset : null
      pages++
    }

    expect(seen.sort()).toEqual(local)
  })
})
