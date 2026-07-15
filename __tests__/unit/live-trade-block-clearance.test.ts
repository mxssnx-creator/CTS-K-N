import { hasRealTradeBlock } from "@/lib/real-trade-gates"

const mockConnection = {
  id: "conn-live-blocked",
  name: "Blocked BingX",
  exchange: "bingx",
  api_key: "12345678901",
  api_secret: "abcdefghijklmnopqrstuvwxyz",
  is_live_trade: "0",
  live_trade_blocked_reason: "Connection test failed",
}
const store = new Map<string, any>()
const updateConnection = jest.fn(async (id: string, updates: any) => {
  const next = { ...(store.get(id) || {}), ...updates }
  store.set(id, next)
  return next
})
const logProgressionEvent = jest.fn(async () => undefined)
const syncWithExchange = jest.fn(async () => ({ reconciled: 0, updated: 0, closed: 0, errors: 0 }))
const coordinatorIsEngineRunning = jest.fn(() => true)
const coordinatorStartEngine = jest.fn(async () => true)

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async (id: string) => store.get(id) || null),
  updateConnection: (...args: any[]) => updateConnection(...args),
  updateConnectionState: async (id: string, updates: any) => ({
    applied: true,
    connection: await updateConnection(id, updates),
  }),
  persistNow: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    hset: jest.fn(async () => undefined),
    set: jest.fn(async () => undefined),
  })),
}))

jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: jest.fn(() => ({
    isEngineRunning: (...args: any[]) => coordinatorIsEngineRunning(...args),
    startEngine: (...args: any[]) => coordinatorStartEngine(...args),
  })),
}))

// Enabling live trade schedules a fire-and-forget control-order rebuild. Keep
// this unit test hermetic: it must never construct a real BingX connector.
jest.mock("@/lib/exchange-connectors", () => ({
  createExchangeConnector: jest.fn(async () => ({ kind: "mock-exchange" })),
}))

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  syncWithExchange: (...args: any[]) => syncWithExchange(...args),
}))

jest.mock("@/lib/progression-state-manager", () => ({
  ProgressionStateManager: {
    recoordinateForActualOne: jest.fn(async () => ({ changed: false })),
  },
}))

jest.mock("@/lib/settings-coordinator", () => ({
  notifySettingsChanged: jest.fn(async () => undefined),
  detectChangedFields: jest.fn((before: Record<string, any>, after: Record<string, any>) =>
    Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).filter(
      (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
    ),
  ),
}))

jest.mock("@/lib/engine-refresh-queue", () => ({
  allocateStateSwitchVersion: jest.fn(async () => "test-switch-version"),
  queueEngineRefreshRequest: jest.fn(async () => undefined),
}))

jest.mock("@/lib/production-readiness", () => ({
  checkProductionReadiness: jest.fn(async () => ({ ready: true, checks: [] })),
  productionReadinessJson: jest.fn((value: unknown) => value),
}))

jest.mock("@/lib/settings-storage", () => ({
  loadSettingsAsync: jest.fn(async () => ({})),
}))

jest.mock("@/lib/system-logger", () => ({
  SystemLogger: {
    logConnection: jest.fn(async () => undefined),
    logError: jest.fn(async () => undefined),
  },
}))

jest.mock("@/lib/engine-progression-logs", () => ({
  logProgressionEvent: (...args: any[]) => logProgressionEvent(...args),
}))

