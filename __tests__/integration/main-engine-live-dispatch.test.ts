const strings = new Map<string, string>()
const hashes = new Map<string, Record<string, any>>()
const lists = new Map<string, string[]>()
const sets = new Map<string, Set<string>>()
const sortedSets = new Map<string, Map<string, number>>()
const cancelledVenueOrderIds = new Set<string>()
const venueQuantityOverrides = new Map<string, number>()
const mockRecordLiveOrderProgression = jest.fn(async () => true)
const mockReadOrderSettlement = jest.fn(async () => null as any)
const mockCalculateVolumeForConnection = jest.fn(async () => ({
  finalVolume: 0.01,
  volume: 0.01,
  leverage: 10,
  maxExecutionNotionalUsd: 50,
  volumeAdjusted: false,
}))

const connection: Record<string, any> = {
  id: "bingx-main-recording",
  name: "BingX Main Recording",
  exchange: "bingx",
  api_key: "1234567890",
  api_secret: "abcdefghijklmnopqrstuvwxyz",
  is_live_trade: "1",
  live_trade_requested: "1",
  is_assigned: "1",
  is_enabled_dashboard: "1",
  is_preset_trade: "0",
  is_testnet: "0",
  position_mode: "hedge",
  margin_type: "cross",
}

const fakeRedis = {
  async set(key: string, value: any, options?: any) {
    if ((options?.NX || options?.nx) && strings.has(key)) return null
    strings.set(key, String(value))
    return "OK"
  },
  async get(key: string) { return strings.get(key) ?? null },
  async setex(key: string, _seconds: number, value: any) {
    strings.set(key, String(value))
    return "OK"
  },
  async del(...keys: string[]) {
    let deleted = 0
    for (const key of keys) {
      deleted += strings.delete(key) ? 1 : 0
      deleted += hashes.delete(key) ? 1 : 0
      deleted += lists.delete(key) ? 1 : 0
      deleted += sets.delete(key) ? 1 : 0
    }
    return deleted
  },
  async expire() { return 1 },
  async pexpire() { return 1 },
  async pExpire(key: string, seconds: number) { return fakeRedis.pexpire(key, seconds) },
  async persist() { return 1 },
  async hset(key: string, fieldOrObject: any, value?: any) {
    const hash = hashes.get(key) || {}
    if (typeof fieldOrObject === "string") hash[fieldOrObject] = value
    else Object.assign(hash, fieldOrObject || {})
    hashes.set(key, hash)
    return 1
  },
  async hgetall(key: string) {
    const stored = hashes.get(key) || {}
    if (key.startsWith("settings:trading_pair:")) {
      return {
        quantityStep: "0.000001",
        quantityPrecision: "6",
        minQuantity: "0.000001",
        pricePrecision: "2",
        priceTick: "0.01",
        ...stored,
      }
    }
    return { ...stored }
  },
  async hget(key: string, field: string) { return hashes.get(key)?.[field] ?? null },
  async hdel(key: string, ...fields: string[]) {
    const hash = hashes.get(key)
    if (!hash) return 0
    let deleted = 0
    for (const field of fields) {
      if (!(field in hash)) continue
      delete hash[field]
      deleted++
    }
    return deleted
  },
  async hincrby(key: string, field: string, delta: number) {
    const hash = hashes.get(key) || {}
    hash[field] = String((Number(hash[field]) || 0) + Number(delta || 0))
    hashes.set(key, hash)
    return Number(hash[field])
  },
  async hincrbyfloat(key: string, field: string, delta: number) {
    const hash = hashes.get(key) || {}
    hash[field] = String((Number(hash[field]) || 0) + Number(delta || 0))
    hashes.set(key, hash)
    return Number(hash[field])
  },
  async lrem(key: string, _count: number, value: string) {
    const before = lists.get(key) || []
    const after = before.filter((item) => item !== value)
    lists.set(key, after)
    return before.length - after.length
  },
  async lpos(key: string, value: string) {
    const index = (lists.get(key) || []).indexOf(value)
    return index >= 0 ? index : null
  },
  async lpush(key: string, value: string) {
    const list = lists.get(key) || []
    list.unshift(value)
    lists.set(key, list)
    return list.length
  },
  async ltrim(key: string, start: number, end: number) {
    lists.set(key, (lists.get(key) || []).slice(start, end + 1))
    return "OK"
  },
  async lrange(key: string, start: number, end: number) {
    const list = lists.get(key) || []
    return list.slice(start, end < 0 ? undefined : end + 1)
  },
  async sadd(key: string, value: string) {
    const set = sets.get(key) || new Set<string>()
    const before = set.size
    set.add(value)
    sets.set(key, set)
    return set.size === before ? 0 : 1
  },
  async srem(key: string, value: string) {
    return sets.get(key)?.delete(value) ? 1 : 0
  },
  async smembers(key: string) {
    return Array.from(sets.get(key) || [])
  },
  async scard(key: string) {
    return sets.get(key)?.size || 0
  },
  async zadd(key: string, score: number, member: string) {
    const sorted = sortedSets.get(key) || new Map<string, number>()
    const existed = sorted.has(String(member))
    sorted.set(String(member), Number(score))
    sortedSets.set(key, sorted)
    return existed ? 0 : 1
  },
  async zrangebyscore(key: string, min: number | string, max: number | string) {
    const lower = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const upper = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    return [...(sortedSets.get(key) || new Map<string, number>()).entries()]
      .filter(([, score]) => score >= lower && score <= upper)
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .map(([member]) => member)
  },
  async zremrangebyscore(key: string, min: number | string, max: number | string) {
    const lower = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const upper = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    const sorted = sortedSets.get(key) || new Map<string, number>()
    let removed = 0
    for (const [member, score] of sorted.entries()) {
      if (score >= lower && score <= upper) {
        sorted.delete(member)
        removed++
      }
    }
    sortedSets.set(key, sorted)
    return removed
  },
  multi() {
    const operations: Array<() => Promise<any>> = []
    const pipeline: any = {}
    for (const method of [
      "get",
      "sadd",
      "srem",
      "expire",
      "persist",
      "hget",
      "hgetall",
      "hincrby",
      "hincrbyfloat",
      "hset",
      "hdel",
      "lrange",
      "lpush",
      "ltrim",
      "del",
      "zadd",
      "zremrangebyscore",
    ] as const) {
      pipeline[method] = (...args: any[]) => {
        operations.push(() => (fakeRedis as any)[method](...args))
        return pipeline
      }
    }
    pipeline.exec = async () => Promise.all(operations.map((operation) => operation()))
    return pipeline
  },
}

function persistedActiveRows(): Array<Record<string, any>> {
  const ids = lists.get(`live:positions:${connection.id}`) || []
  return ids.flatMap((id) => {
    const raw = strings.get(`live:position:${id}`)
    const hash = hashes.get(`live_positions:${connection.id}:${id}`)
    if (!raw && !hash) return []
    try {
      const decode = (value: any): any => {
        if (typeof value !== "string") return value
        try { return JSON.parse(value) } catch { return value }
      }
      const row = raw
        ? JSON.parse(raw) as Record<string, any>
        : Object.fromEntries(Object.entries(hash || {}).map(([key, value]) => [key, decode(value)]))
      return ["open", "filled", "partially_filled", "closing", "closing_partial"].includes(String(row.status || "").toLowerCase()) &&
        Number(row.executedQuantity || 0) > 0
        ? [row]
        : []
    } catch {
      return []
    }
  })
}

function venuePositionSnapshot(): Array<Record<string, any>> {
  const slots = new Map<string, Record<string, any>>()
  for (const row of persistedActiveRows()) {
    const direction = String(row.direction || row.side || "").toLowerCase() === "short" ? "short" : "long"
    const symbol = String(row.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
    const key = `${symbol}:${direction}`
    const existing = slots.get(key)
    const quantity = Number(row.executedQuantity || 0)
    if (!existing) {
      slots.set(key, {
        symbol: row.symbol,
        positionSide: direction === "long" ? "LONG" : "SHORT",
        positionAmt: quantity,
        entryPrice: Number(row.averageExecutionPrice || row.entryPrice || 100),
        markPrice: 100,
        liquidationPrice: direction === "short" ? 150 : 50,
      })
      continue
    }
    const before = Number(existing.positionAmt || 0)
    existing.positionAmt = before + quantity
    existing.entryPrice = before > 0
      ? ((Number(existing.entryPrice || 100) * before) + (Number(row.averageExecutionPrice || row.entryPrice || 100) * quantity)) / (before + quantity)
      : Number(row.averageExecutionPrice || row.entryPrice || 100)
  }
  for (const [key, quantity] of venueQuantityOverrides.entries()) {
    const existing = slots.get(key)
    if (!(quantity > 0)) {
      slots.delete(key)
      continue
    }
    if (existing) existing.positionAmt = quantity
  }
  return [...slots.values()]
}

function venueOpenOrderSnapshot(): Array<Record<string, any>> {
  const orders: Array<Record<string, any>> = []
  for (const row of persistedActiveRows()) {
    const direction = String(row.direction || row.side || "").toLowerCase() === "short" ? "short" : "long"
    const side = direction === "long" ? "sell" : "buy"
    const positionSide = direction === "long" ? "LONG" : "SHORT"
    const tracked = (kind: string) => {
      const entries = Array.isArray(row.exchangeData?.clientOrderIds) ? row.exchangeData.clientOrderIds : []
      const entry = [...entries].reverse().find((item: any) => item?.kind === kind)
      return entry?.clientOrderId || undefined
    }
    const add = (id: unknown, clientOrderId: unknown, type: string, quantity: unknown, trigger: unknown) => {
      if (!id) return
      if (cancelledVenueOrderIds.has(String(id)) || (clientOrderId && cancelledVenueOrderIds.has(String(clientOrderId)))) return
      orders.push({
        id: String(id),
        clientOrderId: clientOrderId ? String(clientOrderId) : undefined,
        symbol: row.symbol,
        side,
        positionSide,
        type,
        origQty: Number(quantity || 0),
        stopPrice: Number(trigger || 0),
        reduceOnly: true,
      })
    }
    add(row.stopLossOrderId, tracked("stop_loss"), "STOP_MARKET", row.stopLossArmedQuantity || row.executedQuantity, row.stopLossPrice)
    add(row.takeProfitOrderId, tracked("take_profit"), "TAKE_PROFIT_MARKET", row.takeProfitArmedQuantity || row.executedQuantity, row.takeProfitPrice)
    add(row.securityStopOrderId, tracked("security_stop"), "STOP_MARKET", row.securityStopArmedQuantity || row.executedQuantity, row.securityStopPrice)
  }
  return orders
}

let firstEntryRequestAt = 0
let protectionRequestTimes: number[] = []
const placeOrder = jest.fn(async (
  symbol: string,
  side?: string,
  quantity?: number,
  _price?: number,
  _type?: string,
  options: Record<string, any> = {},
) => {
  if (firstEntryRequestAt === 0) firstEntryRequestAt = performance.now()
  const explicitPositionSide = String(options.positionSide || "").toLowerCase()
  const normalizedSide = String(side || "").toLowerCase()
  const direction = explicitPositionSide === "short" || explicitPositionSide === "sell"
    ? "short"
    : explicitPositionSide === "long" || explicitPositionSide === "buy"
      ? "long"
      : normalizedSide === "sell" ? "short" : "long"
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const venueKey = `${normalizedSymbol}:${direction}`
  if (options.reduceOnly === true) {
    const current = venuePositionSnapshot().find((row) =>
      String(row.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedSymbol &&
      String(row.positionSide || "").toLowerCase() === direction,
    )
    venueQuantityOverrides.set(venueKey, Math.max(0, Number(current?.positionAmt || 0) - Math.abs(Number(quantity || 0))))
  } else {
    venueQuantityOverrides.delete(venueKey)
  }
  return {
    success: true,
    orderId: `bingx-entry-${symbol}`,
    status: "filled",
    filledQty: 0.01,
    filledPrice: 100,
  }
})
const placeStopOrder = jest.fn(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string, options: any = {}) => {
  protectionRequestTimes.push(performance.now())
  const clientOrderId = options?.clientOrderId
  return {
    success: true,
    orderId: `bingx-${kind}-${symbol}-${clientOrderId || placeStopOrder.mock.calls.length}`,
    ...(clientOrderId ? { clientOrderId } : {}),
  }
})
const applySelectedPresetToRealPosition = jest.fn(async (_connectionId: string, position: Record<string, any>) => ({
  ...position,
  stopLoss: 2,
  takeProfit: 4,
  presetId: "preset-recording-1",
  presetIndicatorType: "rsi",
  presetRank: 1,
  presetPositionCostPct: 0.02,
  presetProfitFactor: 1.4,
}))

const recordingConnector = {
  getBalance: jest.fn(async () => ({ success: true, balance: 10_000, equity: 10_000 })),
  getTicker: jest.fn(async () => ({ bid: 99.9, ask: 100, last: 100 })),
  placeOrder,
  placeStopOrder,
  cancelOrder: jest.fn(async (_symbol: string, orderId: string) => {
    cancelledVenueOrderIds.add(String(orderId))
    return { success: true }
  }),
  setLeverage: jest.fn(async () => ({ success: true })),
  setMarginType: jest.fn(async () => ({ success: true })),
  getPosition: jest.fn(async () => ({
    positionAmt: 0.01,
    entryPrice: 100,
    markPrice: 100,
    liquidationPrice: 50,
    unrealizedPnl: 0,
    marginType: "cross",
  })),
  getPositions: jest.fn(async () => venuePositionSnapshot()),
  getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: true })),
  getOpenOrders: jest.fn(async () => venueOpenOrderSnapshot()),
  getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: true })),
  getCapabilities: jest.fn(() => ["position_close_all_stop"]),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisBackend: jest.fn(() => "redis-network"),
  persistNow: jest.fn(async () => true),
  persistLivePositionCheckpoint: jest.fn(async () => true),
  getRedisClient: jest.fn(() => fakeRedis),
  upsertRedisListHead: jest.fn(async (_client: unknown, key: string, value: string) => {
    const current = (lists.get(key) || []).filter((item) => item !== value)
    lists.set(key, [value, ...current])
  }),
  moveRedisListMembershipToHead: jest.fn(async (
    _client: unknown,
    sourceKey: string,
    targetKey: string,
    value: string,
  ) => {
    lists.set(sourceKey, (lists.get(sourceKey) || []).filter((item) => item !== value))
    lists.set(targetKey, [
      value,
      ...(lists.get(targetKey) || []).filter((item) => item !== value),
    ])
  }),
  getConnection: jest.fn(async () => ({ ...connection })),
  getAppSettings: jest.fn(async () => ({})),
  setSettings: jest.fn(async () => undefined),
  getMarketData: jest.fn(async () => ({ latest: { close: 100 } })),
}))

