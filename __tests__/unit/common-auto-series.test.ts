/**
 * The one-pass Auto summaries of a replay (StepBasedIndicators.createSummarySeries)
 * equal live Auto at every bar: the summaries of the anchored Common window
 * ending at that completed bar, with only completed higher-timeframe buckets.
 */
import { commonWarmupMinutes, commonWindowSlice } from "@/lib/common-indicators/history"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"
import type { TechnicalCandle } from "@/lib/common-indicators/types"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import { replayDirectIndicationTypes } from "@/lib/trade-engine/prehistoric-type-replay"

const MINUTE = 60_000
const ORIGINAL_HISTORY = process.env.COMMON_HISTORY_MINUTES

jest.setTimeout(300_000)

beforeAll(() => {
  // a 120-minute window (anchored windows of 120..179 bars) keeps the test fast
  process.env.COMMON_HISTORY_MINUTES = "120"
})
afterAll(() => {
  if (ORIGINAL_HISTORY === undefined) delete process.env.COMMON_HISTORY_MINUTES
  else process.env.COMMON_HISTORY_MINUTES = ORIGINAL_HISTORY
})

/** ten hours of minutes ending off the hour, with two gaps (one of two minutes) */
function minutesWithGaps(): TechnicalCandle[] {
  const bars = syntheticCandles("SER-USDT", 1, 600, Date.UTC(2026, 9, 4, 10, 37), 9)
  return bars.filter((_, index) => index !== 250 && index !== 251 && index !== 400)
}

describe("Auto summary series", () => {
  test("series.at(i) equals the summaries of the anchored window ending at bar i", async () => {
    expect(commonWarmupMinutes()).toBe(179)
    const bars = minutesWithGaps()
    const timeframes = [1, 5, 15, 30]
    const series = StepBasedIndicators.createSummarySeries(bars, timeframes)
    let compared = 0
    let directional = 0
    for (let index = 60; index < bars.length; index += 4) {
      const window = commonWindowSlice(bars, index)
      expect(window[window.length - 1]).toBe(bars[index])
      const expected = await StepBasedIndicators.calculateSummariesAsync(
        window,
        timeframes,
        undefined,
        undefined,
        32,
        { completedThroughMs: bars[index].timestamp + MINUTE },
      )
      const actual = await series.at(index)
      expect(actual).toEqual(expected)
      compared++
      directional += Object.values(actual).filter((step) => step.summary.direction !== "neutral").length
    }
    expect(compared).toBeGreaterThan(120)
    expect(directional).toBeGreaterThan(0)
  })

  test("a higher-timeframe bucket counts only once it is complete", async () => {
    const bars = minutesWithGaps().slice(0, 200)
    // bar 199 closes mid-way through a 15m bucket: the 15m context ends one bucket earlier
    const index = bars.findIndex((bar, i) => i > 150 && (bar.timestamp / MINUTE) % 15 === 7)
    const window = commonWindowSlice(bars, index)
    const withPartial = await StepBasedIndicators.calculateSummariesAsync(window, [15])
    const completedOnly = await StepBasedIndicators.calculateSummariesAsync(
      window, [15], undefined, undefined, 32, { completedThroughMs: bars[index].timestamp + MINUTE },
    )
    const cut = window.filter((bar) => bar.timestamp < Math.floor(bars[index].timestamp / (15 * MINUTE)) * 15 * MINUTE)
    expect(completedOnly).toEqual(await StepBasedIndicators.calculateSummariesAsync(
      cut, [15], undefined, undefined, 32, { completedThroughMs: cut[cut.length - 1].timestamp + MINUTE },
    ))
    expect(completedOnly).not.toEqual(withPartial)
  })

  test("a replay with the series equals the replay with one window evaluation per bar", async () => {
    // a wavy market so the Common coordination passes at many bars
    const bars = syntheticCandles("RPL-USDT", 1, 420, Date.UTC(2026, 9, 5, 7, 0), 3).map((bar, index) => {
      const wave = 1 + 0.012 * Math.sin(index / 23)
      return { ...bar, open: bar.open * wave, high: bar.high * wave, low: bar.low * wave, close: bar.close * wave }
    })
    const input = {
      symbol: "RPLUSDT",
      bars,
      rangeStartMs: bars[0].timestamp,
      rangeEndMs: bars[bars.length - 1].timestamp + MINUTE,
      positionCostPct: 0.1,
      indicationSettings: {},
      protectionFor: () => ({ takeProfitPct: 0.5, stopLossPct: 0.6 }),
    }
    const perBar = await replayDirectIndicationTypes({
      ...input,
      stepIndicatorsFor: (window, timeframes) => StepBasedIndicators.calculateSummariesAsync(
        window, timeframes, undefined, undefined, 32, { completedThroughMs: window[window.length - 1].timestamp + MINUTE },
      ),
    })
    const withSeries = await replayDirectIndicationTypes({
      ...input,
      stepIndicatorSeries: (replayBars, timeframes) => StepBasedIndicators.createSummarySeries(replayBars, timeframes),
    })
    expect(perBar.stepIndicatorCalls).toBeGreaterThan(0)
    expect(withSeries.stepIndicatorCalls).toBe(perBar.stepIndicatorCalls)
    expect(withSeries.steps).toBe(perBar.steps)
    expect(withSeries.signals).toEqual(perBar.signals)
    expect(withSeries.closes).toEqual(perBar.closes)
    expect(withSeries.open).toEqual(perBar.open)
  })
})
