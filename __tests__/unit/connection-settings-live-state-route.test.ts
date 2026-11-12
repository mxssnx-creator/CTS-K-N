const mockConnection = jest.fn()
const mockHash = jest.fn()
const mockWrite = jest.fn()
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn().mockResolvedValue(undefined),
  getConnection: (...args: unknown[]) => mockConnection(...args),
  getRedisClient: () => ({ hgetall: mockHash, hset: mockWrite }),
  getSettings: jest.fn().mockResolvedValue({}),
  getAppSettings: jest.fn().mockResolvedValue({}),
}))
jest.mock("@/lib/system-logger", () => ({ SystemLogger: { logError: jest.fn() } }))
jest.mock("@/lib/redis-operations", () => ({
  RedisTrades: { getTradesByConnection: jest.fn().mockResolvedValue([]) },
  RedisPositions: { getPositionsByConnection: jest.fn().mockResolvedValue([]) },
}))
jest.mock("@/lib/connection-recoordinator", () => ({ applyMainConnectionSettingsChange: jest.fn() }))
jest.mock("@/lib/trade-engine", () => ({ getTradeEngine: jest.fn() }))
jest.mock("@/lib/top-symbols", () => ({ fetchTopSymbols: jest.fn(), normaliseSort: (v: string) => v }))
const { GET } = require("@/app/api/settings/connections/[id]/settings/route")

describe("connection settings canonical Live state", () => {
  beforeEach(() => jest.clearAllMocks())

  test.each([
    [{}, 2, 3],
    [{ minStep: 5, trailingMinStep: 8 }, 5, 8],
    [{ coordination_settings: { minStep: 7, trailingMinStep: 11 } }, 7, 11],
    [{ minStep: 8, trailingMinStep: 3 }, 8, 8],
  ])("GET preserves the stored minimum pair and Block ratio: %p", async (saved, minStep, trailingMinStep) => {
    mockConnection.mockResolvedValue({
      id: "bingx-x02", exchange: "bingx", is_live_trade: "0",
      connection_settings: { ...saved, blockVolumeRatio: 0.2 },
    })
    mockHash.mockResolvedValue({})
    const response = await GET(new Request("http://localhost/api/settings/connections/bingx-x02/settings"), {
      params: Promise.resolve({ id: "bingx-x02" }),
    })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.settings).toMatchObject({ minStep, trailingMinStep })
    expect(body.settings.coordination_settings).toMatchObject({ minStep, trailingMinStep, blockVolumeRatio: 0.2 })
    expect(mockWrite).not.toHaveBeenCalled()
  })

  test.each([
    ["1", "0", "1", true, true],
    ["0", "1", "0", false, false],
    ["0", "1", "1", false, true],
  ])("connection switch %s wins over stale settings %s (requested %s)", async (current, stale, requested, enabled, requestEnabled) => {
    mockConnection.mockResolvedValue({
      id: "bingx-x02", exchange: "bingx", is_live_trade: current,
      // An obsolete alias must not override an explicit canonical OFF.
      live_trade_enabled: "1", live_trade_requested: requested,
      connection_settings: { is_live_trade: stale, live_trade_enabled: stale },
    })
    mockHash.mockResolvedValue({ is_live_trade: stale, live_trade_enabled: stale, live_trade_requested: stale })
    const response = await GET(new Request("http://localhost/api/settings/connections/bingx-x02/settings"), {
      params: Promise.resolve({ id: "bingx-x02" }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.settings).toMatchObject({
      is_live_trade: enabled, live_trade_enabled: enabled, live_trade_requested: requestEnabled,
    })
    expect(mockWrite).not.toHaveBeenCalled()
  })
})
