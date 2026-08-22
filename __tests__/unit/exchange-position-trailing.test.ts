const settings = new Map<string, any>()
const mockSetSettings = jest.fn(async (key: string, value: any) => {
  settings.set(key, value)
})

const client = {
  get: jest.fn(async () => null),
  set: jest.fn(async () => "OK"),
  sadd: jest.fn(async () => 1),
  srem: jest.fn(async () => 1),
  smembers: jest.fn(async () => []),
  del: jest.fn(async () => 1),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => client),
  getSettings: jest.fn(async (key: string) => settings.get(key) ?? null),
  setSettings: mockSetSettings,
}))

jest.mock("@/lib/volume-calculator", () => ({
  VolumeCalculator: { calculateVolumeForConnection: jest.fn() },
}))

import { ExchangePositionManager } from "@/lib/exchange-position-manager"

describe("exchange-position trailing mirror", () => {
  beforeEach(() => {
    settings.clear()
    mockSetSettings.mockClear()
    client.get.mockClear()
    client.set.mockClear()
  })

  test("uses side as a backward-compatible short direction and persists a monotonic trigger", async () => {
    settings.set("exchange_position_by_eid:short-order", { id: "tracked-short" })
    settings.set("exchange_position:tracked-short", {
      id: "tracked-short",
      connection_id: "connection-1",
      exchange_id: "short-order",
      symbol: "BTCUSDT",
      // Legacy records did not contain `direction`; the durable `side` must
      // still drive short trailing activation and the low-water anchor.
      side: "short",
      entry_price: 100,
      current_price: 100,
      status: "open",
      trailing_enabled: true,
      trail_start: 0.5,
      trail_stop: 0.2,
      trail_activated: false,
      trail_high_price: null,
      unrealized_pnl: 0,
      max_profit: 0,
      max_loss: 0,
      max_drawdown: 0,
      price_high: 100,
      price_low: 100,
    })

    await new ExchangePositionManager("connection-1").updatePosition("short-order", {
      currentPrice: 99,
      unrealizedPnl: 1,
    })

    const updated = settings.get("exchange_position:tracked-short")
    expect(updated.direction).toBeUndefined()
    expect(updated.trail_activated).toBe(true)
    expect(updated.trail_high_price).toBe(99)
    expect(updated.trail_stop_price).toBeCloseTo(99.198, 12)

    await new ExchangePositionManager("connection-1").updatePosition("short-order", {
      currentPrice: 99.1,
      unrealizedPnl: 0.9,
    })
    // A short retrace cannot loosen the previously persisted stop upward.
    expect(settings.get("exchange_position:tracked-short").trail_stop_price).toBeCloseTo(99.198, 12)
  })
})
