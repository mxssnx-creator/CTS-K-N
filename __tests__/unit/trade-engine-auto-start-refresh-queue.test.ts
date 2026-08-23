describe("trade-engine auto-start queued refresh retry behavior", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("leaves failed queued refresh requests queued with incremented retry metadata", async () => {
    const request = {
      connectionId: "conn-refresh-retry",
      action: "refresh",
      state_switch_version: "7",
      reason: "unit-test",
      timestamp: new Date().toISOString(),
    }
    const storedRequest: any = { ...request }
    const actionError = new Error("hot apply failed")
    const clearEngineRefreshRequest = jest.fn().mockResolvedValue(undefined)
    const recordEngineRefreshRequestFailure = jest.fn(async (failedRequest, error) => {
      storedRequest.retryCount = Number(failedRequest.retryCount ?? 0) + 1
      storedRequest.lastError = error instanceof Error ? error.message : String(error)
      storedRequest.lastErrorAt = new Date().toISOString()
    })
    const applyPendingChangesNow = jest.fn().mockRejectedValue(actionError)
    const startMissingEngines = jest.fn().mockResolvedValue(0)

    jest.doMock("../../lib/production-readiness", () => ({
      checkProductionReadiness: jest.fn().mockResolvedValue({ ready: true, missingFields: [] }),
    }))
    jest.doMock("../../lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => ({ hgetall: jest.fn().mockResolvedValue({ operator_intent: "running" }) })),
      getAssignedAndEnabledConnections: jest.fn().mockResolvedValue([]),
      getConnection: jest.fn().mockResolvedValue({ id: request.connectionId, state_switch_version: "7" }),
    }))
    jest.doMock("../../lib/settings-storage", () => ({
      loadSettingsAsync: jest.fn().mockResolvedValue({}),
    }))
    jest.doMock("../../lib/trade-engine-worker-heartbeat", () => ({
      writeTradeEngineWorkerHeartbeat: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("../../lib/engine-refresh-queue", () => ({
      getQueuedEngineRefreshRequests: jest.fn().mockResolvedValue([{ key: "queued", request: storedRequest }]),
      clearEngineRefreshRequest,
      recordEngineRefreshRequestFailure,
    }))
    jest.doMock("../../lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        stopEngine: jest.fn().mockResolvedValue(undefined),
        isEngineRunning: jest.fn(() => true),
        applyPendingChangesNow,
        startMissingEngines,
        getActiveEngineCount: jest.fn(() => 0),
        isRunning: jest.fn(() => false),
      })),
    }))

    const { runTradeEngineHealingSweep } = await import("../../lib/trade-engine-auto-start")
    const result = await runTradeEngineHealingSweep({ isStartup: false })

    expect(result.queuedRefreshProcessedCount).toBe(0)
    expect(applyPendingChangesNow).toHaveBeenCalledWith(request.connectionId)
    expect(clearEngineRefreshRequest).not.toHaveBeenCalledWith(request.connectionId)
    expect(recordEngineRefreshRequestFailure).toHaveBeenCalledWith(storedRequest, actionError)
    expect(storedRequest).toEqual(
      expect.objectContaining({
        connectionId: request.connectionId,
        retryCount: 1,
        lastError: "hot apply failed",
        lastErrorAt: expect.any(String),
      }),
    )
    expect(startMissingEngines).toHaveBeenCalledWith([])
  })

  test("consumes a queued X02 VST start exactly once before the broad healing pass", async () => {
    const request = {
      connectionId: "bingx-x02",
      action: "start",
      state_switch_version: "12",
      reason: "production_vst_credential_injection",
      timestamp: new Date().toISOString(),
    }
    const connection = {
      id: request.connectionId,
      name: "BingX X02 Prod-VST",
      state_switch_version: request.state_switch_version,
      is_assigned: "1",
      is_enabled_dashboard: "1",
      is_testnet: "1",
    }
    let running = false
    const clearEngineRefreshRequest = jest.fn().mockResolvedValue(undefined)
    const startMissingEngines = jest.fn(async (connections) => {
      if (connections.some((candidate: any) => candidate.id === request.connectionId)) running = true
      return connections.length
    })

    jest.doMock("../../lib/production-readiness", () => ({
      checkProductionReadiness: jest.fn().mockResolvedValue({ ready: true, missingFields: [] }),
    }))
    jest.doMock("../../lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => ({ hgetall: jest.fn().mockResolvedValue({ operator_intent: "running" }) })),
      getAssignedAndEnabledConnections: jest.fn().mockResolvedValue([connection]),
      getConnection: jest.fn().mockResolvedValue(connection),
    }))
    jest.doMock("../../lib/settings-storage", () => ({
      loadSettingsAsync: jest.fn().mockResolvedValue({}),
    }))
    jest.doMock("../../lib/trade-engine-worker-heartbeat", () => ({
      writeTradeEngineWorkerHeartbeat: jest.fn().mockResolvedValue(undefined),
    }))
    // Omit the modern queue consumer deliberately: this covers the
    // compatibility consumer as well as the common AutoStart semantics.
    jest.doMock("../../lib/engine-refresh-queue", () => ({
      getQueuedEngineRefreshRequests: jest.fn().mockResolvedValue([{ key: "queued", request }]),
      clearEngineRefreshRequest,
      recordEngineRefreshRequestFailure: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("../../lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        stopEngine: jest.fn().mockResolvedValue(undefined),
        isEngineRunning: jest.fn(() => running),
        applyPendingChangesNow: jest.fn().mockResolvedValue(undefined),
        startMissingEngines,
        getActiveEngineCount: jest.fn(() => (running ? 1 : 0)),
        isRunning: jest.fn(() => running),
      })),
    }))

    const { runTradeEngineHealingSweep } = await import("../../lib/trade-engine-auto-start")
    const result = await runTradeEngineHealingSweep({ isStartup: false })

    expect(result).toMatchObject({ queuedRefreshProcessedCount: 1, eligibleCount: 1 })
    expect(startMissingEngines).toHaveBeenCalledTimes(2)
    expect(startMissingEngines).toHaveBeenNthCalledWith(1, [connection])
    expect(startMissingEngines).toHaveBeenNthCalledWith(2, [])
    expect(clearEngineRefreshRequest).toHaveBeenCalledWith(request.connectionId, request)
  })

  test("never re-starts an eligible connection while its durable stop control is pending", async () => {
    const request = {
      connectionId: "bingx-x02",
      action: "stop",
      state_switch_version: "13",
      reason: "operator_stop",
      timestamp: new Date().toISOString(),
    }
    const connection = {
      id: request.connectionId,
      name: "BingX X02 Prod-VST",
      state_switch_version: request.state_switch_version,
      is_assigned: "1",
      is_enabled_dashboard: "1",
    }
    const stopEngine = jest.fn().mockResolvedValue(undefined)
    const startMissingEngines = jest.fn().mockResolvedValue(0)

    jest.doMock("../../lib/production-readiness", () => ({
      checkProductionReadiness: jest.fn().mockResolvedValue({ ready: true, missingFields: [] }),
    }))
    jest.doMock("../../lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => ({ hgetall: jest.fn().mockResolvedValue({ operator_intent: "running" }) })),
      getAssignedAndEnabledConnections: jest.fn().mockResolvedValue([connection]),
      getConnection: jest.fn().mockResolvedValue(connection),
    }))
    jest.doMock("../../lib/settings-storage", () => ({ loadSettingsAsync: jest.fn().mockResolvedValue({}) }))
    jest.doMock("../../lib/trade-engine-worker-heartbeat", () => ({
      writeTradeEngineWorkerHeartbeat: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("../../lib/engine-refresh-queue", () => ({
      getQueuedEngineRefreshRequests: jest.fn().mockResolvedValue([{ key: "queued", request }]),
      clearEngineRefreshRequest: jest.fn().mockResolvedValue(undefined),
      recordEngineRefreshRequestFailure: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("../../lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        stopEngine,
        isEngineRunning: jest.fn(() => false),
        applyPendingChangesNow: jest.fn().mockResolvedValue(undefined),
        startMissingEngines,
        getActiveEngineCount: jest.fn(() => 0),
        isRunning: jest.fn(() => false),
      })),
    }))

    const { runTradeEngineHealingSweep } = await import("../../lib/trade-engine-auto-start")
    const result = await runTradeEngineHealingSweep({ isStartup: false })

    expect(result).toMatchObject({ queuedRefreshProcessedCount: 1, eligibleCount: 1 })
    expect(stopEngine).toHaveBeenCalledTimes(1)
    expect(startMissingEngines).toHaveBeenCalledWith([])
  })
})
