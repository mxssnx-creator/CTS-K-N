const mockRedis = {
  hgetall: jest.fn(async (_key: string): Promise<Record<string, unknown>> => ({})),
  expire: jest.fn(async () => 1),
}
const mockConnection = {
  id: "bingx-x02",
  exchange: "bingx",
  environment: "prod-vst",
  base_url: "https://open-api-vst.bingx.com",
  is_testnet: true,
  is_live_trade: true,
  live_volume_factor: 10,
  average_count: 1,
  positionCost: 0.1,
  api_key: "x".repeat(24),
  api_secret: "secret",
}
const mockAppSettings: Record<string, unknown> = {}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => mockRedis,
  getAppSettings: jest.fn(async () => mockAppSettings),
  getSettings: jest.fn(async (key: string) => key.startsWith("connection_balance:")
    ? { balance: "100000", is_fallback: "0" }
    : null),
  setSettings: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => mockConnection),
}))

import { minimumVolumeEnforced, VolumeCalculator } from "@/lib/volume-calculator"

/**
 * "Enforce min vol quantity and adjust to min min": with Minimum Volume
 * Enforcement on (the default) every live order is sized at the venue's
 * smallest executable quantity; Block/DCA legs keep their ratio to it.
 */
const ETH_RULES = { quantityStep: "0.01", quantityPrecision: "2", minQuantity: "0.05", minNotionalUsdt: "5" }

describe("minimum volume enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of Object.keys(mockAppSettings)) delete mockAppSettings[key]
    mockRedis.hgetall.mockImplementation(async (key: string) => key.startsWith("settings:trading_pair:") ? { ...ETH_RULES } : {})
  })

  test("the setting is on unless explicitly switched off", () => {
    expect(minimumVolumeEnforced({})).toBe(true)
    expect(minimumVolumeEnforced({ min_volume_enforcement: true })).toBe(true)
    expect(minimumVolumeEnforced({ min_volume_enforcement: "true" })).toBe(true)
    expect(minimumVolumeEnforced({ min_volume_enforcement: false })).toBe(false)
    expect(minimumVolumeEnforced({ min_volume_enforcement: "false" })).toBe(false)
  })

  test("a live order is sized at the venue minimum read from the stored contract (camelCase minQuantity)", async () => {
    const result = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, { tradeMode: "main" })
    // 0.05 ETH (= 100 USD) is the venue minimum quantity; PositionCost sizing alone would be far larger.
    expect(result.finalVolume).toBe(0.05)
    expect(result.exchangeMinQuantity).toBe(0.05)
    expect(result.adjustmentReason).toContain("minimum volume enforcement")
  })

  test("a minimum the venue enforced in a 101400 rejection outranks the contract", async () => {
    mockRedis.hgetall.mockImplementation(async (key: string) => key.startsWith("settings:trading_pair:")
      ? { ...ETH_RULES, minQuantityObserved: "0.08" } : {})
    const result = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, { tradeMode: "main" })
    expect(result.finalVolume).toBe(0.08)
  })

  test("a minimum notional above the minimum quantity sets the smallest order", async () => {
    mockRedis.hgetall.mockImplementation(async (key: string) => key.startsWith("settings:trading_pair:")
      ? { quantityStep: "1", quantityPrecision: "0", minQuantity: "1", minNotionalUsdt: "5" } : {})
    // 1 DOGE at 0.2 USD is 0.2 USD; the 5 USD minimum notional needs 25 DOGE.
    const result = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "DOGEUSDT", 0.2, { tradeMode: "main" })
    expect(result.finalVolume).toBe(25)
  })

  test("Block/DCA legs keep their ratio to the minimum", async () => {
    const leg = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, { tradeMode: "main", sizeMultiplier: 2 })
    expect(leg.finalVolume).toBe(0.1)
    const smallLeg = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, { tradeMode: "main", sizeMultiplier: 0.5 })
    // Never below the venue minimum.
    expect(smallLeg.finalVolume).toBe(0.05)
  })

  test("switched off, PositionCost sizing applies as before", async () => {
    mockAppSettings.min_volume_enforcement = false
    const result = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, { tradeMode: "main" })
    // 100,000 x 0.1 % x 10 (volume factor) x 0.2 (system factor) = 200 USD = 0.1 ETH.
    expect(result.finalVolume).toBe(0.1)
  })

  test("strategy (pseudo) sizing without a trade mode is not affected", async () => {
    const result = await VolumeCalculator.calculateVolumeForConnection("bingx-x02", "ETHUSDT", 2000, {})
    expect(result.adjustmentReason ?? "").not.toContain("minimum volume enforcement")
  })
})

describe("a 101400 minimum is kept where it is read", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8") as string

  test("the correction writes the trading-pair hash, not a prefixed settings key", () => {
    expect(source).toContain("await rememberVenueMinimumQuantity(realPosition.symbol, connectionId, minQty)")
    expect(source).not.toContain("setSettings(tradingPairKey(")
    expect(source).toContain("minQuantityObserved: String(minQuantity)")
  })

  test("the live instrument rules and the contract refresh honour the observed minimum", () => {
    expect(source).toContain("const observedMinimum = firstFinitePositive(source.minQuantityObserved)")
    expect(source).toContain("minQuantity: Math.max(fetched.minQuantity, firstFinitePositive(stored.minQuantityObserved) || 0)")
  })
})
