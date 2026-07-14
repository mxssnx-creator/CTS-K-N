describe("engine refresh queue claims", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  function mockRedis() {
    const settings = new Map<string, any>()
    const raw = new Map<string, string>()
    const sets = new Map<string, Set<string>>()

    const client = {
      set: jest.fn(async (key: string, value: string, opts?: any) => {
        if (opts?.NX && raw.has(key)) return null
        raw.set(key, value)
        return "OK"
      }),
      get: jest.fn(async (key: string) => raw.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        const deleted = raw.delete(key) || settings.delete(key.replace(/^settings:/, ""))
        return deleted ? 1 : 0
      }),
      sadd: jest.fn(async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>()
        set.add(member)
        sets.set(key, set)
        return 1
      }),
      srem: jest.fn(async (key: string, member: string) => {
        const set = sets.get(key)
        return set?.delete(member) ? 1 : 0
      }),
      smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
      keys: jest.fn(async () => []),
      expire: jest.fn(async () => 1),
    }

    jest.doMock("@/lib/redis-db", () => ({
      getRedisClient: jest.fn(() => client),
      getSettings: jest.fn(async (key: string) => settings.get(key) ?? null),
      setSettings: jest.fn(async (key: string, value: any) => {
        settings.set(key, value)
      }),
    }))
    jest.doMock("@/lib/engine-event-bus", () => ({
      publishEngineEvent: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("@/lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        drainQueuedRefreshRequestsNow: jest.fn().mockResolvedValue(undefined),
      })),
    }))

    return { client, settings, raw, sets }
  }

  test("two consumers racing the same request acquire one lease and perform one action", async () => {
    const state = mockRedis()
    const { queueEngineRefreshRequest, processQueuedEngineRefreshRequests, ENGINE_REFRESH_CLAIM_PREFIX } = await import(
      "@/lib/engine-refresh-queue"
    )
    const request = {
      connectionId: "conn-claim-race",
      action: "refresh",
      state_switch_version: "7",
      reason: "test",
      timestamp: new Date().toISOString(),
    }
    await queueEngineRefreshRequest(request)

    const act = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return "processed" as const
    })
    const getConnection = jest.fn(async () => ({ id: request.connectionId, state_switch_version: "7" }))

    const [first, second] = await Promise.all([
      processQueuedEngineRefreshRequests({ consumerName: "ConsumerA", getConnection, act }),
      processQueuedEngineRefreshRequests({ consumerName: "ConsumerB", getConnection, act }),
    ])

    expect(first + second).toBe(1)
    expect(act).toHaveBeenCalledTimes(1)
    expect(state.client.set).toHaveBeenCalledWith(
      `${ENGINE_REFRESH_CLAIM_PREFIX}${request.connectionId}`,
      expect.stringContaining('"state_switch_version":"7"'),
      expect.objectContaining({ NX: true, PX: expect.any(Number) }),
    )
    expect(state.settings.get(`engine_coordinator:refresh_requested:${request.connectionId}`)).toBeUndefined()
  })

  test("failed actions record failure, keep request queued, and release claim", async () => {
    const state = mockRedis()
    const { queueEngineRefreshRequest, processQueuedEngineRefreshRequests, ENGINE_REFRESH_CLAIM_PREFIX } = await import(
      "@/lib/engine-refresh-queue"
    )
    const request = {
      connectionId: "conn-fail",
      action: "refresh",
      state_switch_version: "3",
      reason: "test",
      timestamp: new Date().toISOString(),
    }
    await queueEngineRefreshRequest(request)

    await processQueuedEngineRefreshRequests({
      consumerName: "ConsumerA",
      getConnection: async () => ({ id: request.connectionId, state_switch_version: "3" }),
      act: async () => {
        throw new Error("boom")
      },
    })

    const queued = state.settings.get(`engine_coordinator:refresh_requested:${request.connectionId}`)
    expect(queued.retryCount).toBe(1)
    expect(queued.lastError).toBe("boom")
    expect(state.raw.has(`${ENGINE_REFRESH_CLAIM_PREFIX}${request.connectionId}`)).toBe(false)
  })

  test("an older consumer cannot clear a newer request that arrives during its action", async () => {
    const state = mockRedis()
    const { queueEngineRefreshRequest, clearEngineRefreshRequest } = await import("@/lib/engine-refresh-queue")
    const connectionId = "conn-owned-clear"
    await queueEngineRefreshRequest({
      connectionId,
      action: "refresh",
      state_switch_version: "4",
      reason: "old",
      timestamp: "2026-07-14T12:00:00.000Z",
    })
    const oldRequest = state.settings.get(`engine_coordinator:refresh_requested:${connectionId}`)
    state.settings.set(`engine_coordinator:refresh_requested:${connectionId}`, {
      requestId: "new-owned-request",
      connectionId,
      action: "stop",
      state_switch_version: "5",
      reason: "new",
      timestamp: "2026-07-14T12:00:01.000Z",
    })
    await clearEngineRefreshRequest(connectionId, oldRequest)

    expect(state.settings.get(`engine_coordinator:refresh_requested:${connectionId}`)).toMatchObject({
      action: "stop",
      state_switch_version: "5",
      reason: "new",
    })
  })
})