jest.mock("@/lib/trade-engine/pseudo-position-manager", () => ({
  nanoid: jest.fn((size = 8) => "r".repeat(size)),
}))

jest.mock("@/lib/engine-progression-logs", () => ({
  logProgressionEvent: jest.fn(async () => undefined),
}))

jest.mock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))

jest.mock("@/lib/volume-calculator", () => ({
  VolumeCalculator: {
    calculateVolumeForConnection: (...args: any[]) => mockCalculateVolumeForConnection(...args),
    logVolumeCalculation: jest.fn(async () => undefined),
  },
}))

jest.mock("@/lib/system-logger", () => ({
  SystemLogger: { logError: jest.fn(async () => undefined) },
}))

jest.mock("@/lib/leverage-policy", () => ({ getMaxLeverageForExchange: jest.fn(() => 10) }))

jest.mock("@/lib/live-order-logger", () => ({
  newLiveOrderTrace: jest.fn(() => ({
    traceId: "trace-main-live",
    exchangeTrackingId: "cts-main-live-entry",
    connectionId: connection.id,
    symbol: "BTCUSDT",
    direction: "long",
    exchangeSide: "buy",
  })),
  withLiveOrderLogging: jest.fn(async (_trace: any, _context: any, work: () => Promise<any>) => ({ raw: await work() })),
  logLiveOrderFinal: jest.fn(async () => undefined),
}))

jest.mock("@/lib/trade-engine/progression-lock", () => ({
  getCurrentEpoch: jest.fn(async () => "epoch-main-live"),
}))

jest.mock("@/lib/trade-engine/progression-writes", () => ({
  hincrbyProgression: jest.fn(async () => 1),
}))

jest.mock("@/lib/live-order-service", () => ({
  recordPerSymbolOrderCounter: jest.fn(async () => undefined),
  recordLiveOrderProgression: (...args: any[]) => mockRecordLiveOrderProgression(...args),
  // The production live stage now asks the shared order service for the
  // authoritative venue settlement after an inline/polled fill.  Most tests
  // in this suite intentionally exercise the older connector shape without
  // an order-history endpoint, so model that valid "not available yet"
  // result instead of removing the export entirely from the module mock.
  readOrderSettlement: (...args: any[]) => mockReadOrderSettlement(...args),
  setupLiveOrderMarginAndLeverage: jest.fn(async (
    connector: any,
    symbol: string,
    options: { marginType?: "cross" | "isolated"; leverage?: number } = {},
  ) => {
    const marginType = options.marginType || "cross"
    let marginConfigured = false
    if (typeof connector?.setMarginType === "function") {
      const margin = await connector.setMarginType(symbol, marginType)
      if (margin?.success === false) throw new Error(margin.error || "margin rejected")
      marginConfigured = true
    }
    const leverage = Math.max(1, Number(options.leverage) || 1)
    let leverageConfigured = false
    if (leverage > 1 && typeof connector?.setLeverage === "function") {
      const leverageResult = await connector.setLeverage(symbol, leverage)
      if (leverageResult?.success === false) throw new Error(leverageResult.error || "leverage rejected")
      leverageConfigured = true
    }
    return { marginType, marginConfigured, leverageConfigured }
  }),
}))

jest.mock("@/lib/preset-store", () => ({
  applySelectedPresetToRealPosition: (...args: any[]) => applySelectedPresetToRealPosition(...args),
}))

