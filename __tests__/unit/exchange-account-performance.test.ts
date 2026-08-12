import {
  EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS,
  calculateExchangeAccountPerformance15h,
  exchangeAccountHistoryKeys,
  recordAndCalculateExchangeAccountPerformance15h,
} from "@/lib/exchange-account-performance"

const NOW = Date.parse("2026-08-11T12:00:00.000Z")

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  timestamp: NOW,
  balance: 140,
  equity: 150,
  currency: "USDT",
  connectionIds: ["conn-b", "conn-a"],
  ...overrides,
})

describe("Exchange account 15-hour performance", () => {
  test("calculates the requested ratio as current equity divided by the 15h balance", () => {
    const baseline = snapshot({
      timestamp: NOW - EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS,
      balance: 100,
      equity: 100,
    })

    expect(calculateExchangeAccountPerformance15h(snapshot(), [baseline])).toMatchObject({
      available: true,
      balance: 140,
      equity: 150,
      pnlRatio: 1.5,
      pnlPercent: 50,
      equityChange: 50,
      baselineBalance: 100,
      baselineDistanceMin: 0,
      reason: "ready",
    })
  })

  test("selects the nearest valid sample and refuses currency mismatches", () => {
    const target = NOW - EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS
    const far = snapshot({ timestamp: target - 10 * 60_000, balance: 80 })
    const near = snapshot({ timestamp: target + 2 * 60_000, balance: 100 })
    const result = calculateExchangeAccountPerformance15h(snapshot(), [far, near])
    expect(result).toMatchObject({ available: true, baselineBalance: 100, baselineDistanceMin: 2 })

    expect(calculateExchangeAccountPerformance15h(snapshot(), [
      snapshot({ timestamp: target, currency: "USDC", balance: 100 }),
    ])).toMatchObject({ available: false, reason: "currency-mismatch", pnlRatio: null })
  })

  test("shows current verified money while history is collecting and never fabricates ratio 1", () => {
    expect(calculateExchangeAccountPerformance15h(snapshot(), [])).toMatchObject({
      available: false,
      balance: 140,
      equity: 150,
      pnlRatio: null,
      reason: "history-collecting",
    })
    expect(calculateExchangeAccountPerformance15h(null, [])).toMatchObject({
      available: false,
      balance: null,
      equity: null,
      pnlRatio: null,
      reason: "current-unavailable",
    })
  })

  test("records a minute-bucket snapshot, prunes retention, and reads the baseline", async () => {
    const target = NOW - EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS
    const baseline = snapshot({ timestamp: target, balance: 100, equity: 100 })
    const client = {
      hset: jest.fn().mockResolvedValue(1),
      hget: jest.fn().mockResolvedValue(JSON.stringify(baseline)),
      hdel: jest.fn().mockResolvedValue(0),
      zadd: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([String(target)]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      persist: jest.fn().mockResolvedValue(1),
    }

    const result = await recordAndCalculateExchangeAccountPerformance15h(client, snapshot())
    const keys = exchangeAccountHistoryKeys(["conn-a", "conn-b"])

    expect(result).toMatchObject({ available: true, pnlRatio: 1.5 })
    expect(client.hset).toHaveBeenCalledWith(
      keys.data,
      String(Math.floor(NOW / 60_000) * 60_000),
      expect.any(String),
    )
    expect(client.zadd).toHaveBeenCalledWith(
      keys.time,
      NOW,
      String(Math.floor(NOW / 60_000) * 60_000),
    )
    expect(client.zremrangebyscore).toHaveBeenCalledWith(keys.time, "-inf", expect.any(Number))
  })
})
