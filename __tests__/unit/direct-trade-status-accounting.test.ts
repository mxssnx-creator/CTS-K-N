function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

describe("Direct-Trade authoritative exchange status", () => {
  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env.NODE_ENV = "test"
  })

  afterEach(() => resetInlineRedisGlobals())

  test("excludes pending live settlements and requires heartbeat plus lifecycle progress", async () => {
    const [{ GET }, { getRedisClient }, { directTradeKeyspace, DIRECT_TRADE_CONNECTION_INDEX_KEY }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/status/route"),
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const keys = directTradeKeyspace("bingx-x02")
    const cleanupKeys = [
      DIRECT_TRADE_CONNECTION_INDEX_KEY,
      ...Object.values(keys).filter((value): value is string => (
        typeof value === "string" && value.startsWith("direct_trade:")
      )),
    ]
    await redis.del(...cleanupKeys)

    try {
      const staleTick = new Date(Date.now() - 30_000).toISOString()
      const freshHeartbeat = new Date().toISOString()
      await redis.sadd(DIRECT_TRADE_CONNECTION_INDEX_KEY, "bingx-x02")
      await redis.set(keys.state, JSON.stringify({ enabled: true, liveMode: true, connectionId: "bingx-x02" }))
      await redis.set(keys.stats, JSON.stringify({ totalPnl: 999, totalPnlUsdt: 999, profitFactor: 999 }))
      await redis.set(keys.positions, JSON.stringify([
        {
          id: "accounted-loss",
          status: "closed",
          mode: "live",
          closedAt: new Date(Date.now() - 2_000).toISOString(),
          pnl: -2,
          realizedPnlUsdt: -0.2,
          pnlAccountingComplete: true,
        },
        {
          id: "pending-false-profit",
          status: "closed",
          mode: "live",
          closedAt: new Date(Date.now() - 1_000).toISOString(),
          pnl: 900,
          realizedPnlUsdt: 900,
          pnlAccountingComplete: false,
        },
        {
          id: "pending-missing-marker",
          status: "closed",
          mode: "live",
          closedAt: new Date(Date.now() - 500).toISOString(),
          pnl: 400,
          realizedPnlUsdt: 400,
        },
        {
          id: "paper-profit",
          status: "closed",
          mode: "simulated",
          closedAt: new Date().toISOString(),
          pnl: 100,
        },
      ]))
      await redis.set(keys.processor, JSON.stringify({
        instanceId: "private-worker-identity",
        lastTick: staleTick,
        tickCount: 12,
      }))
      await redis.set(keys.processorHeartbeat, freshHeartbeat)

      const scoped = await GET(new Request("http://localhost/api/trade-engine/direct-trade/status?connectionId=bingx-x02"))
        .then((response) => response.json())
      expect(scoped).toMatchObject({
        success: true,
        closedPositions: 3,
        accountingPending: 2,
        processorHealthy: false,
        processor: {
          isHealthy: false,
          heartbeatHealthy: true,
          progressHealthy: false,
          lastTick: freshHeartbeat,
          lastProgressAt: staleTick,
          tickCount: 12,
        },
        stats: {
          profitFactor: 0,
          totalPnlUsdt: -0.2,
          statsPnlBasis: "usdt",
          settledClosedCount: 1,
          accountingPending: 2,
        },
      })

      const aggregate = await GET(new Request("http://localhost/api/trade-engine/direct-trade/status?aggregate=1"))
        .then((response) => response.json())
      expect(aggregate).toMatchObject({
        success: true,
        processorHealthy: false,
        accountingPending: 2,
        connections: [{
          connectionId: "bingx-x02",
          healthy: false,
          accountingPending: 2,
          processor: { lastTick: freshHeartbeat, lastProgressAt: staleTick, tickCount: 12 },
        }],
      })
      expect(aggregate.connections[0].processor).not.toHaveProperty("instanceId")

      await redis.set(keys.processor, JSON.stringify({
        instanceId: "private-worker-identity",
        lastTick: staleTick,
        lastProgressAt: freshHeartbeat,
        lifecycleCycleCount: 44,
        tickCount: 12,
      }))
      const progressed = await GET(new Request("http://localhost/api/trade-engine/direct-trade/status?connectionId=bingx-x02"))
        .then((response) => response.json())
      expect(progressed).toMatchObject({
        processorHealthy: true,
        processor: {
          isHealthy: true,
          heartbeatHealthy: true,
          progressHealthy: true,
          lifecycleCycleCount: 44,
        },
      })

      await redis.set(keys.positions, JSON.stringify([{
        id: "only-pending",
        status: "closed",
        mode: "live",
        closedAt: new Date().toISOString(),
        realizedPnlUsdt: 12,
      }]))
      const pendingOnly = await GET(new Request("http://localhost/api/trade-engine/direct-trade/status?connectionId=bingx-x02"))
        .then((response) => response.json())
      expect(pendingOnly.stats).toMatchObject({
        profitFactor: null,
        profitFactorInfinite: false,
        totalPnlUsdt: 0,
        statsPnlBasis: "usdt",
        settledClosedCount: 0,
        accountingPending: 1,
      })
    } finally {
      await redis.del(...cleanupKeys)
    }
  })
})
