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
})
