/**
 * 70-symbol paper (simulated) order lifecycle under load, no network and no
 * credentials, on the real in-process Redis: 140 rows open, close for their
 * reason (TP, SL, max hold, manual) and are booked exactly once in the ledger,
 * the lifetime summary and the per-Set result rings; a replayed close changes
 * nothing. The 70-symbol exchange lane (entries, protection, venue close and
 * reconciliation) is in main-engine-live-dispatch.test.ts.
 */
const prices = new Map<string, number>()

const connections: Record<string, Record<string, any>> = {
  "paper-70": {
    id: "paper-70", name: "Paper 70", exchange: "bingx",
    is_live_trade: "0", live_trade_requested: "0", is_assigned: "1", is_enabled_dashboard: "1",
    is_preset_trade: "0", is_testnet: "0", position_mode: "hedge", margin_type: "cross",
  },
}

const inline = (() => {
  delete process.env.REDIS_URL
  delete process.env.KV_URL
  const actual = jest.requireActual("@/lib/redis-db")
  return { actual, client: new actual.InlineLocalRedis() }
})

let redisModule: { actual: any; client: any } | null = null
function redis() {
  redisModule ||= inline()
  return redisModule
}

jest.mock("@/lib/redis-db", () => {
  const { actual, client } = redis()
  return {
    ...actual,
    withSharedPersistenceLease: async (_scope: string, work: () => Promise<unknown>) => work(),
    initRedis: jest.fn(async () => undefined),
    getRedisBackend: jest.fn(() => "redis-network"),
    persistNow: jest.fn(async () => true),
    persistLivePositionCheckpoint: jest.fn(async () => true),
    getRedisClient: jest.fn(() => client),
    getConnection: jest.fn(async (id: string) => (connections[id] ? { ...connections[id] } : null)),
    getAppSettings: jest.fn(async () => ({ overallControlOrdersOnly: false })),
    setSettings: jest.fn(async () => undefined),
    getMarketData: jest.fn(async (symbol: string) => ({ latest: { close: prices.get(String(symbol).replace(/[-/]/g, "").toUpperCase()) ?? 100 } })),
  }
})

jest.mock("@/lib/engine-progression-logs", () => ({ logProgressionEvent: jest.fn(async () => undefined) }))
jest.mock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))
jest.mock("@/lib/system-logger", () => ({ SystemLogger: { logError: jest.fn(async () => undefined) } }))
jest.mock("@/lib/leverage-policy", () => ({ getMaxLeverageForExchange: jest.fn(() => 10) }))
jest.mock("@/lib/volume-calculator", () => ({
  VolumeCalculator: {
    calculateVolumeForConnection: jest.fn(async () => ({
      finalVolume: 0.01, volume: 0.01, leverage: 10, maxExecutionNotionalUsd: 50, volumeAdjusted: false,
    })),
    logVolumeCalculation: jest.fn(async () => undefined),
  },
}))
jest.mock("@/lib/trade-engine/progression-lock", () => ({ getCurrentEpoch: jest.fn(async () => "epoch-stress") }))
jest.mock("@/lib/live-order-logger", () => ({
  newLiveOrderTrace: jest.fn((input: any = {}) => ({
    traceId: `trace-${input?.symbol || "x"}`, exchangeTrackingId: `cts-${input?.symbol || "x"}`,
    connectionId: input?.connectionId, symbol: input?.symbol, direction: input?.direction, exchangeSide: input?.side,
  })),
  withLiveOrderLogging: jest.fn(async (_trace: any, _context: any, work: () => Promise<any>) => ({ raw: await work() })),
  logLiveOrderFinal: jest.fn(async () => undefined),
}))
jest.mock("@/lib/live-order-service", () => ({
  recordPerSymbolOrderCounter: jest.fn(async () => undefined),
  recordLiveOrderProgression: jest.fn(async () => true),
  readOrderSettlement: jest.fn(async () => null),
  setupLiveOrderMarginAndLeverage: jest.fn(async () => ({ marginType: "cross", marginConfigured: true, leverageConfigured: true })),
}))
jest.mock("@/lib/preset-store", () => ({
  applySelectedPresetToRealPosition: jest.fn(async (_id: string, position: any) => position),
}))

