const mockRedis = {
  hgetall: jest.fn(async () => ({})),
  expire: jest.fn(async () => 1),
}
const mockConnection = {
  id: "bingx-x02",
  exchange: "bingx",
  environment: "prod-vst",
  base_url: "https://open-api-vst.bingx.com",
  is_testnet: true,
  is_live_trade: true,
  is_preset_trade: false,
  live_volume_factor: 1,
  average_count: 25,
  positionCost: 0.1,
  api_key: "x".repeat(24),
  api_secret: "secret",
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => mockRedis,
  getAppSettings: jest.fn(async () => ({ positions_average: 300 })),
  getSettings: jest.fn(async (key: string) => key.startsWith("connection_balance:")
    ? { balance: "9161", is_fallback: "0" }
    : null),
  setSettings: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => mockConnection),
}))

import { VolumeCalculator } from "@/lib/volume-calculator"

describe("X02 Prod-VST live minimum sizing", () => {
  beforeEach(() => jest.clearAllMocks())

  test("uses the connection average_count and permits one minimum within the account budget", async () => {
    const result = await VolumeCalculator.calculateVolumeForConnection(
      "bingx-x02",
      "BTCUSDT",
      100,
      { tradeMode: "main" },
    )

    expect(result.positionsAverage).toBe(25)
    expect(result.maxExecutionNotionalUsd).toBeGreaterThanOrEqual(5)
    expect(result.finalVolume).toBeGreaterThan(0)
    expect(result.volumeUsd).toBeGreaterThanOrEqual(5)
  })

  test("does not grant the minimum allowance to another or mainnet connection", () => {
    const ordinary = VolumeCalculator.calculatePositionVolume({
      accountBalance: 9161,
      currentPrice: 100,
      positionCostPercent: 0.1,
      positionsAverage: 25,
      leverage: 10,
      exchangeMinVolume: 0,
      tradeMode: "main",
    })

    expect(ordinary.maxExecutionNotionalUsd).toBeCloseTo(1.8322, 4)
    expect(ordinary.finalVolume).toBe(0)
  })
})
