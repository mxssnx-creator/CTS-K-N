/**
 * Audit F1 (operator decision 2026-10-19): the `rsi` type is a reversion rule.
 * Its direction is long only at or below oversold, short only at or above
 * overbought, and neutral between the thresholds. The former middle-zone vote
 * was momentum (value versus the midpoint), which conflicted with the reversion
 * category and flipped direction at the thresholds themselves.
 */
import { evaluateTechnicalIndicators } from "@/lib/technical-indicators"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"

const END = Date.UTC(2026, 9, 19, 0, 0, 0)

describe("rsi (reversion): the middle zone is neutral", () => {
  const candles = syntheticCandles("RSI-USDT", 1, 400, END, 9)
  const settings = { rsi: { period: 14, oversold: 30, overbought: 70 } }

  test("the sample reports a direction only outside the thresholds", () => {
    const result = evaluateTechnicalIndicators(candles, 14, ["rsi"], settings).rsi
    expect(result).toBeDefined()
    const { value, direction, details } = result!
    if (value <= details.oversold) expect(direction).toBe("long")
    else if (value >= details.overbought) expect(direction).toBe("short")
    else expect(direction).toBe("neutral")
  })

  test("the direction does not flip at the thresholds (no momentum vote in between)", () => {
    // Two evaluations whose RSI values straddle the oversold threshold must not
    // flip from long to short: below the threshold is long, just above is neutral.
    const samples: Array<{ value: number; direction: string }> = []
    for (let shift = 0; shift < candles.length && samples.length < 200; shift += 1) {
      const slice = candles.slice(0, candles.length - shift)
      const result = evaluateTechnicalIndicators(slice, 14, ["rsi"], settings).rsi
      if (result) samples.push({ value: result.value, direction: result.direction })
    }
    for (const sample of samples) {
      if (sample.value > 30 && sample.value < 70) expect(sample.direction).toBe("neutral")
    }
    expect(samples.some((sample) => sample.direction !== "neutral")).toBe(true)
  })
})