const SYMBOLS = [
  "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
  "DOTUSDT", "ATOMUSDT", "LTCUSDT", "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT", "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT",
  "FETUSDT", "ICPUSDT", "HBARUSDT", "XLMUSDT", "ALGOUSDT", "VETUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT", "GALAUSDT",
  "CRVUSDT", "LDOUSDT", "STXUSDT", "IMXUSDT", "ORDIUSDT", "WIFUSDT", "ENAUSDT", "TONUSDT", "KASUSDT", "HYPEUSDT",
  "PEPEUSDT", "SHIBUSDT", "BONKUSDT", "FLOKIUSDT", "ONDOUSDT", "RENDERUSDT", "TAOUSDT", "MKRUSDT", "COMPUSDT", "SNXUSDT",
  "DYDXUSDT", "GMXUSDT", "PENDLEUSDT", "JTOUSDT", "STRKUSDT", "ZROUSDT", "EIGENUSDT", "POLUSDT", "MNTUSDT", "EGLDUSDT",
]

jest.setTimeout(240_000)

async function stage() {
  return import("@/lib/trade-engine/stages/live-stage")
}

describe("70-symbol order lifecycle", () => {
  const originalEnv = { REDIS_URL: process.env.REDIS_URL, inline: process.env.ALLOW_INLINE_REDIS_LIVE_TRADING }

  beforeEach(async () => {
    const data = (globalThis as any).__redis_data
    if (data) for (const value of Object.values(data)) if (value instanceof Map) value.clear()
    prices.clear()
    for (const symbol of SYMBOLS) prices.set(symbol, 100)
    process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = "1"
    const { invalidateLiveStageSettingsCache, __liveStageTest } = await stage()
    invalidateLiveStageSettingsCache()
    __liveStageTest.clearLiveTickerCache()
    delete (globalThis as any).__simulatedPositionStages
    delete (globalThis as any).__simulatedPositionMarkPersistedAt
    const client = redis().client
    for (const id of Object.keys(connections)) await client.set(`engine_lock:${id}`, "stress:1")
  })

  afterAll(() => {
    if (originalEnv.REDIS_URL === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = originalEnv.REDIS_URL
    if (originalEnv.inline === undefined) delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    else process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = originalEnv.inline
  })

  const realPosition = (connectionId: string, symbol: string, direction: "long" | "short") => ({
    id: `${connectionId}-${symbol}-${direction}`,
    connectionId,
    symbol,
    direction,
    quantity: 0,
    entryPrice: 100,
    leverage: 2,
    stopLoss: 1,
    takeProfit: 2,
    indicationType: "direction",
    setKey: `${symbol}:direction:${direction}#default`,
    parentSetKey: `${symbol}:direction:${direction}`,
    setVariant: "default",
    status: "pending" as const,
    timestamp: Date.now(),
  })

  test("paper: 140 rows open, close by TP / SL / max hold / manual, and are booked exactly once", async () => {
    const { executeLivePosition, processSimulatedPositions, closeLivePosition, getLivePositions, getClosedLivePositions } = await stage()
    const id = "paper-70"
    const opened = await Promise.all(SYMBOLS.flatMap((symbol) => (["long", "short"] as const).map((direction) =>
      executeLivePosition(id, realPosition(id, symbol, direction) as any, null as any))))
    expect(opened.every((row: any) => row && row.status === "simulated")).toBe(true)
    // the same Set again: no second row
    const again = await executeLivePosition(id, realPosition(id, SYMBOLS[0], "long") as any, null as any)
    expect(again?.id).toBe(opened[0]?.id)
    expect(await getLivePositions(id)).toHaveLength(140)

    // group 0: +2.5 % (long TP, short SL); group 1: -1.5 % (long SL, short manual)
    SYMBOLS.forEach((symbol, index) => {
      if (index % 4 === 0) prices.set(symbol, 102.5)
      if (index % 4 === 1) prices.set(symbol, 98.5)
    })
    const sweep = async () => {
      for (let pass = 0; pass < Math.ceil(140 / 96) + 2; pass++) await processSimulatedPositions(id)
    }
    await sweep()

    const byId = new Map(opened.map((row: any) => [row.id, row]))
    const manual: string[] = []
    SYMBOLS.forEach((symbol, index) => {
      if (index % 4 === 1) manual.push(`${symbol}|short`)
      if (index % 4 === 2) manual.push(`${symbol}|long`, `${symbol}|short`)
    })
    for (const key of manual) {
      const [symbol, direction] = key.split("|")
      const row = opened.find((position: any) => position.symbol === symbol && position.direction === direction)!
      const closed = await closeLivePosition(id, row.id, prices.get(symbol)!, undefined, "manual_dashboard_close")
      expect(closed?.status).toBe("closed")
      await expect(closeLivePosition(id, row.id, prices.get(symbol)!, undefined, "manual_replay")).resolves.toBeNull()
    }
    // group 3: max hold
    const realNow = Date.now
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 3_600_000)
    try {
      await sweep()
    } finally {
      jest.restoreAllMocks()
    }

    const before = JSON.stringify(await getClosedLivePositions(id))
    await sweep()
    const closedRows = await getClosedLivePositions(id)
    expect(JSON.stringify(closedRows)).toBe(before)
    expect(await getLivePositions(id)).toHaveLength(0)
    expect(closedRows).toHaveLength(140)
    expect(new Set(closedRows.map((row: any) => row.id)).size).toBe(140)
    expect(byId.size).toBe(140)

    const reasonOf = (symbol: string, direction: string) =>
      String(closedRows.find((row: any) => row.symbol === symbol && row.direction === direction)?.closeReason || "")
    SYMBOLS.forEach((symbol, index) => {
      if (index % 4 === 0) {
        expect(reasonOf(symbol, "long")).toMatch(/take_profit|tp/i)
        expect(reasonOf(symbol, "short")).toMatch(/stop_loss|sl/i)
      }
      if (index % 4 === 1) expect(reasonOf(symbol, "long")).toMatch(/stop_loss|sl/i)
      if (index % 4 === 3) expect(reasonOf(symbol, "long")).toMatch(/hold/i)
    })

    // exactly once: one result per closed row in each Set ring, ledger = lifetime summary
    const client = redis().client
    for (const row of closedRows as any[]) {
      expect(await client.llen(`strategy_set_result_ring:${id}:${row.setKey}`)).toBe(1)
    }
    const lifetime = await client.hgetall(`live:positions:${id}:lifetime:summary`)
    const realized = closedRows.reduce((sum: number, row: any) => sum + Number(row.realizedPnL || 0), 0)
    expect(Number(lifetime["simulated.closedTrades"] ?? lifetime["all.closedTrades"])).toBe(140)
    expect(Number(lifetime["simulated.realizedPnl"] ?? lifetime["all.realizedPnl"])).toBeCloseTo(realized, 6)
    expect(closedRows.every((row: any) => row.dataSource === "simulated" || row.executionMode === "simulation" || row.status === "closed")).toBe(true)

    // the read API agrees with the ledger
    const { GET } = await import("@/app/api/trading/live-positions/route")
    const response = await GET(new Request(`http://localhost/api/trading/live-positions?connection_id=${id}&includeSimulated=1&closedLimit=1000`))
    const body = await response.json()
    expect(body.counts?.open ?? 0).toBe(0)
    expect(body.counts?.closed).toBe(140)
    expect(body.realPositions).toHaveLength(0)
  })
})
