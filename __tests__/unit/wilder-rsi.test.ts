import { latestWilderRsi, wilderRsiSeries } from "@/lib/wilder-rsi"
import { resampleTechnicalCandles, rsi } from "@/lib/technical-indicators"

/**
 * One RSI for the whole system: Wilder's seed and RMA smoothing, defined
 * edge cases, and "1m" computed on one-minute bars in live and replay alike.
 */
// Reference: Wilder's RSI(14) of the classic 15-close example (Wilder 1978 / StockCharts):
// closes 44.34 … 46.28 → first RSI ≈ 70.5; the next close 46.00 → ≈ 66.3 (RMA step; the published
// 70.53 / 66.32 round the averages to two decimals first).
const CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00]

describe("wilderRsiSeries", () => {
  test("seeds after `period` changes with the simple mean, then smooths with Wilder's RMA", () => {
    const series = wilderRsiSeries(CLOSES, 14)
    expect(series.slice(0, 14).every((value) => Number.isNaN(value))).toBe(true)
    expect(series[14]).toBeCloseTo(70.46, 1)
    expect(series[15]).toBeCloseTo(66.25, 1)
  })

  test("defined edge cases instead of divisions", () => {
    expect(latestWilderRsi([1, 1, 1, 1, 1], 3)).toBe(50)
    expect(latestWilderRsi([1, 2, 3, 4, 5], 3)).toBe(100)
    expect(latestWilderRsi([5, 4, 3, 2, 1], 3)).toBe(0)
    expect(latestWilderRsi([1, 2], 14)).toBe(50)
  })

  test("the engine's candle RSI is the same function (neutral 50 before the seed)", () => {
    const candles = CLOSES.map((close, index) => ({ timestamp: index, open: close, high: close, low: close, close, volume: 1 }))
    const engine = rsi(candles as any, 14)
    expect(engine[0]).toBe(50)
    expect(engine[15]).toBeCloseTo(wilderRsiSeries(CLOSES, 14)[15], 12)
  })
})

describe("one-minute timeframe", () => {
  const T0 = Date.parse("2026-10-07T00:00:00Z")
  test("one-second candles are aggregated into one-minute bars", () => {
    const seconds = Array.from({ length: 180 }, (_, i) => ({ timestamp: T0 + i * 1000, open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i, volume: 1 }))
    const bars = resampleTechnicalCandles(seconds, 1)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toMatchObject({ timestamp: T0, open: 100, close: 159, high: 159.5, low: 99.5, volume: 60 })
  })

  test("one-minute input stays one-minute", () => {
    const minutes = Array.from({ length: 5 }, (_, i) => ({ timestamp: T0 + i * 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }))
    expect(resampleTechnicalCandles(minutes, 1)).toHaveLength(5)
  })
})

describe("every RSI copy uses the canonical implementation", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  for (const file of ["lib/technical-indicators.ts", "lib/bots/backtest.ts", "lib/signal-indication.ts", "lib/direct-trade-coordination.ts", "lib/indicators.ts", "lib/indicators/calculator.ts", "lib/trade-engine/stages/indication-stage.ts"]) {
    test(file, () => expect(readFileSync(file, "utf8")).toMatch(/from "@\/lib\/wilder-rsi"/))
  }
})
