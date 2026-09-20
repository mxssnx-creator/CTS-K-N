import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_SLIPPAGE_FRACTION,
  DEFAULT_TAKER_FEE_FRACTION,
  roundTripCostFraction,
  roundTripCostPercent,
} from "@/lib/trading-round-trip-cost"

describe("simulated and live trades are charged the same cost", () => {
  test("both sides are charged, plus slippage", () => {
    expect(roundTripCostFraction()).toBeCloseTo(DEFAULT_TAKER_FEE_FRACTION * 2 + DEFAULT_SLIPPAGE_FRACTION, 12)
    expect(roundTripCostPercent()).toBeCloseTo(0.26, 10)
  })

  test("the replay no longer borrows PositionCost as a cost", () => {
    const replay = readFileSync(resolve(process.cwd(), "lib/historic-test-replay.ts"), "utf8")
    expect(replay).toContain("roundTripCostPct: roundTripCostPercent({")
    expect(replay).not.toContain("roundTripCostPct: positionCostPercent")
  })

  test("the live outcome model uses the same function", () => {
    const processor = readFileSync(resolve(process.cwd(), "lib/indication-sets-processor.ts"), "utf8")
    expect(processor).toContain("const cost = roundTripCostFraction({")
    expect(processor).not.toContain("const cost = this.outcomeTakerFeePct * 2 + this.outcomeSlippagePct")
  })

  test("the gap this closed is recorded, so the constant is not 'simplified' back", () => {
    const module = readFileSync(resolve(process.cwd(), "lib/trading-round-trip-cost.ts"), "utf8")
    expect(module).toContain("0.16 percentage points")
    expect(module).toContain("PositionCost is a SIZING setting")
  })

  test("operator overrides are honoured; negative or unusable values fall back", () => {
    expect(roundTripCostPercent({ takerFeeFraction: 0.0002, slippageFraction: 0 })).toBeCloseTo(0.04, 10)
    for (const bad of [-1, Number.NaN, undefined]) {
      expect(roundTripCostFraction({ takerFeeFraction: bad as any })).toBeCloseTo(roundTripCostFraction(), 12)
    }
    // Zero is a legitimate setting (a maker-only or fee-free venue), not a fallback.
    expect(roundTripCostFraction({ takerFeeFraction: 0, slippageFraction: 0 })).toBe(0)
  })
})