describe("live-trade block clearance", () => {
  const originalRedisUrl = process.env.REDIS_URL
  const originalDisableInProcess = process.env.DISABLE_TRADE_ENGINE_IN_PROCESS
  const originalNextRuntime = process.env.NEXT_RUNTIME
  const originalVercel = process.env.VERCEL

  beforeEach(() => {
    jest.clearAllMocks()
    store.clear()
    store.set(mockConnection.id, { ...mockConnection })
    process.env.REDIS_URL = "redis://test-shared-redis"
    delete process.env.DISABLE_TRADE_ENGINE_IN_PROCESS
    delete process.env.NEXT_RUNTIME
    delete process.env.VERCEL
    coordinatorIsEngineRunning.mockReturnValue(true)
    coordinatorStartEngine.mockResolvedValue(true)
  })

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL
    } else {
      process.env.REDIS_URL = originalRedisUrl
    }
    if (originalDisableInProcess === undefined) delete process.env.DISABLE_TRADE_ENGINE_IN_PROCESS
    else process.env.DISABLE_TRADE_ENGINE_IN_PROCESS = originalDisableInProcess
    if (originalNextRuntime === undefined) delete process.env.NEXT_RUNTIME
    else process.env.NEXT_RUNTIME = originalNextRuntime
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
  })

  test("clears stale live_trade_blocked_reason when enabling live trade after credential confirmation", async () => {
    const { POST } = await import("@/app/api/settings/connections/[id]/live-trade/route")
    const request = new Request("http://localhost/api/settings/connections/conn-live-blocked/live-trade", {
      method: "POST",
      body: JSON.stringify({ is_live_trade: true }),
      headers: { "content-type": "application/json" },
    })

    const response = await POST(request as any, { params: Promise.resolve({ id: mockConnection.id }) })
    expect(response.status).toBe(200)

    const updated = store.get(mockConnection.id)
    expect(updated.is_live_trade).toBe("1")
    expect(updated.live_trade_blocked_reason).toBe("")
    expect(updated.live_trade_requested).toBe("1")
    expect(updated.last_test_status).toBe("success")
    expect(hasRealTradeBlock(updated)).toBe(false)
    expect(logProgressionEvent).toHaveBeenCalledWith(
      mockConnection.id,
      "live_trading",
      "info",
      expect.stringContaining("cleared stale block"),
      expect.objectContaining({ previous_block_reason: "Connection test failed", is_live_trade: true }),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(syncWithExchange).toHaveBeenCalledWith(mockConnection.id, expect.objectContaining({ kind: "mock-exchange" }))
  })

  test("keeps requested intent but reports blocked instead of silently enabling simulation without shared Redis", async () => {
    delete process.env.REDIS_URL
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    const { POST } = await import("@/app/api/settings/connections/[id]/live-trade/route")
    const request = new Request("http://localhost/api/settings/connections/conn-live-blocked/live-trade", {
      method: "POST",
      body: JSON.stringify({ is_live_trade: true }),
      headers: { "content-type": "application/json" },
    })

    const response = await POST(request as any, { params: Promise.resolve({ id: mockConnection.id }) })
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body).toMatchObject({
      success: true,
      is_live_trade: false,
      live_trade_requested: true,
      live_trade_block_code: "shared_redis_required",
      live_execution_mode: "blocked",
    })
    expect(body.live_trade_blocked_reason).toContain("shared Redis is not configured")
    expect(store.get(mockConnection.id)).toMatchObject({
      is_live_trade: "0",
      live_trade_requested: "1",
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(syncWithExchange).not.toHaveBeenCalled()
  })

  test("starts the stopped Main Trade Engine scope when Live is enabled", async () => {
    coordinatorIsEngineRunning.mockReturnValue(false)
    const { POST } = await import("@/app/api/settings/connections/[id]/live-trade/route")
    const request = new Request("http://localhost/api/settings/connections/conn-live-blocked/live-trade", {
      method: "POST",
      body: JSON.stringify({ is_live_trade: true }),
      headers: { "content-type": "application/json" },
    })

    const response = await POST(request as any, { params: Promise.resolve({ id: mockConnection.id }) })
    expect(response.status).toBe(200)
    expect(coordinatorStartEngine).toHaveBeenCalledWith(
      mockConnection.id,
      expect.objectContaining({
        connectionId: mockConnection.id,
        engine_type: "main",
        allowInProcessStart: true,
      }),
      expect.objectContaining({ markAssigned: true, forceLocalTakeover: true }),
    )
    const body = await response.json()
    expect(body).toMatchObject({
      is_live_trade: true,
      live_execution_mode: "live",
      engineStatus: "running",
      engineStartedNow: true,
    })
  })

  test("keeps Preset Trade requested while infrastructure is blocked", async () => {
    delete process.env.REDIS_URL
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    const { POST } = await import("@/app/api/settings/connections/[id]/preset-toggle/route")
    const request = new Request("http://localhost/api/settings/connections/conn-live-blocked/preset-toggle", {
      method: "POST",
      body: JSON.stringify({ is_preset_trade: true }),
      headers: { "content-type": "application/json" },
    })

    const response = await POST(request as any, { params: Promise.resolve({ id: mockConnection.id }) })
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body).toMatchObject({
      success: true,
      is_preset_trade: false,
      preset_trade_requested: true,
      preset_trade_block_code: "shared_redis_required",
      preset_execution_mode: "blocked",
    })
    expect(store.get(mockConnection.id)).toMatchObject({
      is_preset_trade: "0",
      preset_trade_requested: "1",
    })
    expect(coordinatorStartEngine).not.toHaveBeenCalled()
  })

  test("enables Preset mode and starts the shared Main engine when canonical readiness passes", async () => {
    coordinatorIsEngineRunning.mockReturnValue(false)
    const { POST } = await import("@/app/api/settings/connections/[id]/preset-toggle/route")
    const request = new Request("http://localhost/api/settings/connections/conn-live-blocked/preset-toggle", {
      method: "POST",
      body: JSON.stringify({ is_preset_trade: true }),
      headers: { "content-type": "application/json" },
    })

    const response = await POST(request as any, { params: Promise.resolve({ id: mockConnection.id }) })
    expect(response.status).toBe(200)
    expect(coordinatorStartEngine).toHaveBeenCalledWith(
      mockConnection.id,
      expect.objectContaining({
        connectionId: mockConnection.id,
        engine_type: "main",
        allowInProcessStart: true,
      }),
      expect.objectContaining({ markAssigned: true, forceLocalTakeover: true }),
    )
    expect(await response.json()).toMatchObject({
      success: true,
      is_preset_trade: true,
      preset_trade_requested: true,
      preset_execution_mode: "live",
      engineStartedNow: true,
    })
  })
})
