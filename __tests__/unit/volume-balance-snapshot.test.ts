const mockGetBalance = jest.fn()
const mockSetSettings = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(), getSettings: jest.fn(async () => null), getAppSettings: jest.fn(),
  getConnection: jest.fn(async () => ({ id: "fixture", exchange: "bingx", api_key: "x".repeat(24), api_secret: "fixture" })),
  setSettings: (...args: unknown[]) => mockSetSettings(...args),
  getRedisClient: () => ({ expire: jest.fn(async () => 1) }),
}))
jest.mock("@/lib/exchange-connectors", () => ({
  createExchangeConnector: jest.fn(async () => ({ getBalance: mockGetBalance })),
}))

import { VolumeCalculator } from "@/lib/volume-calculator"

beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); mockSetSettings.mockResolvedValue(undefined) })
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test("caches the same account-wide wallet, equity and free-margin snapshot", async () => {
  mockGetBalance.mockResolvedValue({ success: true, balance: 100, equity: -5, availableMargin: 0, unrealizedProfit: -105, settlementAsset: "USDT" })
  await expect(VolumeCalculator.resolveBalanceAndLeverage("fixture", 10)).resolves.toMatchObject({ accountBalance: 100, balanceIsFallback: false })
  expect(mockSetSettings).toHaveBeenCalledWith("connection_balance:fixture", expect.objectContaining({
    balance: 100, equity: -5, availableMargin: 0, unrealizedProfit: -105, currency: "USDT", timestamp: expect.any(Number), is_fallback: false,
  }))
})

test("clears missing optional account fields instead of preserving stale values in the hash", async () => {
  mockGetBalance.mockResolvedValue({ success: true, balance: 100 })
  await VolumeCalculator.resolveBalanceAndLeverage("fixture", 10)
  expect(mockSetSettings).toHaveBeenCalledWith("connection_balance:fixture", expect.objectContaining({ equity: "", availableMargin: "", unrealizedProfit: "" }))
})
