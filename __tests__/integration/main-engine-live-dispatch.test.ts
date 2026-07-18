const strings = new Map<string, string>()
const hashes = new Map<string, Record<string, any>>()
const lists = new Map<string, string[]>()
const sets = new Map<string, Set<string>>()

const connection: Record<string, any> = {
  id: "bingx-main-recording",
  name: "BingX Main Recording",
  exchange: "bingx",
  api_key: "1234567890",
  api_secret: "abcdefghijklmnopqrstuvwxyz",
  is_live_trade: "1",
  live_trade_requested: "1",
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
  async del(key: string) { return strings.delete(key) ? 1 : 0 },
  async expire() { return 1 },
  async pexpire() { return 1 },
  async persist() { return 1 },
  async hset(key: string, fieldOrObject: any, value?: any) {
    const hash = hashes.get(key) || {}
    if (typeof fieldOrObject === "string") hash[fieldOrObject] = value
    else Object.assign(hash, fieldOrObject || {})
    hashes.set(key, hash)
    return 1
  },
  async hgetall(key: string) { return { ...(hashes.get(key) || {}) } },
  async hget(key: string, field: string) { return hashes.get(key)?.[field] ?? null },
  async hdel(key: string, field: string) {
    const hash = hashes.get(key)
    if (!hash || !(field in hash)) return 0
    delete hash[field]
    return 1
  },
  async hincrby(key: string, field: string, delta: number) {
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
  multi() {
    const operations: Array<() => Promise<any>> = []
    const pipeline: any = {}
    for (const method of ["sadd", "expire", "hincrby", "hset"] as const) {
      pipeline[method] = (...args: any[]) => {
        operations.push(() => (fakeRedis as any)[method](...args))
        return pipeline
      }
    }
    pipeline.exec = async () => Promise.all(operations.map((operation) => operation()))
    return pipeline
  },
}

let firstEntryRequestAt = 0
let protectionRequestTimes: number[] = []
const placeOrder = jest.fn(async (symbol: string) => {
  if (firstEntryRequestAt === 0) firstEntryRequestAt = performance.now()
  return {
    success: true,
    orderId: `bingx-entry-${symbol}`,
    status: "filled",
    filledQty: 0.01,
    filledPrice: 100,
  }
})
const placeStopOrder = jest.fn(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string) => {
  protectionRequestTimes.push(performance.now())
  return {
    success: true,
    orderId: `bingx-${kind}-${symbol}`,
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
  placeOrder,
  placeStopOrder,
  cancelOrder: jest.fn(async () => ({ success: true })),
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
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisBackend: jest.fn(() => "redis-network"),
  persistNow: jest.fn(async () => true),
  getRedisClient: jest.fn(() => fakeRedis),
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
    calculateVolumeForConnection: jest.fn(async () => ({
      finalVolume: 0.01,
      volume: 0.01,
      leverage: 10,
      volumeAdjusted: false,
    })),
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
}))

jest.mock("@/lib/preset-store", () => ({
  applySelectedPresetToRealPosition: (...args: any[]) => applySelectedPresetToRealPosition(...args),
}))

describe("Main Trade Engine Real → Live dispatch", () => {
  const originalRedisUrl = process.env.REDIS_URL
  const originalInline = process.env.ALLOW_INLINE_REDIS_LIVE_TRADING

  beforeEach(() => {
    strings.clear()
    hashes.clear()
    lists.clear()
    sets.clear()
    jest.clearAllMocks()
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
    placeStopOrder.mockImplementation(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string) => {
      protectionRequestTimes.push(performance.now())
      return { success: true, orderId: `bingx-${kind}-${symbol}` }
    })
    connection.is_live_trade = "1"
    connection.live_trade_requested = "1"
    connection.is_preset_trade = "0"
    connection.live_trade_blocked_reason = ""
    process.env.REDIS_URL = "redis://shared-recording"
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
  })

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = originalRedisUrl
    if (originalInline === undefined) delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    else process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = originalInline
  })

  test("routes a qualifying Main real position to the exchange connector, not simulation", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
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
    expect(placeStopOrder).toHaveBeenCalledTimes(2)
    expect(firstEntryRequestAt - dispatchStartedAt).toBeLessThan(300)
    expect(Math.max(...protectionRequestTimes) - dispatchStartedAt).toBeLessThan(1_000)
    expect(performance.now() - dispatchStartedAt).toBeLessThan(1_000)
  })

  test("attaches independent Block counts and sequential DCA steps to one confirmed parent", async () => {
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
    expect(placeOrder.mock.calls[1]?.[2]).toBeCloseTo(0.01, 10)
    expect(afterBlock).toMatchObject({
      id: parent.id,
      status: "open",
      executedQuantity: 0.02,
      accumulatedSetKeys: expect.arrayContaining([baseSetKey, blockSetKey]),
    })
    expect(afterBlock.blockLegs).toEqual([
      expect.objectContaining({
        setKey: blockSetKey,
        blockCount: 2,
        baseQuantity: 0.01,
        requestedQuantity: 0.01,
        quantity: 0.01,
        positionQuantityAfter: 0.02,
        volumeIncrementRatio: 1,
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

  test("applies persisted DCA setting changes to the very next independent step", async () => {
    const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
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
    placeStopOrder.mockImplementation(async (symbol: string, _side: string, _quantity: number, _trigger: number, kind: string) => {
      protectionRequestTimes.push(performance.now())
      activeStops++
      peakActiveStops = Math.max(peakActiveStops, activeStops)
      await new Promise((resolve) => setTimeout(resolve, 20))
      completedStops.push(`${symbol}:${kind}`)
      activeStops--
      return { success: true, orderId: `bingx-${kind}-${symbol}` }
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
    expect(completedStops).toHaveLength(8)
    expect(new Set(completedStops).size).toBe(8)
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
