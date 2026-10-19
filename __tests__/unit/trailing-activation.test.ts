/**
 * General multi-step trailing (audit TRAIL-01, TRAIL-04, TRAIL-07, TRAIL-08):
 * activation is a share of the take-profit distance, so trailing can arm
 * before the fixed take-profit closes the position. The simulator below is the
 * live rule and the historic family uses it.
 */
import {
  simulateGeneralTrailingExit,
  trailingActivationThreshold,
  trailingStartTpShare,
  takeProfitRatio,
  TRAILING_ACTIVATION_ABSOLUTE,
  TRAILING_ACTIVATION_TP_SHARE,
} from "@/lib/trailing-activation"
import { replayTrailing } from "@/lib/historic-test-family-replay"

const bar = (time: number, open: number, high: number, low: number, close = open) =>
  ({ time, open, high, low, close })

describe("activation share of the take-profit distance", () => {
  test("the five configured bands map to ascending shares below the take-profit", () => {
    expect([0.3, 0.6, 0.9, 1.2, 1.5].map(trailingStartTpShare)).toEqual([0.3, 0.5, 0.7, 0.85, 0.95])
  })

  test("any other start is kept strictly below the take-profit", () => {
    expect(trailingStartTpShare(0.45)).toBe(0.45)
    expect(trailingStartTpShare(3)).toBe(0.95)
    expect(trailingStartTpShare(0)).toBe(0)
  })

  test("threshold is the share of the TP distance under tp_share, the stored start otherwise", () => {
    expect(trailingActivationThreshold({ mode: TRAILING_ACTIVATION_TP_SHARE, startRatio: 0.6, takeProfitRatio: 0.01 }))
      .toBeCloseTo(0.005, 12)
    expect(trailingActivationThreshold({ mode: TRAILING_ACTIVATION_ABSOLUTE, startRatio: 0.6, takeProfitRatio: 0.01 }))
      .toBe(0.6)
    expect(trailingActivationThreshold({ mode: undefined, startRatio: 0.3, takeProfitRatio: 0.01 })).toBe(0.3)
  })

  test("a tp_share position without a usable take-profit falls back to the absolute start", () => {
    expect(trailingActivationThreshold({ mode: TRAILING_ACTIVATION_TP_SHARE, startRatio: 0.3, takeProfitRatio: 0 }))
      .toBe(0.3)
  })

  test("takeProfitRatio is the distance from entry as a fraction of entry", () => {
    expect(takeProfitRatio(100, 101)).toBeCloseTo(0.01, 12)
    expect(takeProfitRatio(100, 99)).toBeCloseTo(0.01, 12)
    expect(takeProfitRatio(0, 101)).toBe(0)
  })
})

