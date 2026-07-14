describe("QuickStart route ordering", () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  test("commits running intent before startEngine can check global coordinator state", async () => {
    const callOrder: string[] = []
    const globalIntent: Record<string, string> = {}

    const redisClient = {
      _stateVersion: 0,
      incr: jest.fn(async function (this: any) { return ++redisClient._stateVersion }),
      incrby: jest.fn(async (_key: string, amount: number) => (redisClient._stateVersion += amount)),
      hset: jest.fn(async (key: string, value: Record<string, string>) => {
        if (key === "trade_engine:global") {
          callOrder.push("hset:trade_engine:global")
          Object.assign(globalIntent, value)
        }
        return 1
      }),
      hgetall: jest.fn(async (key: string) => key === "trade_engine:global" ? globalIntent : {}),
      hdel: jest.fn(async () => 0),
      del: jest.fn(async () => 0),
      expire: jest.fn(async () => 1),
      set: jest.fn(async () => "OK"),
      get: jest.fn(async () => null),
      scard: jest.fn(async () => 0),
    }

    const startEngine = jest.fn(async () => {
      callOrder.push(`startEngine:${globalIntent.operator_intent}:${globalIntent.operator_stopped}`)
      return false
    })
    const startAll = jest.fn(async () => {
      callOrder.push(`startAll:${globalIntent.operator_intent}:${globalIntent.operator_stopped}`)
    })

    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn(async () => undefined),
      getRedisClient: jest.fn(() => redisClient),
      getAllConnections: jest.fn(async () => [{
        id: "conn-1",
        name: "Simulated BingX",
        exchange: "bingx",
        connector_type: "simulated",
        exchange_type: "simulated",
        api_key: "",
        api_secret: "",
      }]),
      getConnection: jest.fn(async () => ({
        id: "conn-1",
        name: "Simulated BingX",
        exchange: "bingx",
        connector_type: "simulated",
        exchange_type: "simulated",
        api_key: "",
        api_secret: "",
      })),
      updateConnection: jest.fn(async () => undefined),
      updateConnectionState: jest.fn(async (_id: string, patch: Record<string, unknown>) => ({
        applied: true,
        connection: { id: "conn-1", name: "Simulated BingX", exchange: "bingx", ...patch },
      })),
      setSettings: jest.fn(async () => undefined),
      getSettings: jest.fn(async () => ({})),
      buildMainConnectionEnableUpdate: jest.fn((connection: any) => connection),
    }))
    jest.doMock("@/lib/system-version", () => ({ API_VERSIONS: { tradeEngine: "test" } }))
    jest.doMock("@/lib/engine-progression-logs", () => ({
      logProgressionEvent: jest.fn(async () => undefined),
      getProgressionLogs: jest.fn(async () => []),
    }))
    jest.doMock("@/lib/exchange-connectors", () => ({
      createExchangeConnector: jest.fn(),
    }))
    jest.doMock("@/lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        isEngineRunning: jest.fn(() => false),
        invalidateSymbolsCacheForConnection: jest.fn(),
        applyPendingChangesNow: jest.fn(async () => undefined),
        startAll,
        startEngine,
        refreshEngines: jest.fn(async () => undefined),
      })),
    }))
    jest.doMock("@/lib/settings-storage", () => ({
      loadSettingsAsync: jest.fn(async () => ({
        mainEngineIntervalMs: 5000,
        strategyUpdateIntervalMs: 10000,
        realtimeIntervalMs: 300,
      })),
    }))
    jest.doMock("@/lib/top-symbols", () => ({
      fetchTopSymbols: jest.fn(),
      normaliseSort: jest.fn(() => "volatility_1h"),
    }))
    jest.doMock("@/lib/production-readiness", () => ({
      checkProductionReadiness: jest.fn(async () => ({ ready: true, checks: [] })),
      productionReadinessJson: jest.fn((readiness) => readiness),
    }))
    jest.doMock("@/lib/connection-recoordinator", () => ({
      applyMainConnectionSettingsChange: jest.fn(async (connectionId: string, before: any, opts: any) => {
        callOrder.push("applyMainConnectionSettingsChange")
        const after = { ...before, ...(opts.connectionPatch || {}) }
        return {
          connection: after,
          completion: {
            connectionId,
            completedAt: new Date().toISOString(),
            changedFields: opts.changedFieldsOverride || [],
            progressRecoordinationRequired: true,
          },
          stateTransitionApplied: true,
        }
      }),
    }))

    const { POST } = await import("@/app/api/trade-engine/quick-start/route")
    const response = await POST(new Request("http://localhost/api/trade-engine/quick-start", {
      method: "POST",
      body: JSON.stringify({
        action: "enable",
        connectionId: "conn-1",
        symbols: ["DRIFTUSDT"],
        liveTrade: false,
      }),
    }))

    expect(response.status).toBe(200)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const redisDb = await import("@/lib/redis-db")
    const recoordinator = await import("@/lib/connection-recoordinator")
    expect(redisDb.updateConnection).not.toHaveBeenCalled()
    expect(recoordinator.applyMainConnectionSettingsChange).toHaveBeenCalledTimes(1)
    expect(recoordinator.applyMainConnectionSettingsChange).toHaveBeenCalledWith("conn-1", expect.objectContaining({ id: "conn-1" }), expect.objectContaining({
      connectionPatch: expect.objectContaining({ live_volume_factor: "0.1" }),
      settingsPatch: expect.objectContaining({ live_volume_factor: "0.1", volume_factor_live: "0.1" }),
      changedFieldsOverride: expect.arrayContaining(["live_volume_factor", "connection_settings.live_volume_factor"]),
    }))
    expect(callOrder.indexOf("applyMainConnectionSettingsChange")).toBeGreaterThanOrEqual(0)
    expect(callOrder.indexOf("applyMainConnectionSettingsChange")).toBeLessThan(callOrder.findIndex((entry) => entry.startsWith("startAll:")))

    expect(redisClient.hset).toHaveBeenCalledWith("trade_engine:global", expect.objectContaining({
      status: "running",
      desired_status: "running",
      operator_intent: "running",
      operator_stopped: "0",
      updated_at: expect.any(String),
    }))
    expect(startAll).toHaveBeenCalled()
    expect(startEngine).toHaveBeenCalled()
    expect(callOrder.indexOf("hset:trade_engine:global")).toBeLessThan(callOrder.findIndex((entry) => entry.startsWith("startAll:")))
    expect(callOrder.indexOf("hset:trade_engine:global")).toBeLessThan(callOrder.findIndex((entry) => entry.startsWith("startEngine:")))
    expect(callOrder).toContain("startEngine:running:0")
  })
})
