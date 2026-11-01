/**
 * Regression tests for the round 5 audit (confirmed findings F-01, TRAIL-05 /
 * COST-01, TRAIL-02 seed). Each test pins the corrected behaviour.
 */
import { baseMeasuredHistoryRejection, effectiveHistoryMinCount } from "@/lib/pos-history"
import { replayTrailing } from "@/lib/historic-test-family-replay"

describe("F-01: the measured-history minimum cannot exceed its window", () => {
  test("a minimum above the window is capped at the window", () => {
    expect(effectiveHistoryMinCount(30, 25)).toBe(25)
    expect(effectiveHistoryMinCount(5, 25)).toBe(5)
    expect(effectiveHistoryMinCount(5)).toBe(5)
  })

  test("a full window passes when the minimum exceeds it (previously rejected forever)", () => {
    const fullWindow = { positionCostRatioCount: 25 }
    expect(baseMeasuredHistoryRejection(fullWindow, 30, 25)).toBeNull()
    expect(baseMeasuredHistoryRejection({ positionCostRatioCount: 24 }, 30, 25)).toBe(
      "base_awaiting_measured_history: 24 < 25",
    )
  })

  test("without a window the minimum is unchanged", () => {
    expect(baseMeasuredHistoryRejection({ positionCostRatioCount: 4 }, 5)).toBe(
      "base_awaiting_measured_history: 4 < 5",
    )
  })
})

describe("TRAIL-05 / COST-01: historic trailing exits pay the real round trip", () => {
  // Long from 100: the high of the first bar sets best = 101, the trailing stop is
  // best × (1 − 0.4 %) = 100.596, and the second bar's low (100.5) triggers it.
  const candles = [
    { time: 1_000, open: 100, high: 101, low: 99.9, close: 100.8, volume: 1 },
    { time: 2_000, open: 100.8, high: 100.8, low: 100.5, close: 100.6, volume: 1 },
  ]
  const trade = { entryTime: 0, exitTime: 0, exitPrice: 0, initialEntryPrice: 100 } as any

  test("the net result deducts the round trip, not PositionCost alone", () => {
    const withRoundTrip = replayTrailing(candles, [trade], {
      positionCostPercent: 0.1,
      trailingRetracePct: 0.4,
      stopLossPct: 2.5,
      roundTripCostPercent: 0.26,
    })
    const withPositionCostOnly = replayTrailing(candles, [trade], {
      positionCostPercent: 0.1,
      trailingRetracePct: 0.4,
      stopLossPct: 2.5,
    })
    expect(withRoundTrip).toHaveLength(1)
    expect(withPositionCostOnly).toHaveLength(1)
    // 0.16 percentage points of extra cost, in PositionCost units (0.10 %).
    const difference = withPositionCostOnly[0].signedResultR - withRoundTrip[0].signedResultR
    expect(difference).toBeCloseTo(1.6, 6)
  })
})
