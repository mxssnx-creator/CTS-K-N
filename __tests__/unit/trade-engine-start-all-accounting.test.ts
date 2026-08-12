describe("GlobalTradeEngineCoordinator.startAll result accounting", () => {
  const connection = {
    id: "conn-start-all-skipped",
    name: "Skipped Connection",
    exchange: "binance",
    is_inserted: true,
    is_enabled_dashboard: true,
    is_testnet: "true",
    is_predefined: "true",
    is_live_trade: "0",
    live_trade_enabled: "0",
    live_trade_requested: "0",
    api_key: "demo-api-key-with-valid-shape",
    api_secret: "demo-api-secret-with-valid-shape",
  }

  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    jest.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("does not count queued-only or already-owned startEngine results as started", async () => {
    const logProgressionEvent = jest.fn().mockResolvedValue(undefined)
    const updateConnectionState = jest.fn().mockResolvedValue({ applied: true })

    jest.doMock("@/lib/trade-engine/engine-manager", () => ({
      TradeEngineManager: jest.fn(),
    }))
    jest.doMock("@/lib/trade-engine/trade-engine", () => ({
      TradeEngine: jest.fn(),
      TRADE_SERVICE_NAME: "mock-trade-service",
    }))
    jest.doMock("@/lib/trade-engine/progression-lock", () => ({
      acquireProgressionLock: jest.fn(),
      forceBreakProgressionLock: jest.fn(),
    }))
    jest.doMock("@/lib/engine-refresh-queue", () => ({
      clearEngineRefreshRequest: jest.fn(),
      getQueuedEngineRefreshRequests: jest.fn().mockResolvedValue([]),
      recordEngineRefreshRequestFailure: jest.fn(),
    }))
    jest.doMock("@/lib/redis-db", () => ({
      getSettings: jest.fn().mockResolvedValue({}),
      setSettings: jest.fn().mockResolvedValue(undefined),
      initRedis: jest.fn().mockResolvedValue(undefined),
      getAllConnections: jest.fn().mockResolvedValue([connection]),
      getAssignedAndEnabledConnections: jest.fn().mockResolvedValue([connection]),
      updateConnectionState,
      getRedisClient: jest.fn(() => ({
        hgetall: jest.fn().mockResolvedValue({ status: "running" }),
      })),
    }))
    jest.doMock("@/lib/settings-storage", () => ({
      loadSettingsAsync: jest.fn().mockResolvedValue({}),
    }))
    jest.doMock("@/lib/engine-progression-logs", () => ({
      logProgressionEvent,
    }))

    const { GlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = new GlobalTradeEngineCoordinator()
    jest.spyOn(coordinator, "startEngine").mockResolvedValue(false)

    await coordinator.startAll()

    expect(coordinator.startEngine).toHaveBeenCalledTimes(1)
    expect(coordinator.isRunning()).toBe(false)
    expect(console.log).toHaveBeenCalledWith(
      "[v0] [Coordinator] ⚠ Global engine started: 0/1 connections active",
    )
    expect(console.log).not.toHaveBeenCalledWith("[v0] [Coordinator] ✓ Started: Skipped Connection")
    expect(console.warn).toHaveBeenCalledWith(
      "[v0] [Coordinator] ⚠ Skipped start for Skipped Connection: queued-only or already owned",
    )
    expect(logProgressionEvent).toHaveBeenCalledWith(
      "conn-start-all-skipped",
      "engine_start_skipped",
      "warning",
      "Coordinator start skipped",
      { connectionId: "conn-start-all-skipped", reason: "queued-only or already owned" },
    )
    expect(updateConnectionState).not.toHaveBeenCalled()
    expect(connection).toMatchObject({
      is_live_trade: "0",
      live_trade_enabled: "0",
      live_trade_requested: "0",
    })
  })
})
