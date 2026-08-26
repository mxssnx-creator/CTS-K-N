function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

const DIRECT_KEYS = [
  "direct_trade:state",
  "direct_trade:configs",
  "direct_trade:execution-configs",
  "direct_trade:execution-index",
  "direct_trade:execution-signal-index",
  "direct_trade:active-signals",
  "direct_trade:configs:manifest",
  "direct_trade:calculation",
  "direct_trade:calculation-progress",
  "direct_trade:statistics-index",
  "direct_trade:stats",
  "direct_trade:positions",
  "direct_trade:processor",
  "direct_trade:processor:lease",
  "direct_trade:calculation:lease",
  "direct_trade:config-status",
  "direct_trade:config-performance",
]

const PROCESSOR_TOKEN = "direct-trade-heartbeat-token-0123456789"

function post(body: Record<string, unknown>, processorToken?: string): Request {
  return new Request("http://localhost/api/trade-engine/direct-trade", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(processorToken ? { "x-direct-trade-processor-token": processorToken } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("Direct-Trade API state and processor lease", () => {
  const priorProcessorToken = process.env.DIRECT_TRADE_PROCESSOR_TOKEN

  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env.NODE_ENV = "test"
    process.env.DIRECT_TRADE_PROCESSOR_TOKEN = PROCESSOR_TOKEN
  })

  afterEach(() => {
    resetInlineRedisGlobals()
  })

  afterAll(() => {
    if (priorProcessorToken === undefined) delete process.env.DIRECT_TRADE_PROCESSOR_TOKEN
    else process.env.DIRECT_TRADE_PROCESSOR_TOKEN = priorProcessorToken
  })

  test("start preserves unrestricted evaluation windows while enforcing minimum PF and SL safety", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const response = await POST(post({
        action: "start",
        liveMode: false,
        maxSlRatio: 0.08,
        inverseMaxSlRatio: 2,
        minProfitFactor: 0.08,
        maxDrawdownTimeMin: 99,
        trailingEnabled: false,
        keepEnabledPosCount: 99,
        historyHours: 999,
        maxPositionsPerSymbol: 999,
        maxPositionsPerDirection: 999,
        blockProfitFactorRatio: 99,
        minVolFactor: 99,
        trailingMinTakeProfitRatio: 1,
      }) as any)
      const payload = await response.json()

      expect(payload.success).toBe(true)
      expect(payload.state).toMatchObject({
        enabled: true,
        liveMode: false,
        maxSlRatio: 0.25,
        inverseMaxSlRatio: 1.5,
        minProfitFactor: 1.02,
        maxDrawdownTimeMin: 99,
        trailingEnabled: false,
        keepEnabledPosCount: 99,
        historyHours: 90,
        maxPositionsPerSymbol: 300,
        maxPositionsPerDirection: 300,
        blockProfitFactorRatio: 5,
        minVolFactor: 10,
        trailingMinTakeProfitRatio: 2,
        processingIntervalMs: 280,
        takeProfitRatioRange: [5, 10],
        takeProfitRatioStep: 5,
        strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
      })

      const persisted = await (await GET()).json()
      expect(persisted.state).toMatchObject(payload.state)

      const minimums = await POST(post({
        action: "update-config",
        minVolFactor: 0,
        trailingMinTakeProfitRatio: 99,
      }) as any)
      expect((await minimums.json()).state).toMatchObject({
        minVolFactor: 0.1,
        trailingMinTakeProfitRatio: 22,
        processingIntervalMs: 280,
      })
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("every Direct-Trade state update accepts the shared 32-symbol maximum", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const started = await POST(post({ action: "start", symbolCount: 99 }) as any)
      expect((await started.json()).state.symbolCount).toBe(32)

      const updated = await POST(post({ action: "update-config", symbolCount: 32.9 }) as any)
      expect((await updated.json()).state.symbolCount).toBe(32)

      const minimum = await POST(post({ action: "update-config", symbolCount: 0 }) as any)
      expect((await minimum.json()).state.symbolCount).toBe(4)

      const totalCap = await POST(post({ action: "update-config", maxTotalPositions: 999 }) as any)
      expect((await totalCap.json()).state.maxTotalPositions).toBe(300)
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("persists an empty live-indication permission set while retaining all internal calculations", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const started = await POST(post({
        action: "start",
        liveMode: false,
        entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
        enabledIndicationTypes: [],
      }) as any)
      expect((await started.json()).state).toMatchObject({
        entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
        enabledIndicationTypes: [],
      })

      const persisted = await (await GET()).json()
      expect(persisted.state.enabledIndicationTypes).toEqual([])
      expect(persisted.state.entryTactics).toHaveLength(4)

      const updated = await POST(post({
        action: "update-config",
        enabledIndicationTypes: ["breakout", "relative", "invalid"],
      }) as any)
      expect((await updated.json()).state.enabledIndicationTypes).toEqual(["breakout", "relative"])
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("keeps the Direct-Trade volume factor at 0.1 by default and within 0.1–10", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const started = await POST(post({ action: "start", minVolFactor: 99 }) as any)
      expect((await started.json()).state.minVolFactor).toBe(10)

      const minimum = await POST(post({ action: "update-config", minVolFactor: 0 }) as any)
      expect((await minimum.json()).state.minVolFactor).toBe(0.1)

      const alias = await POST(post({ action: "update-config", volumeFactor: 2.4 }) as any)
      expect((await alias.json()).state.minVolFactor).toBe(2.4)

      await redis.set("direct_trade:state", JSON.stringify({ minVolFactor: 10 }))
      const legacy = await (await GET()).json()
      expect(legacy.state.minVolFactor).toBe(0.1)
      expect(legacy.state.volumeFactorDefaultsVersion).toBe(1)

      await redis.set("direct_trade:state", JSON.stringify({ minVolFactor: 10, volumeFactorDefaultsVersion: 1 }))
      const explicit = await (await GET()).json()
      expect(explicit.state.minVolFactor).toBe(10)
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("migrates only former Direct-Trade defaults to the 5× TP and capacity contract", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      await redis.set("direct_trade:state", JSON.stringify({
        takeProfitRatioRange: [4, 12],
        maxTotalPositions: 300,
        maxPositionsPerSymbol: 3,
        maxPositionsPerDirection: 2,
        historyHours: 60,
        minProfitFactor: 0.8,
      }))
      const migrated = await (await GET()).json()
      expect(migrated.state).toMatchObject({
        takeProfitRatioRange: [5, 10],
        takeProfitRatioStep: 5,
        historyHours: 48,
        maxPositionsPerSymbol: 12,
        maxPositionsPerDirection: 6,
        maxTotalPositions: 100,
        minProfitFactor: 1.1,
      })

      await redis.set("direct_trade:state", JSON.stringify({
        takeProfitRatioRange: [2, 22],
        takeProfitRatioStep: 1,
        maxPositionsPerSymbol: 5,
        maxPositionsPerDirection: 2,
        maxTotalPositions: 225,
        minProfitFactor: 1.7,
      }))
      const custom = await (await GET()).json()
      expect(custom.state).toMatchObject({
        takeProfitRatioRange: [2, 22],
        takeProfitRatioStep: 1,
        maxPositionsPerSymbol: 5,
        maxPositionsPerDirection: 2,
        maxTotalPositions: 225,
        minProfitFactor: 1.7,
      })
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("highly concurrent processors elect one writer and retain its complete snapshot", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const contenders = await Promise.all(
        Array.from({ length: 96 }, async (_, index) => {
          const response = await POST(post({
            action: "processor-sync",
            instanceId: `direct-concurrent-${index}`,
            tickCount: index,
          }) as any)
          return response.json()
        }),
      )
      const owners = contenders.filter((result) => result.leaseHeld === true)
      expect(owners).toHaveLength(1)
      const ownerId = owners[0].processor.instanceId

      const executionConfigs = [{ key: "BTCUSDT|long|1m|tp1|sl0.25|trail1", symbol: "BTCUSDT" }]
      await redis.set("direct_trade:execution-configs", JSON.stringify(executionConfigs))
      await redis.set("direct_trade:calculation", JSON.stringify({ evaluatedSets: 1, validSets: 1 }))
      const authoritative = await POST(post({
        action: "processor-sync",
        instanceId: ownerId,
        tickCount: 97,
        configCount: 1,
        positions: [{ id: "paper-1", status: "open", configKey: "BTCUSDT|long|1m|tp1|sl0.25|trail1" }],
        stats: { totalOrders: 1, totalFilled: 1, totalPnl: 2.5 },
        configStatus: { "BTCUSDT|long|1m|tp1|sl0.25|trail1": { enabled: true } },
        configPerformance: { "BTCUSDT|long|1m|tp1|sl0.25|trail1": { pf: 1.4, ddt: 4 } },
      }) as any)
      expect((await authoritative.json()).leaseHeld).toBe(true)

      const standby = await POST(post({
        action: "processor-sync",
        instanceId: "direct-standby",
        configCount: 99,
      }) as any)
      expect((await standby.json()).leaseHeld).toBe(false)

      const state = await (await GET(new Request("http://localhost/api/trade-engine/direct-trade?includeExecution=1") as any)).json()
      expect(state.activeConfigs).toBe(1)
      expect(state.executionConfigs).toEqual(executionConfigs)
      expect(state.positions).toEqual([{ id: "paper-1", status: "open", configKey: "BTCUSDT|long|1m|tp1|sl0.25|trail1" }])
      expect(state.stats).toMatchObject({ totalOrders: 1, totalFilled: 1, totalPnl: 2.5 })
      expect(state.configStatus).toEqual({ "BTCUSDT|long|1m|tp1|sl0.25|trail1": { enabled: true } })
      expect(state.configPerformance).toEqual({ "BTCUSDT|long|1m|tp1|sl0.25|trail1": { pf: 1.4, ddt: 4 } })
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("routine state reads keep the complete execution grid off the hot path", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      const executionConfigs = Array.from({ length: 512 }, (_, index) => ({
        setKey: `large-grid-${index}`,
        symbol: "BTCUSDT",
        valid: true,
      }))
      await redis.set("direct_trade:execution-configs", JSON.stringify(executionConfigs))
      await redis.set("direct_trade:calculation", JSON.stringify({
        evaluatedSets: executionConfigs.length,
        validSets: executionConfigs.length,
      }))

      const response = await GET(new Request("http://localhost/api/trade-engine/direct-trade") as any)
      const payload = await response.json()
      expect(payload).toMatchObject({
        configTotal: executionConfigs.length,
        validConfigTotal: executionConfigs.length,
      })
      expect(payload).not.toHaveProperty("executionConfigs")
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("authenticated heartbeats renew only the exact owner without replacing position snapshots", async () => {
    const [{ POST }, { getRedisClient, persistNow }, { directTradeKeyspace }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const keys = directTradeKeyspace("bingx-x02")
    const scopedKeys = Object.values(keys)
      .filter((value): value is string => typeof value === "string" && value.startsWith("direct_trade:"))
    await redis.del(...scopedKeys)

    try {
      const snapshot = [{ id: "x02-open", status: "open" }]
      const syncedProgressAt = new Date(Date.now() - 1_000).toISOString()
      const initial = await POST(post({
        action: "processor-sync",
        connectionId: "bingx-x02",
        instanceId: "worker-x02",
        tickCount: 7,
        errorsLast5min: 1,
        lifecycleCycleCount: 41,
        lastProgressAt: syncedProgressAt,
        positions: snapshot,
        stats: { totalOrders: 1 },
      }) as any)
      expect((await initial.json()).leaseHeld).toBe(true)

      const denied = await POST(post({
        action: "processor-heartbeat",
        connectionId: "bingx-x02",
        instanceId: "worker-x02",
      }, "wrong-token") as any)
      expect(denied.status).toBe(401)

      const standby = await POST(post({
        action: "processor-heartbeat",
        connectionId: "bingx-x02",
        instanceId: "standby-x02",
      }, PROCESSOR_TOKEN) as any)
      await expect(standby.json()).resolves.toMatchObject({ success: true, leaseHeld: false })

      const heartbeat = await POST(post({
        action: "processor-heartbeat",
        connectionId: "bingx-x02",
        instanceId: "worker-x02",
        tickCount: 8,
        errorsLast5min: 2,
        lifecycleCycleCount: 42,
        lastProgressAt: new Date().toISOString(),
      }, PROCESSOR_TOKEN) as any)
      await expect(heartbeat.json()).resolves.toMatchObject({ success: true, leaseHeld: true })
      expect(JSON.parse(await redis.get(keys.positions) as string)).toEqual(snapshot)
      expect(JSON.parse(await redis.get(keys.processor) as string)).toMatchObject({
        instanceId: "worker-x02",
        tickCount: 7,
        errorsLast5min: 1,
        lifecycleCycleCount: 41,
        lastProgressAt: syncedProgressAt,
      })
      expect(Date.parse(String(await redis.get(keys.processorHeartbeat)))).toBeGreaterThan(0)

      await redis.del(keys.processorLease)
      const missing = await POST(post({
        action: "processor-heartbeat",
        connectionId: "bingx-x02",
        instanceId: "worker-x02",
      }, PROCESSOR_TOKEN) as any)
      await expect(missing.json()).resolves.toMatchObject({ success: true, leaseHeld: false })
      expect(await redis.get(keys.processorLease)).toBeNull()
    } finally {
      await redis.del(...scopedKeys)
      await persistNow()
    }
  })

  test("isolates state, positions, statistics and processor leases per exchange connection", async () => {
    const [{ POST, GET }, { getRedisClient }, { directTradeKeyspace, DIRECT_TRADE_CONNECTION_INDEX_KEY }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const left = directTradeKeyspace("bingx-x01")
    const right = directTradeKeyspace("bingx-x02")
    const scopedKeys = [
      DIRECT_TRADE_CONNECTION_INDEX_KEY,
      ...Object.values(left).filter((value): value is string => typeof value === "string" && value.startsWith("direct_trade:")),
      ...Object.values(right).filter((value): value is string => typeof value === "string" && value.startsWith("direct_trade:")),
    ]
    await redis.del(...scopedKeys)
    try {
      await POST(post({ action: "start", connectionId: "bingx-x01", symbolCount: 4, liveMode: false }) as any)
      await POST(post({ action: "start", connectionId: "bingx-x02", symbolCount: 12, liveMode: false }) as any)

      const [leftSync, rightSync] = await Promise.all([
        POST(post({
          action: "processor-sync",
          connectionId: "bingx-x01",
          instanceId: "worker-left",
          positions: [{ id: "left-position", status: "open" }],
          stats: { totalOrders: 1, totalPnl: 2 },
        }) as any),
        POST(post({
          action: "processor-sync",
          connectionId: "bingx-x02",
          instanceId: "worker-right",
          positions: [{ id: "right-position", status: "open" }],
          stats: { totalOrders: 3, totalPnl: 7 },
        }) as any),
      ])
      expect((await leftSync.json()).leaseHeld).toBe(true)
      expect((await rightSync.json()).leaseHeld).toBe(true)

      const [leftRead, rightRead] = await Promise.all([
        GET(new Request("http://localhost/api/trade-engine/direct-trade?connectionId=bingx-x01") as any).then((response) => response.json()),
        GET(new Request("http://localhost/api/trade-engine/direct-trade?connectionId=bingx-x02") as any).then((response) => response.json()),
      ])
      expect(leftRead.state).toMatchObject({ connectionId: "bingx-x01", symbolCount: 4 })
      expect(leftRead.positions).toEqual([{ id: "left-position", status: "open" }])
      expect(leftRead.stats).toMatchObject({ totalOrders: 1, totalPnl: 2 })
      expect(rightRead.state).toMatchObject({ connectionId: "bingx-x02", symbolCount: 12 })
      expect(rightRead.positions).toEqual([{ id: "right-position", status: "open" }])
      expect(rightRead.stats).toMatchObject({ totalOrders: 3, totalPnl: 7 })
      expect(await redis.get(left.processorLease)).toBe("worker-left")
      expect(await redis.get(right.processorLease)).toBe("worker-right")
    } finally {
      await redis.del(...scopedKeys)
    }
  })

  test("publishes closed live accounting work to the supervisor while the scope is disabled", async () => {
    const [{ GET }, { getRedisClient }, { directTradeKeyspace, DIRECT_TRADE_CONNECTION_INDEX_KEY }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const keys = directTradeKeyspace("bingx-x01")
    const scopedKeys = [DIRECT_TRADE_CONNECTION_INDEX_KEY, ...Object.values(keys).filter(
      (value): value is string => typeof value === "string" && value.startsWith("direct_trade:"),
    )]
    await redis.del(...scopedKeys)

    try {
      await redis.sadd(DIRECT_TRADE_CONNECTION_INDEX_KEY, "bingx-x01")
      await redis.set(keys.state, JSON.stringify({
        connectionId: "bingx-x01",
        enabled: false,
        liveMode: true,
      }))
      await redis.set(keys.positions, JSON.stringify([
        { id: "settled", status: "closed", mode: "live", pnlAccountingComplete: true },
        { id: "pending", status: "closed", mode: "live", pnlAccountingComplete: false },
        { id: "pseudo", status: "closed", mode: "pseudo", pnlAccountingComplete: false },
      ]))

      const payload = await GET(new Request(
        "http://localhost/api/trade-engine/direct-trade?view=connections",
      ) as any).then((response) => response.json())

      expect(payload.connections).toEqual([
        expect.objectContaining({
          connectionId: "bingx-x01",
          enabled: false,
          openPositions: 0,
          accountingPending: 1,
        }),
      ])
    } finally {
      await redis.del(...scopedKeys)
    }
  })

  test("statistics reads a compact precomputed selection instead of the full configuration grid", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)
    try {
      const key = "1m\u0001long\u0001valid\u0001all"
      await redis.set("direct_trade:calculation", JSON.stringify({ byTimeframe: { "1m": { evaluated: 9000, valid: 4500 } } }))
      await redis.set("direct_trade:statistics-index", JSON.stringify({
        version: "test-index",
        totals: { [key]: 4500 },
        topRows: { [key]: [{ setKey: "lineage-1", symbol: "BTCUSDT", direction: "long", timeframe: "1m", valid: true }] },
      }))
      // A deliberately unrelated full-grid value must never be returned to a
      // browser Statistics request.
      await redis.set("direct_trade:configs", JSON.stringify([{ setKey: "full-grid-only" }]))

      const response = await GET(new Request("http://localhost/api/trade-engine/direct-trade?view=statistics&timeframe=1m&direction=long&state=valid") as any)
      const payload = await response.json()
      expect(payload).toMatchObject({ success: true, matched: 4500, indexVersion: "test-index" })
      expect(payload.rows).toEqual([{ setKey: "lineage-1", symbol: "BTCUSDT", direction: "long", timeframe: "1m", valid: true }])
      expect(payload).not.toHaveProperty("configs")
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("statistics resolves normalized v2 top-row references without duplicating rows", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)
    try {
      const key = "5m\u0001short\u0001inactive\u0001inverse"
      const row = {
        setKey: "lineage-v2",
        symbol: "SOLUSDT",
        direction: "short",
        timeframe: "5m",
        strategyType: "inverse",
        valid: false,
      }
      await redis.set("direct_trade:calculation", JSON.stringify({
        byTimeframe: { "5m": { evaluated: 9, valid: 4 } },
        byStrategyType: { inverse: { evaluated: 9, valid: 4 } },
      }))
      await redis.set("direct_trade:statistics-index", JSON.stringify({
        schemaVersion: 2,
        version: "test-index-v2",
        totals: { [key]: 5 },
        rows: [row],
        topRowIndexes: { [key]: [0] },
      }))

      const response = await GET(new Request(
        "http://localhost/api/trade-engine/direct-trade?view=statistics&timeframe=5m&direction=short&state=inactive&strategyType=inverse",
      ) as any)
      const payload = await response.json()
      expect(payload).toMatchObject({ success: true, matched: 5, indexVersion: "test-index-v2" })
      expect(payload.rows).toEqual([row])
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("restores eligible configurations from a compact index without duplicating the full grid", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)
    try {
      const allConfigs = [
        { setKey: "standard", strategyType: "standard", valid: true },
        { setKey: "inverse", strategyType: "inverse", valid: true },
        { setKey: "inactive", strategyType: "high_protection", valid: false },
      ]
      await redis.set("direct_trade:configs", JSON.stringify(allConfigs))
      await redis.set("direct_trade:execution-index", JSON.stringify([0, 1]))
      await redis.set("direct_trade:calculation", JSON.stringify({ evaluatedSets: 3, validSets: 2 }))

      const response = await GET(new Request("http://localhost/api/trade-engine/direct-trade?includeExecution=1") as any)
      const payload = await response.json()
      expect(payload).toMatchObject({ activeConfigs: 3, configTotal: 3, validConfigTotal: 2 })
      expect(payload.executionConfigs).toEqual([allConfigs[0], allConfigs[1]])
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("loads only the active-signal slice from a chunked maximum-grid manifest", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)
    const generation = "test-active-slice"
    const chunkKey = `direct_trade:configs:chunk:${generation}:0`
    try {
      const configs = [
        { setKey: "line-a", entrySignalKey: "signal-a", valid: true },
        { setKey: "line-b", entrySignalKey: "signal-a", valid: true },
        { setKey: "line-c", entrySignalKey: "signal-b", valid: true },
      ]
      await redis.set("direct_trade:configs:manifest", JSON.stringify({
        version: 1,
        generation,
        chunkSize: 10_000,
        chunks: 1,
        total: configs.length,
        publishedAt: new Date().toISOString(),
      }))
      await redis.set(chunkKey, JSON.stringify(configs))
      await redis.set("direct_trade:execution-index", JSON.stringify([0, 1, 2]))
      await redis.set("direct_trade:execution-signal-index", JSON.stringify({ "signal-a": [0, 1], "signal-b": [2] }))
      await redis.set("direct_trade:active-signals", JSON.stringify({ keys: ["signal-a"], asOf: new Date().toISOString() }))
      await redis.set("direct_trade:calculation", JSON.stringify({ evaluatedSets: 3, validSets: 3 }))

      const activeResponse = await GET(new Request("http://localhost/api/trade-engine/direct-trade?includeExecution=1&activeOnly=1") as any)
      const activePayload = await activeResponse.json()
      expect(activePayload.executionSelection).toBe("active-signals")
      expect(activePayload.executionConfigs).toEqual(configs.slice(0, 2))

      const unfilteredResponse = await GET(new Request("http://localhost/api/trade-engine/direct-trade?includeExecution=1") as any)
      const unfilteredPayload = await unfilteredResponse.json()
      expect(unfilteredPayload.executionConfigs).toEqual([])
      expect(unfilteredPayload).toMatchObject({ configTotal: 3, validConfigTotal: 3 })
    } finally {
      await redis.del(...DIRECT_KEYS, chunkKey)
    }
  })
})
