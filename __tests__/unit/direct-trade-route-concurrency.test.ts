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

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/trade-engine/direct-trade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("Direct-Trade API state and processor lease", () => {
  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env.NODE_ENV = "test"
  })

  afterEach(() => {
    resetInlineRedisGlobals()
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
        maxPositionsPerSymbol: 999,
        maxPositionsPerDirection: 999,
      }) as any)
      const payload = await response.json()

      expect(payload.success).toBe(true)
      expect(payload.state).toMatchObject({
        enabled: true,
        liveMode: false,
        maxSlRatio: 0.25,
        inverseMaxSlRatio: 1.25,
        minProfitFactor: 0.8,
        maxDrawdownTimeMin: 99,
        trailingEnabled: false,
        keepEnabledPosCount: 99,
        maxPositionsPerSymbol: 300,
        maxPositionsPerDirection: 300,
        takeProfitRatioRange: [4, 14],
        takeProfitRatioStep: 4,
        strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection"],
      })

      const persisted = await (await GET()).json()
      expect(persisted.state).toMatchObject(payload.state)
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
      expect((await minimum.json()).state.symbolCount).toBe(1)

      const totalCap = await POST(post({ action: "update-config", maxTotalPositions: 999 }) as any)
      expect((await totalCap.json()).state.maxTotalPositions).toBe(300)
    } finally {
      await redis.del(...DIRECT_KEYS)
    }
  })

  test("migrates only former Direct-Trade defaults to the expanded TP and capacity contract", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    await redis.del(...DIRECT_KEYS)

    try {
      await redis.set("direct_trade:state", JSON.stringify({
        takeProfitRatioRange: [4, 12],
        maxPositionsPerSymbol: 3,
        maxPositionsPerDirection: 2,
      }))
      const migrated = await (await GET()).json()
      expect(migrated.state).toMatchObject({
        takeProfitRatioRange: [4, 14],
        takeProfitRatioStep: 4,
        maxPositionsPerSymbol: 12,
        maxPositionsPerDirection: 6,
      })

      await redis.set("direct_trade:state", JSON.stringify({
        takeProfitRatioRange: [2, 22],
        takeProfitRatioStep: 1,
        maxPositionsPerSymbol: 5,
        maxPositionsPerDirection: 2,
      }))
      const custom = await (await GET()).json()
      expect(custom.state).toMatchObject({
        takeProfitRatioRange: [2, 22],
        takeProfitRatioStep: 1,
        maxPositionsPerSymbol: 5,
        maxPositionsPerDirection: 2,
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
