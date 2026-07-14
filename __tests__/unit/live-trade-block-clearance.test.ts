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

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async (id: string) => store.get(id) || null),
  updateConnection: (...args: any[]) => updateConnection(...args),
  persistNow: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    hset: jest.fn(async () => undefined),
    set: jest.fn(async () => undefined),
  })),
}))

jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: jest.fn(() => ({
    isEngineRunning: jest.fn(() => true),
    startEngine: jest.fn(async () => undefined),
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
}))

jest.mock("@/lib/engine-refresh-queue", () => ({
  nextStateSwitchVersion: jest.fn(() => "test-switch-version"),
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

  beforeEach(() => {
    jest.clearAllMocks()
    store.clear()
    store.set(mockConnection.id, { ...mockConnection })
    process.env.REDIS_URL = "redis://test-shared-redis"
  })

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL
    } else {
      process.env.REDIS_URL = originalRedisUrl
    }
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
})