describe("Main Trade Engine Real → Live dispatch", () => {
  const originalRedisUrl = process.env.REDIS_URL
  const originalInline = process.env.ALLOW_INLINE_REDIS_LIVE_TRADING

  beforeEach(async () => {
    strings.clear()
    hashes.clear()
    lists.clear()
    sets.clear()
    sortedSets.clear()
    cancelledVenueOrderIds.clear()
    venueQuantityOverrides.clear()
    jest.clearAllMocks()
    mockReadOrderSettlement.mockResolvedValue(null)
    mockCalculateVolumeForConnection.mockImplementation(async () => ({
      finalVolume: 0.01,
      volume: 0.01,
      leverage: 10,
      maxExecutionNotionalUsd: 50,
      volumeAdjusted: false,
    }))
    firstEntryRequestAt = 0
    protectionRequestTimes = []
    placeOrder.mockImplementation(async (symbol: string) => {
      if (firstEntryRequestAt === 0) firstEntryRequestAt = performance.now()
      return {
        success: true,
        orderId: `bingx-entry-${symbol}`,
        status: "filled",
        filledQty: 0.01,
        filledPrice: 100,
      }
    })
    placeStopOrder.mockImplementation(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string, options: any = {}) => {
      protectionRequestTimes.push(performance.now())
      const clientOrderId = options?.clientOrderId
      return {
        success: true,
        orderId: `bingx-${kind}-${symbol}-${clientOrderId || placeStopOrder.mock.calls.length}`,
        ...(clientOrderId ? { clientOrderId } : {}),
      }
    })
    recordingConnector.getTicker.mockImplementation(async () => ({ bid: 99.9, ask: 100, last: 100 }))
    recordingConnector.getPosition.mockImplementation(async (_symbol: string, direction?: string) => ({
      positionAmt: 0.01,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: String(direction || "").toLowerCase() === "short" ? 150 : 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    recordingConnector.getPositions.mockImplementation(async () => venuePositionSnapshot())
    recordingConnector.getLastPositionsSnapshotStatus.mockImplementation(() => ({ ok: true }))
    recordingConnector.getOpenOrders.mockImplementation(async () => venueOpenOrderSnapshot())
    recordingConnector.getLastOpenOrdersSnapshotStatus.mockImplementation(() => ({ ok: true }))
    recordingConnector.getCapabilities.mockImplementation(() => ["position_close_all_stop"])
    connection.is_live_trade = "1"
    connection.live_trade_requested = "1"
    connection.is_preset_trade = "0"
    connection.live_trade_blocked_reason = ""
    process.env.REDIS_URL = "redis://shared-recording"
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    const { __liveStageTest } = await import("@/lib/trade-engine/stages/live-stage")
    __liveStageTest.clearLiveTickerCache()
  })

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = originalRedisUrl
    if (originalInline === undefined) delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    else process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = originalInline
  })

  test("routes a qualifying Main real position to the exchange connector, not simulation", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    // Exclude the one-time Jest/TS module transform from the dispatch budget;
    // the measured contract starts when the already-loaded live stage begins
    // routing the position to the connector.
    const dispatchStartedAt = performance.now()
    const result = await executeLivePosition(connection.id, {
      id: "real-main-1",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(placeOrder).toHaveBeenCalledTimes(1)
    expect(placeOrder).toHaveBeenCalledWith(
      "BTCUSDT",
      "buy",
      0.01,
      undefined,
      "market",
      expect.objectContaining({
        hedgeMode: true,
        positionSide: "LONG",
        clientOrderId: "cts-main-live-entry",
      }),
    )
    expect(result).toMatchObject({
      status: "open",
      executionMode: "live",
      orderId: "bingx-entry-BTCUSDT",
      executedQuantity: 0.01,
      averageExecutionPrice: 100,
    })
    expect(result.status).not.toBe("simulated")
    expect(placeStopOrder).toHaveBeenCalledTimes(3)
    expect(firstEntryRequestAt - dispatchStartedAt).toBeLessThan(300)
    expect(Math.max(...protectionRequestTimes) - dispatchStartedAt).toBeLessThan(1_000)
    expect(performance.now() - dispatchStartedAt).toBeLessThan(1_000)
  })

  test("rejects a quote-domain settlement price before it can corrupt protection and PnL", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    mockReadOrderSettlement.mockResolvedValue({
      orderId: "bingx-entry-EYEUSDT",
      symbol: "EYE-USDT",
      filledQuantity: 0.01,
      averageFillPrice: 10_042.420596734958,
      grossRealizedPnl: 0,
      tradingFee: 0,
      netRealizedPnl: 0,
      netIncludesEntryFee: false,
      source: "bingx_fill_history",
      settledAt: Date.now(),
      fills: [],
    })

    const result = await executeLivePosition(connection.id, {
      id: "real-entry-price-domain-guard",
      connectionId: connection.id,
      symbol: "EYEUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(result).toMatchObject({
      status: "open",
      executedQuantity: 0.01,
      entryPrice: 100,
      averageExecutionPrice: 100,
    })
    expect(result.statusReason).toContain("filled_via_settlement_price_guard")
    expect(placeStopOrder).toHaveBeenCalledTimes(3)
    expect(placeStopOrder.mock.calls.every((call) => Number(call[3]) < 200)).toBe(true)
  })

  test("keeps the exact Real row Set in non-combined Live lineage", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const { calculateLivePositionStatistics } = await import("@/lib/live-position-statistics")
    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"

    const broaderBlockKey = "SOLUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0#block"
    const blockLaneKey = `${broaderBlockKey}#block_lane:direction`
    const exactLiveSetKey = `${broaderBlockKey}#row_real#row_live`
    const result = await executeLivePosition(connection.id, {
      id: "real-row-lineage",
      connectionId: connection.id,
      symbol: "SOLUSDT",
      direction: "short",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
      setKey: exactLiveSetKey,
      parentSetKey: broaderBlockKey,
      indicationType: "direction",
      setVariant: "block",
      blockLaneKey,
      accumulatedSetKeys: [broaderBlockKey, blockLaneKey],
      combinedPosCounts: false,
    } as any, recordingConnector)

    expect(result.status).toBe("simulated")
    expect(result.accumulatedSetKeys).toEqual(expect.arrayContaining([
      exactLiveSetKey,
      broaderBlockKey,
      blockLaneKey,
    ]))
    expect(calculateLivePositionStatistics([result as any]).relationIntegrity).toEqual(
      expect.objectContaining({ success: true, mismatchCount: 0 }),
    )
  })

  test("preserves Signal source/risk lineage and arms correctly-sided SL/TP controls", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const signalRisk = {
      stopLossPct: 0.45,
      takeProfitPct: 1.05,
      rewardRisk: 2.333333,
      sourceIds: ["binance-usdm", "bybit-linear", "okx-swap"],
      agreement: 0.82,
      confidence: 0.86,
      generatedAt: Date.now(),
    }
    const result = await executeLivePosition(connection.id, {
      id: "real-signal-long",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: signalRisk.stopLossPct,
      takeProfit: signalRisk.takeProfitPct,
      indicationType: "signal",
      signalRisk,
      setKey: "BTCUSDT:signal:long",
      parentSetKey: "BTCUSDT:signal:long",
      setVariant: "default",
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(result).toMatchObject({
      status: "open",
      indicationType: "signal",
      signalRisk,
      stopLoss: 0.45,
      takeProfit: 1.05,
      assignedStopLoss: 0.45,
      assignedTakeProfit: 1.05,
    })
    expect(placeStopOrder).toHaveBeenCalledTimes(3)
    for (const call of placeStopOrder.mock.calls) {
      expect(call[1]).toBe("sell")
      expect(call[2]).toBeCloseTo(result.executedQuantity, 10)
    }
    expect(placeStopOrder.mock.calls.map((call) => call[4]).sort()).toEqual(["stop_loss", "stop_loss", "take_profit"])
  })

  test("keeps normal and trailing Signal positions in independent parallel simulation lanes", async () => {
    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const signalRisk = {
      stopLossPct: 0.4,
      takeProfitPct: 1,
      rewardRisk: 2.5,
      sourceIds: ["binance-usdm", "okx-swap"],
      agreement: 0.8,
      confidence: 0.85,
      generatedAt: Date.now(),
    }
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      takeProfit: signalRisk.takeProfitPct,
      indicationType: "signal",
      signalRisk,
      status: "pending" as const,
      timestamp: Date.now(),
    }
    const standard = await executeLivePosition(connection.id, {
      ...common,
      id: "signal-standard-sim",
      stopLoss: signalRisk.stopLossPct,
      setKey: "BTCUSDT:signal:long#default",
      parentSetKey: "BTCUSDT:signal:long",
      setVariant: "default",
    } as any, recordingConnector)
    const trailing = await executeLivePosition(connection.id, {
      ...common,
      id: "signal-trailing-sim",
      stopLoss: 0.8,
      setKey: "BTCUSDT:signal:long:signal-trailing#default",
      parentSetKey: "BTCUSDT:signal:long:signal-trailing",
      setVariant: "trailing",
      trailingProfile: {
        mode: "signal_dynamic",
        startRatio: 0,
        stopRatio: 0.008,
        stepRatio: 0.004,
        minStopRatio: 0.008,
        positiveMoveRatio: 0.4,
        updateStopRangeRatio: 0.5,
      },
    } as any, recordingConnector)

    expect(standard).toMatchObject({
      status: "simulated",
      executionLane: "default",
      stopLoss: 0.4,
    })
    expect(trailing).toMatchObject({
      status: "simulated",
      executionLane: "signal_trailing",
      stopLoss: 0.8,
      trailingProfile: expect.objectContaining({ mode: "signal_dynamic" }),
    })
    expect(trailing.id).not.toBe(standard.id)
    expect(placeOrder).not.toHaveBeenCalled()
  })

  test("opens every exact Signal source and TP/SL configuration in its own slot under the shared 120 cap", async () => {
    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"
    const {
      executeLivePosition,
      getLivePositions,
    } = await import("@/lib/trade-engine/stages/live-stage")
    const configurations = [
      { sourceId: "binance-usdm", configId: "tp1_00:slr0_50:standard", takeProfitPct: 1, stopLossPct: 0.5 },
      { sourceId: "binance-usdm", configId: "tp1_50:slr1_00:standard", takeProfitPct: 1.5, stopLossPct: 1.5 },
      { sourceId: "okx-swap", configId: "tp1_00:slr0_50:standard", takeProfitPct: 1, stopLossPct: 0.5 },
    ]

    const positions = await Promise.all(configurations.map((configuration, index) => {
      const signalRisk = {
        ...configuration,
        rewardRisk: configuration.takeProfitPct / configuration.stopLossPct,
        sourceIds: [configuration.sourceId],
        configIds: [configuration.configId],
        signalLanes: [{
          sourceId: configuration.sourceId,
          configId: configuration.configId,
        }],
        agreement: 0.82,
        confidence: 0.86,
        generatedAt: Date.now(),
      }
      return executeLivePosition(connection.id, {
        id: `signal-exact-slot-${index}`,
        connectionId: connection.id,
        symbol: "SOLUSDT",
        direction: "long",
        quantity: 0,
        entryPrice: 100,
        leverage: 2,
        stopLoss: configuration.stopLossPct,
        takeProfit: configuration.takeProfitPct,
        indicationType: "signal",
        signalRisk,
        setKey:
          `SOLUSDT:signal:long:source:${configuration.sourceId}:config:${configuration.configId}`,
        parentSetKey: "SOLUSDT:signal:long",
        setVariant: "default",
        status: "pending",
        timestamp: Date.now(),
      } as any, recordingConnector)
    }))

    expect(positions.every((position) => position.status === "simulated")).toBe(true)
    expect(new Set(positions.map((position) => position.id)).size).toBe(3)
    expect(new Set(positions.map((position) => position.signalRisk?.sourceId))).toEqual(
      new Set(["binance-usdm", "okx-swap"]),
    )
    const stored = (await getLivePositions(connection.id))
      .filter((position) => position.symbol === "SOLUSDT")
    expect(stored).toHaveLength(3)
    expect(hashes.get(`signal:position_capacity:${connection.id}`)).toEqual(
      expect.objectContaining({
        total: "3",
        long: "3",
        short: "0",
        limit: "350",
      }),
    )
    expect(placeOrder).not.toHaveBeenCalled()
  })

  test("seeds an exact Signal Block parent when Normal is independently disabled", async () => {
    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const sourceId = "binance-usdm"
    const configId = "tp1_00:slr0_50:standard"
    const signalRisk = {
      sourceId,
      sourceIds: [sourceId],
      configId,
      configIds: [configId],
      signalLanes: [{ sourceId, configId }],
      stopLossPct: 0.5,
      takeProfitPct: 1,
      rewardRisk: 2,
      agreement: 1,
      confidence: 0.9,
      generatedAt: Date.now(),
    }

    const result = await executeLivePosition(connection.id, {
      id: "signal-block-only-paper-seed",
      connectionId: connection.id,
      symbol: "AVAXUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 0.5,
      takeProfit: 1,
      indicationType: "signal",
      signalRisk,
      setKey: `AVAXUSDT:signal:long:source:${sourceId}:config:${configId}#block:1`,
      parentSetKey: `AVAXUSDT:signal:long:source:${sourceId}:config:${configId}`,
      setVariant: "block",
      blockSourceId: sourceId,
      blockCount: 1,
      blockVolumeRatio: 1,
      sizeMultiplier: 2,
      blockCalculatedVolumeMultiplier: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(result).toMatchObject({
      status: "simulated",
      executionMode: "simulation",
      indicationType: "signal",
      setVariant: "block",
      blockBaseQuantity: 0.005,
      signalRisk: expect.objectContaining({ sourceId, configId }),
    })
    expect(result.blockLegs).toEqual([
      expect.objectContaining({
        blockCount: 1,
        baseQuantity: 0.005,
        targetBlockQuantity: 0.01,
      }),
    ])
    expect(placeOrder).not.toHaveBeenCalled()
  })

  test("executes source-scoped Signal Block targets once, aliases covered lanes, and books close PnL exactly once", async () => {
    const {
      closeLivePosition,
      executeLivePosition,
    } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    const settlements = new Map<string, Record<string, any>>()
    mockReadOrderSettlement.mockImplementation(async (_connector, _symbol, orderId) => (
      settlements.get(String(orderId)) || null
    ))
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.positionSide === "LONG") {
        venueQuantity = options.reduceOnly === true
          ? Math.max(0, venueQuantity - quantity)
          : venueQuantity + quantity
      }
      const orderId = `signal-block-${symbol}-${placeOrder.mock.calls.length}`
      const filledPrice = options.reduceOnly === true ? 102 : 100
      const grossRealizedPnl = options.reduceOnly === true ? quantity * 2 : 0
      settlements.set(orderId, {
        orderId,
        symbol,
        filledQuantity: quantity,
        averageFillPrice: filledPrice,
        grossRealizedPnl,
        tradingFee: 0,
        netRealizedPnl: grossRealizedPnl,
        netIncludesEntryFee: true,
        source: "bingx_fill_history",
        settledAt: Date.now(),
        fills: [],
      })
      return {
        success: true,
        orderId,
        status: "filled",
        filledQty: quantity,
        filledPrice,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    recordingConnector.getPositions.mockImplementation(async () => venueQuantity > 0
      ? [{
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: venueQuantity,
          entryPrice: 100,
          markPrice: 100,
          liquidationPrice: 50,
        }]
      : [])
    const signalRisk = {
      stopLossPct: 0.4,
      takeProfitPct: 1,
      rewardRisk: 2.5,
      sourceIds: ["binance-usdm", "okx-swap"],
      agreement: 0.9,
      confidence: 0.9,
      generatedAt: Date.now(),
    }
    const baseSetKey = "BTCUSDT:signal:long"
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: signalRisk.stopLossPct,
      takeProfit: signalRisk.takeProfitPct,
      status: "pending" as const,
      timestamp: Date.now(),
      indicationType: "signal",
      signalRisk,
      parentSetKey: baseSetKey,
    }

    const parent = await executeLivePosition(connection.id, {
      ...common,
      id: "signal-scoped-parent",
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)
    expect(parent.executedQuantity).toBeCloseTo(0.01, 12)
    expect(mockCalculateVolumeForConnection).toHaveBeenCalledWith(
      connection.id,
      "BTCUSDT",
      100,
      expect.objectContaining({
        tradeMode: "main",
        indicationType: "signal",
      }),
    )

    const binancePhysical =
      `${baseSetKey}#block:3#scope:overall:long#source:binance-usdm`
    const binanceLane =
      "block_lane:BTCUSDT:signal_source:source:binance-usdm:overall:3"
    let position = await executeLivePosition(connection.id, {
      ...common,
      id: "signal-scoped-binance-block",
      setKey: binancePhysical,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
      blockScope: "overall",
      blockLaneKind: "signal_source",
      blockLaneKey: binanceLane,
      blockSourceId: "binance-usdm",
      blockConfiguredMinimumProfitFactor: 4.32,
      blockNormalProfitFactor: 2,
      blockMinimumProfitFactor: 4.32,
      blockObservedProfitFactor: 5,
      blockProfitFactorDifference: 3,
      blockComparisonAvailable: true,
      accumulatedSetKeys: [binancePhysical, binanceLane],
    } as any, recordingConnector)

    // Default steps=2: General 0.01 × (1 + 1.5)² = 0.0625.
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(placeOrder.mock.calls[1]?.[2]).toBeCloseTo(0.0525, 12)
    expect(position).toMatchObject({
      indicationType: "signal",
      signalRisk,
      blockLegs: [
        expect.objectContaining({
          setKey: binancePhysical,
          blockCount: 3,
          requestedQuantity: 0.0525,
          targetBlockQuantity: 0.0625,
          incrementSteps: 2,
          effectiveIncrementStep: 2,
          laneKey: binanceLane,
          sourceId: "binance-usdm",
          scope: "overall",
        }),
      ],
    })
    expect(position.accumulatedSetKeys).toEqual(expect.arrayContaining([
      baseSetKey,
      binancePhysical,
      binanceLane,
    ]))
    const latestLongProtection = placeStopOrder.mock.calls
      .filter((call) => call[5]?.positionSide === "LONG")
      .slice(-2)
    expect(latestLongProtection).toHaveLength(2)
    expect(latestLongProtection.every((call) =>
      call[1] === "sell" &&
      call[2] === 0.0625 &&
      call[5]?.reduceOnly === true
    )).toBe(true)

    // A second independent source/scope lane at the same absolute Count target
    // receives lineage and PnL attribution, but cannot add the full volume a
    // second time because the physical Long target is already covered.
    const okxPhysical =
      `${baseSetKey}#block:3#scope:overall:long#source:okx-swap`
    const okxLane =
      "block_lane:BTCUSDT:signal_source:source:okx-swap:overall:3"
    const orderCallsBeforeCoveredLane = placeOrder.mock.calls.length
    position = await executeLivePosition(connection.id, {
      ...common,
      id: "signal-scoped-okx-covered",
      setKey: okxPhysical,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
      blockScope: "overall",
      blockLaneKind: "signal_source",
      blockLaneKey: okxLane,
      blockSourceId: "okx-swap",
      accumulatedSetKeys: [okxPhysical, okxLane],
    } as any, recordingConnector)
    expect(placeOrder).toHaveBeenCalledTimes(orderCallsBeforeCoveredLane)
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(position.accumulatedSetKeys).toEqual(expect.arrayContaining([
      okxPhysical,
      okxLane,
    ]))
    expect(position.blockLegs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        setKey: okxPhysical,
        quantity: 0,
        requestedQuantity: 0,
        targetBlockQuantity: 0.0625,
        laneKey: okxLane,
        sourceId: "okx-swap",
      }),
    ]))

    const closed = await closeLivePosition(
      connection.id,
      position.id,
      102,
      recordingConnector,
      "exchange_reconciliation",
    )
    expect(closed).toMatchObject({
      status: "closed",
      direction: "long",
      indicationType: "signal",
      signalRisk,
    })
    expect(Number(closed?.realizedPnL)).toBeGreaterThan(0)

    for (const key of [binancePhysical, binanceLane, okxPhysical, okxLane]) {
      expect(lists.get(`strategy_set_result_ring:${connection.id}:${key}`)).toHaveLength(1)
    }
    for (const sourceId of ["binance-usdm", "okx-swap", "consensus"]) {
      const performanceKey =
        `signal:performance:${connection.id}:${sourceId}:BTCUSDT:long`
      expect(hashes.get(performanceKey)).toEqual(expect.objectContaining({
        count: "1",
        wins: "1",
        autoDisabled: "0",
      }))
      expect(lists.get(`${performanceKey}:samples`)).toHaveLength(1)
    }

    await expect(closeLivePosition(
      connection.id,
      position.id,
      103,
      undefined,
      "signal_scope_replay",
    )).resolves.toBeNull()
    for (const sourceId of ["binance-usdm", "okx-swap", "consensus"]) {
      expect(hashes.get(
        `signal:performance:${connection.id}:${sourceId}:BTCUSDT:long`,
      )?.count).toBe("1")
    }
  })

  test("keeps Signal Block attribution and tighter protection on a Direction-owned parent across hash-only restart", async () => {
    const {
      closeLivePosition,
      executeLivePosition,
      getLivePositions,
    } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    const settlements = new Map<string, Record<string, any>>()
    mockReadOrderSettlement.mockImplementation(async (_connector, _symbol, orderId) => (
      settlements.get(String(orderId)) || null
    ))
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.positionSide === "LONG") {
        venueQuantity = options.reduceOnly === true
          ? Math.max(0, venueQuantity - quantity)
          : venueQuantity + quantity
      }
      const orderId = `mixed-signal-${symbol}-${placeOrder.mock.calls.length}`
      const filledPrice = options.reduceOnly === true ? 102 : 100
      const grossRealizedPnl = options.reduceOnly === true ? quantity * 2 : 0
      settlements.set(orderId, {
        orderId,
        symbol,
        filledQuantity: quantity,
        averageFillPrice: filledPrice,
        grossRealizedPnl,
        tradingFee: 0,
        netRealizedPnl: grossRealizedPnl,
        netIncludesEntryFee: true,
        source: "bingx_fill_history",
        settledAt: Date.now(),
        fills: [],
      })
      return {
        success: true,
        orderId,
        status: "filled",
        filledQty: quantity,
        filledPrice,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    recordingConnector.getPositions.mockImplementation(async () => venueQuantity > 0
      ? [{
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: venueQuantity,
          entryPrice: 100,
          markPrice: 100,
          liquidationPrice: 50,
        }]
      : [])

    const parent = await executeLivePosition(connection.id, {
      id: "mixed-direction-parent",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 2,
      takeProfit: 4,
      indicationType: "direction",
      setKey: "BTCUSDT:direction:long#base",
      parentSetKey: "BTCUSDT:direction:long",
      setVariant: "default",
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    const signalRisk = {
      stopLossPct: 0.35,
      takeProfitPct: 0.9,
      rewardRisk: 0.9 / 0.35,
      sourceIds: ["binance-usdm", "okx-swap"],
      agreement: 0.84,
      confidence: 0.87,
      generatedAt: Date.now(),
    }
    const signalSetKey =
      "BTCUSDT:signal:long#block:1#scope:long#source:binance-usdm"
    const signalLaneKey =
      "block_lane:BTCUSDT:signal_source:source:binance-usdm:long:1"
    const accumulated = await executeLivePosition(connection.id, {
      id: "mixed-signal-block",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: signalRisk.stopLossPct,
      takeProfit: signalRisk.takeProfitPct,
      indicationType: "signal",
      signalRisk,
      setKey: signalSetKey,
      parentSetKey: "BTCUSDT:signal:long",
      setVariant: "block",
      blockCount: 1,
      blockVolumeRatio: 1,
      blockScope: "long",
      blockLaneKind: "signal_source",
      blockLaneKey: signalLaneKey,
      blockSourceId: "binance-usdm",
      accumulatedSetKeys: [signalSetKey, signalLaneKey],
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(accumulated).toMatchObject({
      id: parent.id,
      indicationType: "direction",
      executedQuantity: 0.02,
      stopLoss: 0.35,
      takeProfit: 0.9,
      signalRisk,
    })
    expect(accumulated.accumulatedSetKeys).toEqual(expect.arrayContaining([
      signalSetKey,
      signalLaneKey,
    ]))
    expect(accumulated.blockLegs).toEqual([
      expect.objectContaining({
        setKey: signalSetKey,
        quantity: 0.01,
        targetBlockQuantity: 0.02,
        laneKey: signalLaneKey,
        sourceId: "binance-usdm",
      }),
    ])
    const rearmed = placeStopOrder.mock.calls
      .filter((call) => call[5]?.positionSide === "LONG")
      .filter((call) => call[5]?.clientOrderId?.includes("sec") !== true)
      .slice(-2)
    expect(rearmed).toHaveLength(2)
    expect(rearmed.every((call) =>
      call[1] === "sell" &&
      call[2] === 0.02 &&
      call[5]?.reduceOnly === true
    )).toBe(true)
    expect(rearmed.find((call) => call[4] === "stop_loss")?.[3]).toBeCloseTo(99.65, 10)
    expect(rearmed.find((call) => call[4] === "take_profit")?.[3]).toBeCloseTo(100.9, 10)
    const securityRearmed = placeStopOrder.mock.calls
      .filter((call) => call[5]?.positionSide === "LONG")
      .filter((call) => call[5]?.clientOrderId?.includes("sec"))
      .at(-1)
    expect(securityRearmed?.[2]).toBeCloseTo(0.02, 10)
    expect(securityRearmed?.[3]).toBeCloseTo(99.61, 10)

    // Reproduce a process restart where the legacy JSON mirror was not
    // available and only Redis' string-valued canonical hash survived.
    const canonicalHashKey =
      `live_positions:${connection.id}:${accumulated.id}`
    const persistedHash = hashes.get(canonicalHashKey)
    expect(persistedHash).toBeDefined()
    hashes.set(canonicalHashKey, Object.fromEntries(
      Object.entries(persistedHash || {}).map(([field, value]) => [
        field,
        value && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
      ]),
    ))
    strings.delete(`live:position:${accumulated.id}`)

    const restored = (await getLivePositions(connection.id))
      .find((position) => position.id === accumulated.id)
    expect(restored).toMatchObject({
      indicationType: "direction",
      stopLoss: 0.35,
      takeProfit: 0.9,
      signalRisk,
    })
    expect(restored?.blockLegs).toEqual([
      expect.objectContaining({
        setKey: signalSetKey,
        quantity: 0.01,
        targetBlockQuantity: 0.02,
      }),
    ])
    expect(restored?.combinedPosCounts).toBe(false)

    const closed = await closeLivePosition(
      connection.id,
      accumulated.id,
      102,
      recordingConnector,
      "mixed_signal_restart",
    )
    expect(closed).toMatchObject({
      status: "closed",
      indicationType: "direction",
      signalRisk,
    })
    expect(strings.has(`live:lock:${connection.id}:BTCUSDT:long`)).toBe(false)
    expect(Number(closed?.realizedPnL)).toBeGreaterThan(0)
    for (const sourceId of ["binance-usdm", "okx-swap", "consensus"]) {
      const performanceKey =
        `signal:performance:${connection.id}:${sourceId}:BTCUSDT:long`
      expect(hashes.get(performanceKey)).toEqual(expect.objectContaining({
        count: "1",
        wins: "1",
        autoDisabled: "0",
      }))
      expect(lists.get(`${performanceKey}:samples`)).toHaveLength(1)
    }
  })

  test("attaches independent Block counts and sequential DCA steps to one confirmed parent", async () => {
    const { executeLivePosition, __liveStageTest } = await import("@/lib/trade-engine/stages/live-stage")
    placeOrder.mockImplementation(async (symbol: string, _side: string, quantity: number) => ({
      success: true,
      orderId: `exact-fill-${symbol}-${placeOrder.mock.calls.length}`,
      status: "filled",
      filledQty: quantity,
      filledPrice: 100,
    }))
    const baseSetKey = "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0"
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    const parent = await executeLivePosition(connection.id, {
      ...common,
      id: "real-adjust-parent",
      entryPrice: 100,
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)
    expect(parent).toMatchObject({ status: "open", executedQuantity: 0.01, setKey: baseSetKey })

    const blockSetKey = `${baseSetKey}#block:2`
    const afterBlock = await executeLivePosition(connection.id, {
      ...common,
      id: "real-adjust-block-2",
      entryPrice: 100,
      setKey: blockSetKey,
      setVariant: "block",
      blockCount: 2,
      blockVolumeRatio: 0.5,
      blockVolumeIncrementRatio: 1,
      blockBaseVolumeMultiplier: 1.25,
      blockCalculatedVolumeMultiplier: 1.25,
    } as any, recordingConnector)
    expect(placeOrder.mock.calls[1]?.[2]).toBeCloseTo(0.0125, 10)
    expect(afterBlock).toMatchObject({
      id: parent.id,
      status: "open",
      executedQuantity: 0.0225,
      accumulatedSetKeys: expect.arrayContaining([baseSetKey, blockSetKey]),
    })
    expect(afterBlock.blockLegs).toEqual([
      expect.objectContaining({
        setKey: blockSetKey,
        blockCount: 2,
        baseQuantity: 0.01,
        requestedQuantity: 0.0125,
        quantity: 0.0125,
        positionQuantityAfter: 0.0225,
        baseVolumeMultiplier: 1,
        volumeIncrementRatio: 1.25,
        volumeMultiplier: 2.25,
        incrementSteps: 2,
        effectiveIncrementStep: 2,
      }),
    ])

    const dcaSetKey = `${baseSetKey}#dca`
    const dcaProfile = {
      maxSteps: 4,
      stepVolumeMultipliers: [1.5, 2, 2.3, 2.5],
      stepDistancesPct: [0.5, 1, 1.5, 2],
      takeProfitMode: "average",
      breakevenProfitPct: 0.2,
      cooldownSeconds: 0,
    }
    recordingConnector.getTicker.mockResolvedValue({ bid: 98.9, ask: 99, last: 99 })
    __liveStageTest.clearLiveTickerCache()
    const afterDcaOne = await executeLivePosition(connection.id, {
      ...common,
      id: "real-adjust-dca-1",
      entryPrice: 99,
      setKey: dcaSetKey,
      setVariant: "dca",
      dcaProfile,
    } as any, recordingConnector)
    expect(placeOrder.mock.calls[2]?.[2]).toBeCloseTo(0.015, 10)
    expect(afterDcaOne.dcaLegs).toEqual([
      expect.objectContaining({
        setKey: `${dcaSetKey}#step:1`,
        step: 1,
        baseQuantity: 0.01,
        requestedQuantity: 0.015,
      }),
    ])

    recordingConnector.getTicker.mockResolvedValue({ bid: 97.9, ask: 98, last: 98 })
    __liveStageTest.clearLiveTickerCache()
    const afterDcaTwo = await executeLivePosition(connection.id, {
      ...common,
      id: "real-adjust-dca-2",
      entryPrice: 98,
      setKey: dcaSetKey,
      setVariant: "dca",
      dcaProfile,
    } as any, recordingConnector)
    expect(placeOrder.mock.calls[3]?.[2]).toBeCloseTo(0.02, 10)
    expect(afterDcaTwo.dcaLegs?.map((leg: any) => leg.setKey)).toEqual([
      `${dcaSetKey}#step:1`,
      `${dcaSetKey}#step:2`,
    ])
    expect(afterDcaTwo.accumulatedSetKeys).toEqual(expect.arrayContaining([
      blockSetKey,
      `${dcaSetKey}#step:1`,
      `${dcaSetKey}#step:2`,
    ]))
  })

  test("seeds independent Block at its absolute target and advances counts after hash-only restart", async () => {
    const {
      executeLivePosition,
      getLivePositions,
    } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    mockCalculateVolumeForConnection.mockImplementation(async (
      _connectionId: string,
      _symbol: string,
      _price: number,
      options: Record<string, any>,
    ) => {
      const quantity = Math.max(0, Number(options?.sizeMultiplier) || 1) * 0.01
      return {
        calculatedVolume: quantity,
        finalVolume: quantity,
        volume: quantity,
        exchangeMinVolume: 0.001,
        leverage: 10,
        maxExecutionNotionalUsd: 50,
        volumeAdjusted: false,
      }
    })
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.positionSide === "LONG" && options.reduceOnly !== true) {
        venueQuantity += quantity
      }
      return {
        success: true,
        orderId: `block-only-${symbol}-${placeOrder.mock.calls.length}`,
        status: "filled",
        filledQty: quantity,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))

    const baseSetKey = "AVAXUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0"
    const common = {
      connectionId: connection.id,
      symbol: "AVAXUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      indicationType: "direction",
      parentSetKey: "AVAXUSDT:direction:long",
      setVariant: "block" as const,
      blockVolumeRatio: 1,
      blockScope: "long" as const,
      status: "pending" as const,
      timestamp: Date.now(),
    }

    const countTwo = await executeLivePosition(connection.id, {
      ...common,
      id: "block-only-count-2",
      setKey: `${baseSetKey}#block:2`,
      blockCount: 2,
      sizeMultiplier: 3,
      blockCalculatedVolumeMultiplier: 3,
    } as any, recordingConnector)

    expect(placeOrder.mock.calls[0]?.[2]).toBeCloseTo(0.04, 12)
    expect(countTwo).toMatchObject({
      status: "open",
      setVariant: "block",
      executedQuantity: 0.04,
      blockBaseQuantity: 0.01,
    })
    expect(countTwo.blockLegs).toEqual([
      expect.objectContaining({
        setKey: `${baseSetKey}#block:2`,
        blockCount: 2,
        baseQuantity: 0.01,
        targetBlockQuantity: 0.04,
        incrementSteps: 2,
        effectiveIncrementStep: 2,
      }),
    ])
    expect(countTwo.blockLegs?.[0]?.requestedQuantity).toBeCloseTo(0.03, 12)
    expect(countTwo.blockLegs?.[0]?.quantity).toBeCloseTo(0.03, 12)

    const countThree = await executeLivePosition(connection.id, {
      ...common,
      id: "block-only-count-3",
      setKey: `${baseSetKey}#block:3`,
      blockCount: 3,
      sizeMultiplier: 4,
      blockCalculatedVolumeMultiplier: 4,
    } as any, recordingConnector)
    expect(countThree.id).toBe(countTwo.id)
    expect(placeOrder).toHaveBeenCalledTimes(1)
    expect(countThree.executedQuantity).toBeCloseTo(0.04, 12)
    expect(countThree.blockBaseQuantity).toBeCloseTo(0.01, 12)
    const countTwoLeg = countThree.blockLegs?.find(
      (leg: any) => leg.setKey === `${baseSetKey}#block:2`,
    )
    const countThreeLeg = countThree.blockLegs?.find(
      (leg: any) => leg.setKey === `${baseSetKey}#block:3`,
    )
    expect(countTwoLeg?.quantity).toBeCloseTo(0.03, 12)
    expect(countThreeLeg).toMatchObject({
      quantity: 0,
      requestedQuantity: 0,
      targetBlockQuantity: 0.04,
      incrementSteps: 2,
      effectiveIncrementStep: 2,
    })

    const canonicalHashKey = `live_positions:${connection.id}:${countThree.id}`
    const persistedHash = hashes.get(canonicalHashKey)
    expect(persistedHash).toBeDefined()
    hashes.set(canonicalHashKey, Object.fromEntries(
      Object.entries(persistedHash || {}).map(([field, value]) => [
        field,
        value && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
      ]),
    ))
    strings.delete(`live:position:${countThree.id}`)
    const restored = (await getLivePositions(connection.id))
      .find((position) => position.id === countThree.id)
    expect(restored).toMatchObject({
      blockBaseQuantity: 0.01,
      executedQuantity: 0.04,
    })

    const countFour = await executeLivePosition(connection.id, {
      ...common,
      id: "block-only-count-4-after-restart",
      setKey: `${baseSetKey}#block:4`,
      blockCount: 4,
      sizeMultiplier: 5,
      blockCalculatedVolumeMultiplier: 5,
    } as any, recordingConnector)
    expect(countFour.id).toBe(countTwo.id)
    expect(placeOrder).toHaveBeenCalledTimes(1)
    expect(countFour.executedQuantity).toBeCloseTo(0.04, 12)
    expect(countFour.blockBaseQuantity).toBeCloseTo(0.01, 12)
    expect(countFour.blockLegs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        setKey: `${baseSetKey}#block:4`,
        quantity: 0,
        requestedQuantity: 0,
        targetBlockQuantity: 0.04,
      }),
    ]))
  })

  test("keeps the confirmed quantity protected while an accumulation submission is unconfirmed", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const baseSetKey = "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0"
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    const parent = await executeLivePosition(connection.id, {
      ...common,
      id: "pending-acc-parent",
      entryPrice: 100,
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)
    expect(parent).toMatchObject({
      status: "open",
      executedQuantity: 0.01,
      stopLossOrderId: expect.any(String),
      takeProfitOrderId: expect.any(String),
    })

    placeOrder.mockResolvedValueOnce({
      success: false,
      error: "exchange response timeout after submission",
    } as any)
    const result = await executeLivePosition(connection.id, {
      ...common,
      id: "pending-acc-block",
      entryPrice: 100,
      setKey: `${baseSetKey}#block:2`,
      setVariant: "block",
      blockCount: 2,
      blockVolumeRatio: 0.5,
    } as any, recordingConnector)

    expect(result.executedQuantity).toBeCloseTo(0.01, 12)
    expect(result.pendingAccumulation).toMatchObject({
      setKey: `${baseSetKey}#block:2`,
      positionQuantityBefore: 0.01,
      requestedQuantity: 0.0125,
    })
    expect(result.stopLossOrderId).toEqual(expect.any(String))
    expect(result.takeProfitOrderId).toEqual(expect.any(String))
    expect(recordingConnector.cancelOrder).toHaveBeenCalledTimes(3)
    expect(placeStopOrder).toHaveBeenCalledTimes(6)
    for (const call of placeStopOrder.mock.calls.slice(-3)) {
      expect(call[2]).toBeCloseTo(0.01, 12)
      expect(call[5]).toMatchObject({ positionSide: "LONG" })
    }
    expect(
      mockRecordLiveOrderProgression.mock.calls.filter((call) =>
        call[2] === "long" && (call[3] === "placed" || call[3] === "filled"),
      ),
    ).toHaveLength(0)
  })

  test("does not cancel protection when a DCA delta is not ready", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const baseSetKey = "BTCUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0"
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "short" as const,
      quantity: 0,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:short",
      indicationType: "direction",
    }
    const parent = await executeLivePosition(connection.id, {
      ...common,
      id: "not-ready-dca-parent",
      entryPrice: 100,
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)
    recordingConnector.cancelOrder.mockClear()
    placeStopOrder.mockClear()

    const result = await executeLivePosition(connection.id, {
      ...common,
      id: "not-ready-dca-step",
      // A short DCA step needs an adverse move upward; unchanged price is
      // intentionally not ready and must not disturb existing protection.
      entryPrice: 100,
      setKey: `${baseSetKey}#dca`,
      setVariant: "dca",
      dcaProfile: {
        maxSteps: 2,
        stepVolumeMultipliers: [0.5, 1],
        stepDistancesPct: [0.5, 1],
        takeProfitMode: "average",
        breakevenProfitPct: 0.2,
        cooldownSeconds: 0,
      },
    } as any, recordingConnector)

    expect(result.id).toBe(parent.id)
    expect(result.executedQuantity).toBeCloseTo(0.01, 12)
    expect(result.pendingAccumulation).toBeUndefined()
    expect(recordingConnector.cancelOrder).not.toHaveBeenCalled()
    expect(placeStopOrder).not.toHaveBeenCalled()
  })

  test("protects only the intended retained quantity while a pos-count reduce is unconfirmed", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    mockCalculateVolumeForConnection.mockImplementation(async (
      _connectionId: string,
      _symbol: string,
      _price: number,
      options: Record<string, any>,
    ) => {
      const quantity = Number(options?.sizeMultiplier || 0) * 0.01
      return {
        calculatedVolume: quantity,
        finalVolume: quantity,
        volume: quantity,
        exchangeMinVolume: 0.001,
        leverage: 10,
        maxExecutionNotionalUsd: 50,
        volumeAdjusted: false,
      }
    })
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.reduceOnly) {
        return {
          success: false,
          error: "exchange response timeout after reduce submission",
        }
      }
      venueQuantity += quantity
      return {
        success: true,
        orderId: `combined-entry-${symbol}`,
        status: "filled",
        filledQty: quantity,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    const base = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      indicationType: "direction",
      combinedPosCounts: true,
      setVariant: "default" as const,
      parentSetKey: "BTCUSDT:direction:long",
    }
    const initialMembers = [
      "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0",
      "BTCUSDT:direction:long#axis:p4_l1_c2_opos_dlong_u0",
    ]
    const parent = await executeLivePosition(connection.id, {
      ...base,
      id: "combined-target-two",
      setKey: initialMembers[0],
      accumulatedSetKeys: initialMembers,
      posCountsSetRatios: {
        [initialMembers[0]]: 1,
        [initialMembers[1]]: 1,
      },
      posCountsLongSetCount: 2,
      posCountsShortSetCount: 0,
      posCountsNetSetCount: 2,
      sizeMultiplier: 2,
    } as any, recordingConnector)
    expect(parent.executedQuantity).toBeCloseTo(0.02, 12)
    recordingConnector.cancelOrder.mockClear()
    placeStopOrder.mockClear()

    const retainedMember = initialMembers[0]
    const result = await executeLivePosition(connection.id, {
      ...base,
      id: "combined-target-one",
      setKey: retainedMember,
      accumulatedSetKeys: [retainedMember],
      posCountsSetRatios: { [retainedMember]: 1 },
      posCountsLongSetCount: 1,
      posCountsShortSetCount: 0,
      posCountsNetSetCount: 1,
      sizeMultiplier: 1,
    } as any, recordingConnector)

    const reduceCall = placeOrder.mock.calls.find((call) => call[5]?.reduceOnly === true)
    expect(reduceCall).toBeDefined()
    expect(reduceCall?.[1]).toBe("sell")
    expect(reduceCall?.[2]).toBeCloseTo(0.01, 12)
    expect(reduceCall?.[5]).toMatchObject({
      reduceOnly: true,
      positionSide: "LONG",
      clientOrderId: expect.any(String),
    })
    expect(result.executedQuantity).toBeCloseTo(0.02, 12)
    expect(result.pendingReduction).toMatchObject({
      requestedQuantity: 0.01,
      targetQuantity: 0.01,
      positionQuantityBefore: 0.02,
    })
    expect(recordingConnector.cancelOrder).toHaveBeenCalledTimes(3)
    expect(placeStopOrder).toHaveBeenCalledTimes(3)
    const retainedRowControls = placeStopOrder.mock.calls.filter((call) => call[5]?.clientOrderId?.includes("sec") !== true)
    const retainedSecurityControl = placeStopOrder.mock.calls.filter((call) => call[5]?.clientOrderId?.includes("sec"))
    expect(retainedRowControls).toHaveLength(2)
    expect(retainedSecurityControl).toHaveLength(1)
    for (const call of retainedRowControls) {
      expect(call[2]).toBeCloseTo(0.01, 12)
      expect(call[5]).toMatchObject({
        reduceOnly: true,
        positionSide: "LONG",
      })
    }
    expect(retainedSecurityControl[0][2]).toBeCloseTo(0.02, 12)
    expect(retainedSecurityControl[0][5]).toMatchObject({
      reduceOnly: true,
      positionSide: "LONG",
    })
  })

  test("keeps same-symbol Long/Short Block batches independent with exact add volumes", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const venueQuantity = { long: 0, short: 0 }
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      const direction = options.positionSide === "SHORT" ? "short" : "long"
      venueQuantity[direction] += options.reduceOnly ? -quantity : quantity
      return {
        success: true,
        orderId: `side-batch-${symbol}-${placeOrder.mock.calls.length}`,
        status: "filled",
        filledQty: quantity,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async (_symbol: string, direction: "long" | "short") => ({
      positionAmt: venueQuantity[direction],
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: direction === "short" ? 150 : 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    recordingConnector.getPositions.mockImplementation(async () => [
      venueQuantity.long > 0 ? {
        symbol: "BTCUSDT",
        positionSide: "LONG",
        positionAmt: venueQuantity.long,
        entryPrice: 100,
        markPrice: 100,
        liquidationPrice: 50,
      } : null,
      venueQuantity.short > 0 ? {
        symbol: "BTCUSDT",
        positionSide: "SHORT",
        positionAmt: venueQuantity.short,
        entryPrice: 100,
        markPrice: 100,
        liquidationPrice: 150,
      } : null,
    ].filter(Boolean))
    const base = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      indicationType: "direction",
    }
    const longSet = "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0"
    const shortSet = "BTCUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0"

    const [longParent, shortParent] = await Promise.all([
      executeLivePosition(connection.id, {
        ...base,
        id: "long-parent",
        direction: "long",
        setKey: longSet,
        parentSetKey: "BTCUSDT:direction:long",
        setVariant: "default",
      } as any, recordingConnector),
      executeLivePosition(connection.id, {
        ...base,
        id: "short-parent",
        direction: "short",
        setKey: shortSet,
        parentSetKey: "BTCUSDT:direction:short",
        setVariant: "default",
      } as any, recordingConnector),
    ])
    expect(longParent.executedQuantity).toBeCloseTo(0.01, 12)
    expect(shortParent.executedQuantity).toBeCloseTo(0.01, 12)

    const [longAfterBlock, shortAfterBlock] = await Promise.all([
      executeLivePosition(connection.id, {
        ...base,
        id: "long-block-1",
        direction: "long",
        setKey: `${longSet}#block:1`,
        parentSetKey: "BTCUSDT:direction:long",
        setVariant: "block",
        blockCount: 1,
        blockVolumeRatio: 0.5,
      } as any, recordingConnector),
      executeLivePosition(connection.id, {
        ...base,
        id: "short-block-3",
        direction: "short",
        setKey: `${shortSet}#block:3`,
        parentSetKey: "BTCUSDT:direction:short",
        setVariant: "block",
        blockCount: 3,
        blockVolumeRatio: 0.75,
      } as any, recordingConnector),
    ])
    expect(longAfterBlock.id).toBe(longParent.id)
    expect(shortAfterBlock.id).toBe(shortParent.id)
    expect(longAfterBlock.executedQuantity).toBeCloseTo(0.015, 12)
    expect(shortAfterBlock.executedQuantity).toBeCloseTo(0.030625, 12)
    expect(longAfterBlock.blockLegs?.[0]).toMatchObject({
      blockCount: 1,
      requestedQuantity: 0.005,
      volumeIncrementRatio: 0.5,
    })
    expect(shortAfterBlock.blockLegs?.[0]).toMatchObject({
      blockCount: 3,
      requestedQuantity: 0.020625,
      volumeIncrementRatio: 2.0625,
      incrementSteps: 2,
      effectiveIncrementStep: 2,
    })

    const longBlockTwoKey = `${longSet}#block:2`
    const longAfterSecondBlock = await executeLivePosition(connection.id, {
      ...base,
      id: "long-block-2",
      direction: "long",
      setKey: longBlockTwoKey,
      parentSetKey: "BTCUSDT:direction:long",
      setVariant: "block",
      blockCount: 2,
      blockVolumeRatio: 1.25,
    } as any, recordingConnector)
    // The second Count is an absolute compound target from the same 0.01
    // General volume: 0.01 × (1 + 1.25)² = 0.050625. The earlier +0.005
    // fill is subtracted, so this order adds only +0.035625.
    expect(longAfterSecondBlock.executedQuantity).toBeCloseTo(0.050625, 12)
    expect(longAfterSecondBlock.blockLegs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        setKey: `${longSet}#block:1`,
        requestedQuantity: 0.005,
      }),
      expect.objectContaining({
        setKey: longBlockTwoKey,
        blockCount: 2,
        baseQuantity: 0.01,
        targetAdditionalQuantity: 0.040625,
        confirmedAdditionalQuantityBefore: 0.005,
        targetBlockQuantity: 0.050625,
        requestedQuantity: 0.035625,
        volumeIncrementRatio: 4.0625,
        incrementSteps: 2,
        effectiveIncrementStep: 2,
      }),
    ]))
    const longCountTwoLeg = longAfterSecondBlock.blockLegs?.find(
      (leg: any) => leg.setKey === longBlockTwoKey,
    )
    expect(longCountTwoLeg?.positionQuantityAfter).toBeCloseTo(0.050625, 12)

    const callsBeforeReplay = placeOrder.mock.calls.length
    const replayedLongBlock = await executeLivePosition(connection.id, {
      ...base,
      id: "long-block-2-replay",
      direction: "long",
      setKey: longBlockTwoKey,
      parentSetKey: "BTCUSDT:direction:long",
      setVariant: "block",
      blockCount: 2,
      blockVolumeRatio: 1.25,
    } as any, recordingConnector)
    expect(replayedLongBlock.executedQuantity).toBeCloseTo(0.050625, 12)
    expect(placeOrder).toHaveBeenCalledTimes(callsBeforeReplay)

    const entryCalls = placeOrder.mock.calls.map((call) => ({
      side: call[1],
      quantity: call[2],
      positionSide: call[5]?.positionSide,
    }))
    expect(entryCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "buy", quantity: 0.005, positionSide: "LONG" }),
      expect.objectContaining({ side: "buy", quantity: 0.035625, positionSide: "LONG" }),
      expect.objectContaining({ side: "sell", quantity: 0.020625, positionSide: "SHORT" }),
    ]))
    const adjustmentAccounting = mockRecordLiveOrderProgression.mock.calls.map((call) => ({
      symbol: call[1],
      direction: call[2],
      event: call[3],
      volumeUsd: call[4],
      options: call[6],
    }))
    expect(adjustmentAccounting.filter((call) => call.direction === "long" && call.event === "placed")).toHaveLength(2)
    expect(adjustmentAccounting.filter((call) => call.direction === "long" && call.event === "filled")).toHaveLength(2)
    expect(adjustmentAccounting.filter((call) => call.direction === "short" && call.event === "placed")).toHaveLength(1)
    expect(adjustmentAccounting.filter((call) => call.direction === "short" && call.event === "filled")).toHaveLength(1)
    expect(adjustmentAccounting.filter((call) => call.direction === "long" && call.event === "filled")
      .reduce((sum, call) => sum + Number(call.volumeUsd || 0), 0)).toBeCloseTo(4.0625, 10)
    expect(adjustmentAccounting.filter((call) => call.direction === "short" && call.event === "filled")
      .reduce((sum, call) => sum + Number(call.volumeUsd || 0), 0)).toBeCloseTo(2.0625, 10)
    expect(adjustmentAccounting.every((call) =>
      call.options?.countPositionCreated === false &&
      (call.event === "placed" || call.options?.countAccumulated === true)
    )).toBe(true)
  })

  test("reaches the capped compound target across independent Count rows without duplicate orders", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.positionSide === "LONG" && options.reduceOnly !== true) {
        venueQuantity += quantity
      }
      return {
        success: true,
        orderId: `formula-${symbol}-${placeOrder.mock.calls.length}`,
        status: "filled",
        filledQty: quantity,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))
    const baseSetKey = "BTCUSDT:direction:long#requested-formula"
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    let position = await executeLivePosition(connection.id, {
      ...common,
      id: "requested-formula-parent",
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)
    expect(position.executedQuantity).toBeCloseTo(0.01, 12)

    for (const count of [1, 2, 3]) {
      position = await executeLivePosition(connection.id, {
        ...common,
        id: `requested-formula-block-${count}`,
        setKey: `${baseSetKey}#block:${count}`,
        setVariant: "block",
        blockCount: count,
        blockVolumeRatio: 1.5,
      } as any, recordingConnector)
    }

    const longEntryQuantities = placeOrder.mock.calls
      .filter((call) => call[5]?.positionSide === "LONG" && call[5]?.reduceOnly !== true)
      .map((call) => call[2])
    expect(longEntryQuantities).toEqual([0.01, 0.015, 0.0375])

    // Steps=2: 0.01 × (1 + 1.5)² = 0.0625. Count 3 remains an
    // independent Row but cannot submit another physical order past the cap.
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(position.blockLegs).toHaveLength(3)
    expect(position.blockLegs?.map((leg: any) => leg.requestedQuantity))
      .toEqual([0.015, 0.0375, 0])
    expect(position.blockLegs?.map((leg: any) => leg.targetAdditionalQuantity))
      .toEqual([0.015, 0.0525, 0.0525])
    expect(position.blockLegs?.map((leg: any) => leg.targetBlockQuantity))
      .toEqual([0.025, 0.0625, 0.0625])
    expect(position.blockLegs?.map((leg: any) => leg.effectiveIncrementStep))
      .toEqual([1, 2, 2])

    const latestStop = placeStopOrder.mock.calls
      .filter((call) => call[5]?.positionSide === "LONG")
      .at(-1)
    expect(latestStop?.[2]).toBeCloseTo(0.0625, 12)

    const callsBeforeCoveredSet = placeOrder.mock.calls.length
    position = await executeLivePosition(connection.id, {
      ...common,
      id: "requested-formula-covered-set",
      setKey: "BTCUSDT:move:long#block:2",
      parentSetKey: "BTCUSDT:move:long",
      setVariant: "block",
      blockCount: 2,
      blockVolumeRatio: 1.5,
    } as any, recordingConnector)
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(placeOrder).toHaveBeenCalledTimes(callsBeforeCoveredSet)
    expect(position.blockLegs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        setKey: "BTCUSDT:move:long#block:2",
        quantity: 0,
        requestedQuantity: 0,
        targetAdditionalQuantity: 0.0525,
        targetBlockQuantity: 0.0625,
      }),
    ]))
  })

  test("retries only the missing Block target after a terminal partial fill", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    let entryAttempt = 0
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      if (options.positionSide !== "LONG" || options.reduceOnly === true) {
        return { success: true, orderId: `partial-control-${symbol}` }
      }
      entryAttempt += 1
      const filledQty = entryAttempt === 2 ? 0.02 : quantity
      venueQuantity += filledQty
      return {
        success: true,
        orderId: `partial-block-${entryAttempt}`,
        status: "filled",
        filledQty,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async () => ({
      positionAmt: venueQuantity,
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: 50,
      unrealizedPnl: 0,
      marginType: "cross",
    }))

    const baseSetKey = "BTCUSDT:direction:long#terminal-partial"
    const blockSetKey = `${baseSetKey}#block:3`
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    await executeLivePosition(connection.id, {
      ...common,
      id: "terminal-partial-parent",
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)

    let position = await executeLivePosition(connection.id, {
      ...common,
      id: "terminal-partial-block-first",
      setKey: blockSetKey,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
    } as any, recordingConnector)

    expect(placeOrder.mock.calls[1]?.[2]).toBeCloseTo(0.0525, 12)
    expect(position.executedQuantity).toBeCloseTo(0.03, 12)
    expect(position.pendingAccumulation).toBeUndefined()
    expect(position.accumulatedSetKeys).not.toContain(blockSetKey)
    expect(position.blockLegs).toEqual([
      expect.objectContaining({
        setKey: blockSetKey,
        quantity: 0.02,
        targetAdditionalQuantity: 0.0525,
        requestedQuantity: 0.0525,
        targetSatisfied: false,
      }),
    ])
    expect(placeStopOrder.mock.calls.at(-1)?.[2]).toBeCloseTo(0.03, 12)

    position = await executeLivePosition(connection.id, {
      ...common,
      id: "terminal-partial-block-residual",
      setKey: blockSetKey,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
    } as any, recordingConnector)

    expect(placeOrder.mock.calls[2]?.[2]).toBeCloseTo(0.0325, 12)
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(position.pendingAccumulation).toBeUndefined()
    expect(position.accumulatedSetKeys).toContain(blockSetKey)
    expect(position.blockLegs).toHaveLength(1)
    expect(position.blockLegs?.[0]).toMatchObject({
      setKey: blockSetKey,
      targetAdditionalQuantity: 0.0525,
      targetSatisfied: true,
    })
    expect(position.blockLegs?.[0]?.quantity).toBeCloseTo(0.0525, 12)
    expect(position.blockLegs?.[0]?.requestedQuantity).toBeCloseTo(0.0325, 12)
    expect(placeStopOrder.mock.calls.at(-1)?.[2]).toBeCloseTo(0.0625, 12)
  })

  test("reconciles a still-open partial Block order without a duplicate submission", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    let venueQuantity = 0
    let entryAttempt = 0
    let blockOrderId = ""
    const partialConnector = {
      ...recordingConnector,
      placeOrder: jest.fn(async (
        symbol: string,
        _side: string,
        quantity: number,
        _price: number | undefined,
        _type: string,
        options: Record<string, any> = {},
      ) => {
        if (options.positionSide !== "LONG" || options.reduceOnly === true) {
          return { success: true, orderId: `pending-control-${symbol}` }
        }
        entryAttempt += 1
        if (entryAttempt === 1) {
          venueQuantity += quantity
          return {
            success: true,
            orderId: "pending-parent-order",
            status: "filled",
            filledQty: quantity,
            filledPrice: 100,
          }
        }
        blockOrderId = "pending-block-order"
        venueQuantity += 0.02
        return {
          success: true,
          orderId: blockOrderId,
          status: "partially_filled",
          filledQty: 0.02,
          filledPrice: 100,
        }
      }),
      getPosition: jest.fn(async () => ({
        positionAmt: venueQuantity,
        entryPrice: 100,
        markPrice: 100,
        liquidationPrice: 50,
        unrealizedPnl: 0,
        marginType: "cross",
      })),
      getPositions: jest.fn(async () => venueQuantity > 0
        ? [{
            symbol: "BTCUSDT",
            positionSide: "LONG",
            positionAmt: venueQuantity,
            entryPrice: 100,
            markPrice: 100,
            liquidationPrice: 50,
          }]
        : []),
      getOrderDetails: jest.fn(async (
        _symbol: string,
        _orderId: string | undefined,
        clientOrderId: string,
      ) => {
        venueQuantity = 0.0625
        return {
          success: true,
          orderId: blockOrderId,
          clientOrderId,
          status: "filled",
          filledQty: 0.0525,
          filledPrice: 100,
        }
      }),
    }

    const baseSetKey = "BTCUSDT:direction:long#open-partial"
    const blockSetKey = `${baseSetKey}#block:3`
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    await executeLivePosition(connection.id, {
      ...common,
      id: "open-partial-parent",
      setKey: baseSetKey,
      setVariant: "default",
    } as any, partialConnector)

    let position = await executeLivePosition(connection.id, {
      ...common,
      id: "open-partial-block",
      setKey: blockSetKey,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
    } as any, partialConnector)

    expect(position.executedQuantity).toBeCloseTo(0.03, 12)
    expect(position.pendingAccumulation).toMatchObject({
      setKey: blockSetKey,
      requestedQuantity: 0.0525,
      appliedFilledQuantity: 0.02,
    })
    expect(position.accumulatedSetKeys).not.toContain(blockSetKey)
    expect(position.blockLegs?.[0]).toMatchObject({
      quantity: 0.02,
      targetSatisfied: false,
    })

    position = await executeLivePosition(connection.id, {
      ...common,
      id: "open-partial-block-reconcile",
      setKey: blockSetKey,
      setVariant: "block",
      blockCount: 3,
      blockVolumeRatio: 1.5,
    } as any, partialConnector)

    expect(partialConnector.placeOrder).toHaveBeenCalledTimes(2)
    expect(position.executedQuantity).toBeCloseTo(0.0625, 12)
    expect(position.pendingAccumulation).toBeUndefined()
    expect(position.accumulatedSetKeys).toContain(blockSetKey)
    expect(position.blockLegs?.[0]).toMatchObject({
      quantity: 0.0525,
      targetAdditionalQuantity: 0.0525,
      targetSatisfied: true,
    })
    expect(placeStopOrder.mock.calls.at(-1)?.[2]).toBeCloseTo(0.0625, 12)
  })

  test("stress-checks asymmetric Long/Short Block ladders without duplicate or stranded mutations", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const venueQuantity = { long: 0, short: 0 }
    placeOrder.mockImplementation(async (
      symbol: string,
      _side: string,
      quantity: number,
      _price: number | undefined,
      _type: string,
      options: Record<string, any> = {},
    ) => {
      const direction = options.positionSide === "SHORT" ? "short" : "long"
      venueQuantity[direction] += options.reduceOnly ? -quantity : quantity
      return {
        success: true,
        orderId: `stress-${direction}-${placeOrder.mock.calls.length}`,
        status: "filled",
        filledQty: quantity,
        filledPrice: 100,
      }
    })
    recordingConnector.getPosition.mockImplementation(async (_symbol: string, direction: "long" | "short") => ({
      positionAmt: venueQuantity[direction],
      entryPrice: 100,
      markPrice: 100,
      liquidationPrice: direction === "long" ? 50 : 150,
      unrealizedPnl: 0,
      marginType: "cross",
    }))

    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      indicationType: "direction",
    }
    const longSet = "BTCUSDT:direction:long#stress"
    const shortSet = "BTCUSDT:direction:short#stress"
    let [longPosition, shortPosition] = await Promise.all([
      executeLivePosition(connection.id, {
        ...common,
        id: "stress-long-parent",
        direction: "long",
        setKey: longSet,
        parentSetKey: "BTCUSDT:direction:long",
        setVariant: "default",
      } as any, recordingConnector),
      executeLivePosition(connection.id, {
        ...common,
        id: "stress-short-parent",
        direction: "short",
        setKey: shortSet,
        parentSetKey: "BTCUSDT:direction:short",
        setVariant: "default",
      } as any, recordingConnector),
    ])

    for (let count = 1; count <= 10; count++) {
      const mutations = [
        executeLivePosition(connection.id, {
          ...common,
          id: `stress-long-${count}`,
          direction: "long",
          setKey: `${longSet}#block:${count}`,
          parentSetKey: "BTCUSDT:direction:long",
          setVariant: "block",
          blockCount: count,
          blockVolumeRatio: 0.2,
        } as any, recordingConnector),
      ]
      if (count <= 7) {
        mutations.push(executeLivePosition(connection.id, {
          ...common,
          id: `stress-short-${count}`,
          direction: "short",
          setKey: `${shortSet}#block:${count}`,
          parentSetKey: "BTCUSDT:direction:short",
          setVariant: "block",
          blockCount: count,
          blockVolumeRatio: 0.35,
        } as any, recordingConnector))
      }
      const [nextLong, nextShort] = await Promise.all(mutations)
      longPosition = nextLong
      if (nextShort) shortPosition = nextShort
    }

    expect(longPosition.executedQuantity).toBeCloseTo(0.0144, 12)
    expect(shortPosition.executedQuantity).toBeCloseTo(0.018225, 12)
    expect(longPosition.blockLegs).toHaveLength(10)
    expect(shortPosition.blockLegs).toHaveLength(7)
    expect(new Set(longPosition.blockLegs?.map((leg: any) => leg.setKey)).size).toBe(10)
    expect(new Set(shortPosition.blockLegs?.map((leg: any) => leg.setKey)).size).toBe(7)
    expect(longPosition.blockLegs?.reduce(
      (sum: number, leg: any) => sum + Number(leg.requestedQuantity || 0),
      0,
    )).toBeCloseTo(0.0044, 12)
    expect(shortPosition.blockLegs?.reduce(
      (sum: number, leg: any) => sum + Number(leg.requestedQuantity || 0),
      0,
    )).toBeCloseTo(0.008225, 12)
    expect(longPosition.pendingAccumulation).toBeUndefined()
    expect(shortPosition.pendingAccumulation).toBeUndefined()
    expect(longPosition.pendingReduction).toBeUndefined()
    expect(shortPosition.pendingReduction).toBeUndefined()
    expect(longPosition.stopLossOrderId).toBeTruthy()
    expect(longPosition.takeProfitOrderId).toBeTruthy()
    expect(shortPosition.stopLossOrderId).toBeTruthy()
    expect(shortPosition.takeProfitOrderId).toBeTruthy()

    const callsBeforeReplay = placeOrder.mock.calls.length
    await Promise.all([
      executeLivePosition(connection.id, {
        ...common,
        id: "stress-long-replay",
        direction: "long",
        setKey: `${longSet}#block:5`,
        parentSetKey: "BTCUSDT:direction:long",
        setVariant: "block",
        blockCount: 5,
        blockVolumeRatio: 0.2,
      } as any, recordingConnector),
      executeLivePosition(connection.id, {
        ...common,
        id: "stress-short-replay",
        direction: "short",
        setKey: `${shortSet}#block:5`,
        parentSetKey: "BTCUSDT:direction:short",
        setVariant: "block",
        blockCount: 5,
        blockVolumeRatio: 0.35,
      } as any, recordingConnector),
    ])
    expect(placeOrder).toHaveBeenCalledTimes(callsBeforeReplay)

    const longEntryCalls = placeOrder.mock.calls.filter((call) => call[5]?.positionSide === "LONG")
    const shortEntryCalls = placeOrder.mock.calls.filter((call) => call[5]?.positionSide === "SHORT")
    // Parent + two physical increments. Counts above the default Step cap
    // remain independently tracked as zero-quantity Rows.
    expect(longEntryCalls).toHaveLength(3)
    expect(shortEntryCalls).toHaveLength(3)
    expect(longEntryCalls.every((call) => call[1] === "buy" && call[5]?.reduceOnly !== true)).toBe(true)
    expect(shortEntryCalls.every((call) => call[1] === "sell" && call[5]?.reduceOnly !== true)).toBe(true)
    for (const call of placeStopOrder.mock.calls) {
      const options = call[5]
      expect(options?.reduceOnly).toBe(true)
      expect(
        (call[1] === "sell" && options?.positionSide === "LONG") ||
        (call[1] === "buy" && options?.positionSide === "SHORT"),
      ).toBe(true)
    }
  })

  test("applies persisted DCA setting changes to the very next independent step", async () => {
    const { executeLivePosition, __liveStageTest } = await import("@/lib/trade-engine/stages/live-stage")
    const baseSetKey = "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0"
    const dcaSetKey = `${baseSetKey}#dca`
    const common = {
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long" as const,
      quantity: 0,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending" as const,
      timestamp: Date.now(),
      parentSetKey: "BTCUSDT:direction:long",
      indicationType: "direction",
    }

    await executeLivePosition(connection.id, {
      ...common,
      id: "real-settings-parent",
      entryPrice: 100,
      setKey: baseSetKey,
      setVariant: "default",
    } as any, recordingConnector)

    await fakeRedis.hset(`connection_settings:${connection.id}`, {
      dcaMaxSteps: "4",
      dcaStepVolumeMultipliers: JSON.stringify([0.4, 0.8, 1.2, 1.6]),
      dcaStepDistancesPct: JSON.stringify([0.5, 1, 1.5, 2]),
      dcaCooldownSeconds: "0",
    })
    recordingConnector.getTicker.mockResolvedValue({ bid: 98.9, ask: 99, last: 99 })
    __liveStageTest.clearLiveTickerCache()
    const afterStepOne = await executeLivePosition(connection.id, {
      ...common,
      id: "real-settings-dca-1",
      entryPrice: 99,
      setKey: dcaSetKey,
      setVariant: "dca",
    } as any, recordingConnector)
    expect(placeOrder.mock.calls[1]?.[2]).toBeCloseTo(0.004, 10)
    expect(afterStepOne.dcaLegs).toEqual([
      expect.objectContaining({
        setKey: `${dcaSetKey}#step:1`,
        step: 1,
        requestedQuantity: 0.004,
        volumeMultiplier: 0.4,
      }),
    ])

    // The canonical hash is written by current Settings routes. It must
    // override the position-local crash-recovery profile immediately rather
    // than waiting for the parent position to close.
    await fakeRedis.hset(`settings:connection_settings:${connection.id}`, {
      dcaStepVolumeMultipliers: JSON.stringify([0.4, 1.1, 1.2, 1.6]),
      dcaStepDistancesPct: JSON.stringify([0.5, 1, 1.5, 2]),
      dcaCooldownSeconds: "0",
    })
    recordingConnector.getTicker.mockResolvedValue({ bid: 97.9, ask: 98, last: 98 })
    __liveStageTest.clearLiveTickerCache()
    const afterStepTwo = await executeLivePosition(connection.id, {
      ...common,
      id: "real-settings-dca-2",
      entryPrice: 98,
      setKey: dcaSetKey,
      setVariant: "dca",
    } as any, recordingConnector)
    expect(placeOrder.mock.calls[2]?.[2]).toBeCloseTo(0.011, 10)
    expect(afterStepTwo.dcaLegs?.map((leg: any) => leg.setKey)).toEqual([
      `${dcaSetKey}#step:1`,
      `${dcaSetKey}#step:2`,
    ])
    expect(afterStepTwo.dcaLegs?.[1]).toEqual(expect.objectContaining({ volumeMultiplier: 1.1 }))
    expect(afterStepTwo.dcaLegs?.[1]?.requestedQuantity).toBeCloseTo(0.011, 10)
  })

  test("drains more than six simultaneous control-order legs without overlap or stranding", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    let activeStops = 0
    let peakActiveStops = 0
    const completedStops: string[] = []
    placeStopOrder.mockImplementation(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string, options: Record<string, any> = {}) => {
      protectionRequestTimes.push(performance.now())
      activeStops++
      peakActiveStops = Math.max(peakActiveStops, activeStops)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const clientOrderId = options?.clientOrderId || `${kind}-${placeStopOrder.mock.calls.length}`
      completedStops.push(`${symbol}:${kind}:${clientOrderId}`)
      activeStops--
      return { success: true, orderId: `bingx-${kind}-${symbol}-${clientOrderId}`, clientOrderId }
    })

    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
    const startedAt = performance.now()
    const results = await Promise.all(symbols.map((symbol, index) =>
      executeLivePosition(connection.id, {
        id: `real-burst-${index}`,
        connectionId: connection.id,
        symbol,
        direction: "long",
        quantity: 0,
        entryPrice: 100,
        leverage: 2,
        stopLoss: 1,
        takeProfit: 2,
        status: "pending",
        timestamp: Date.now(),
      } as any, recordingConnector),
    ))

    expect(results.every((position) => position.status === "open")).toBe(true)
    expect(completedStops).toHaveLength(12)
    expect(new Set(completedStops).size).toBe(12)
    expect(peakActiveStops).toBeLessThanOrEqual(6)
    expect(activeStops).toBe(0)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  test("does not call the exchange or create a simulated position when Main Live is requested but blocked", async () => {
    delete process.env.REDIS_URL
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const result = await executeLivePosition(connection.id, {
      id: "real-main-blocked",
      connectionId: connection.id,
      symbol: "ETHUSDT",
      direction: "short",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(placeOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: "rejected",
      executionMode: "blocked",
      executionBlockCode: "shared_redis_required",
    })
    expect(result.statusReason).toContain("shared Redis is not configured")
    expect(result.status).not.toBe("simulated")
  })

  test("does not add Block quantity to an existing exchange position after Live is switched off", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const parentSetKey = "BTCUSDT:direction:long#live-toggle-parent"
    const parent = await executeLivePosition(connection.id, {
      id: "live-toggle-parent",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      parentSetKey: "BTCUSDT:direction:long",
      setKey: parentSetKey,
      setVariant: "default",
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)
    expect(parent.status).toBe("open")
    expect(parent.executedQuantity).toBeCloseTo(0.01, 12)
    expect(placeOrder).toHaveBeenCalledTimes(1)

    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"
    const block = await executeLivePosition(connection.id, {
      id: "live-toggle-block",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      parentSetKey: "BTCUSDT:direction:long",
      setKey: `${parentSetKey}#block:1`,
      setVariant: "block",
      blockCount: 1,
      blockVolumeRatio: 1,
      blockVolumeIncrementRatio: 1,
      blockBaseVolumeMultiplier: 1,
      blockCalculatedVolumeMultiplier: 1,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(block.id).toBe(parent.id)
    expect(block.status).toBe("open")
    expect(block.executedQuantity).toBeCloseTo(parent.executedQuantity, 12)
    expect(placeOrder).toHaveBeenCalledTimes(1)
    expect(block.statusReason).toContain("adjustment deferred")
    expect(block.progression).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "accumulate_blocked_live_off", success: false }),
    ]))
  })

  test("rejects an invalid runtime direction before any exchange or control-order call", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const result = await executeLivePosition(connection.id, {
      id: "real-invalid-direction",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "sideways",
      quantity: 1,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(result.status).toBe("rejected")
    expect(result.statusReason).toContain("Invalid inputs")
    expect(placeOrder).not.toHaveBeenCalled()
    expect(placeStopOrder).not.toHaveBeenCalled()
  })

  test("executes Preset-only mode with the selected optimized protection profile", async () => {
    connection.is_live_trade = "0"
    connection.live_trade_requested = "0"
    connection.is_preset_trade = "1"
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
    const result = await executeLivePosition(connection.id, {
      id: "real-preset-live",
      connectionId: connection.id,
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0,
      entryPrice: 100,
      leverage: 2,
      stopLoss: 1,
      takeProfit: 2,
      status: "pending",
      timestamp: Date.now(),
    } as any, recordingConnector)

    expect(applySelectedPresetToRealPosition).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({ symbol: "BTCUSDT" }),
      expect.objectContaining({ is_preset_trade: "1" }),
    )
    expect(placeOrder).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: "open",
      executionMode: "live",
      executionIntent: "preset",
      assignedStopLoss: 2,
      assignedTakeProfit: 4,
      presetId: "preset-recording-1",
      presetIndicatorType: "rsi",
    })
  })
})
