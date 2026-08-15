import { runDcaBacktest, type DcaBacktestCandle } from "@/lib/dca-backtest"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"

function candles(prices: number[], intervalMinutes = 5): DcaBacktestCandle[] {
  return prices.map((close, index) => ({
    time: index * intervalMinutes * 60_000,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100 + index,
  }))
}

describe("DCA seven-day optimizer core", () => {
  test("never lets any simulated position exceed the configured 5x ratio", () => {
    const prices = [
      ...Array.from({ length: 35 }, (_, index) => 100 + index * 0.05),
      99.5, 99, 98.5, 98, 97.5, 98.5, 99.5, 100.5, 101,
      ...Array.from({ length: 40 }, (_, index) => 101 + index * 0.03),
    ]
    const result = runDcaBacktest(candles(prices), {
      profile: DEFAULT_DCA_PROFILE,
      timeframeMinutes: 5,
      entry: "momentum",
      takeProfitPct: 0.4,
      stopLossPct: 3,
      maxHoldMinutes: 12 * 60,
      roundTripCostPct: 0.1,
      slippagePct: 0.02,
    })

    expect(result.maxPositionVolumeRatio).toBeLessThanOrEqual(5)
    expect(result.trades.every((trade) => trade.volumeRatio <= 5)).toBe(true)
  })

  test("uses PF from aggregate positive and negative net outcomes and reports drawdown", () => {
    const prices = Array.from({ length: 180 }, (_, index) => {
      const cycle = index % 30
      return 100 + Math.sin(cycle / 4) * 1.2 + index * 0.002
    })
    const result = runDcaBacktest(candles(prices), {
      profile: DEFAULT_DCA_PROFILE,
      timeframeMinutes: 5,
      entry: "mean_reversion",
      takeProfitPct: 0.4,
      stopLossPct: 2.6,
    })

    expect(result.closedTrades).toBe(result.trades.length)
    expect(result.grossProfitPct).toBeGreaterThanOrEqual(0)
    expect(result.grossLossPct).toBeGreaterThanOrEqual(0)
    expect(result.maxEquityDrawdownPct).toBeGreaterThanOrEqual(0)
    expect(result.trades.every((trade) => trade.holdTimeMin >= 0)).toBe(true)
    if (result.grossLossPct > 0) {
      expect(result.profitFactor).toBeCloseTo(result.grossProfitPct / result.grossLossPct)
    }
  })
})