describe("simulateGeneralTrailingExit follows the live rule", () => {
  const base = {
    entryPrice: 100,
    takeProfitPct: 1,
    stopLossPct: 2,
    startRatio: 0.6,
    stopRatio: 0.01,
  }

  test("a long arms before its take-profit and the take-profit then closes it (audit TRAIL-01)", () => {
    const exit = simulateGeneralTrailingExit({
      ...base,
      direction: "long",
      activationMode: TRAILING_ACTIVATION_TP_SHARE,
      bars: [
        bar(1, 100, 100.6, 100.2),   // gain 0.6 % ≥ 0.5 % (0.6 band = 50 % of the 1 % TP): arms
        bar(2, 100.6, 101.2, 100.5), // high 101.2 ≥ TP 101: take-profit first
      ],
    })
    expect(exit).toMatchObject({ index: 1, price: 101, reason: "take_profit", trailingArmed: true })
  })

  test("with the absolute rule the same path never arms and the take-profit closes it unarmed", () => {
    const exit = simulateGeneralTrailingExit({
      ...base,
      direction: "long",
      activationMode: TRAILING_ACTIVATION_ABSOLUTE,
      bars: [bar(1, 100, 100.6, 100.2), bar(2, 100.6, 101.2, 100.5)],
    })
    expect(exit).toMatchObject({ index: 1, price: 101, reason: "take_profit", trailingArmed: false })
  })

  test("the trailing stop only ratchets up for a long and exits at the stop level", () => {
    // TP 3 % (103), SL 2 % (98), share 0.3 of TP → arms at +0.9 % (100.9), trail 1 %, step 0.5 %.
    const exit = simulateGeneralTrailingExit({
      ...base,
      takeProfitPct: 3,
      startRatio: 0.3,
      direction: "long",
      activationMode: TRAILING_ACTIVATION_TP_SHARE,
      bars: [
        bar(1, 100, 101.0, 100.2),        // high 101.0 ≥ 100.9: arms, anchor 101.0, stop 99.99
        bar(2, 101, 101.4, 100.9),        // step needs 101.505: stop unchanged
        bar(3, 101.4, 102.0, 101.3),      // step reached: anchor 102.0, stop 100.98
        bar(4, 101.0, 101.1, 100.9),      // low 100.9 through the stop 100.98
      ],
    })
    expect(exit).not.toBeNull()
    expect(exit!.reason).toBe("trailing_stop")
    expect(exit!.price).toBeCloseTo(100.98, 6)
    expect(exit!.index).toBe(3)
  })

  test("a short mirrors the long: arms on a favourable low and exits on a stop above", () => {
    // TP 3 % (97), SL 2 % (102), share 0.3 → arms at −0.9 % (99.1), trail 1 %, step 0.5 %.
    const exit = simulateGeneralTrailingExit({
      ...base,
      takeProfitPct: 3,
      startRatio: 0.3,
      direction: "short",
      activationMode: TRAILING_ACTIVATION_TP_SHARE,
      bars: [
        bar(1, 100, 100.2, 99.0),         // low 99.0 ≤ 99.1: arms, anchor 99.0, stop 99.99
        bar(2, 99.0, 99.5, 98.9),         // step needs ≤ 98.505: stop unchanged
        bar(3, 98.9, 98.95, 98.4),        // step reached: anchor 98.4, stop 99.384
        bar(4, 98.6, 99.5, 98.5),         // high 99.5 through the stop 99.384
      ],
    })
    expect(exit).not.toBeNull()
    expect(exit!.reason).toBe("trailing_stop")
    expect(exit!.index).toBe(3)
    expect(exit!.price).toBeCloseTo(99.384, 6)
  })

  test("no exit inside the bars returns null", () => {
    const exit = simulateGeneralTrailingExit({
      ...base,
      direction: "long",
      activationMode: TRAILING_ACTIVATION_TP_SHARE,
      bars: [bar(1, 100, 100.2, 99.9), bar(2, 100, 100.3, 99.95)],
    })
    expect(exit).toBeNull()
  })
})

describe("replayTrailing (historic family) uses the same rule", () => {
  test("the walk starts after the entry bar, not on it (audit TRAIL-08)", () => {
    const candles = [
      { time: 1_000, open: 100, high: 105, low: 95, close: 100, volume: 1 }, // the entry bar prints 95 before the fill
      { time: 2_000, open: 100, high: 100.2, low: 99.9, close: 100, volume: 1 },
    ]
    const trade = { entryTime: 1_000, exitTime: 1_000, direction: "long", initialEntryPrice: 100, pnlPctOfInitialNotional: 0 } as any
    const out = replayTrailing(candles, [trade], {
      positionCostPercent: 0.1,
      stopLossPct: 2,
      takeProfitPct: 1,
      trailingRetracePct: 0.4,
      roundTripCostPercent: 0.26,
    })
    // The entry bar's low (95) would have hit the 2 % stop had the walk included it.
    // Walking only later bars: no exit, the trade closes at the last close (100) and pays the
    // 0.26 % round trip → −0.26 / 0.1 = −2.6 R.
    expect(out).toHaveLength(1)
    expect(out[0].signedResultR).toBeCloseTo(-2.6, 6)
  })
})
