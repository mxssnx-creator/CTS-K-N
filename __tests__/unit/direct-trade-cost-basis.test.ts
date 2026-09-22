import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { roundTripCostPercent, DEFAULT_TAKER_FEE_FRACTION, DEFAULT_SLIPPAGE_FRACTION } from "@/lib/trading-round-trip-cost"
const cjs = require("../../lib/trading-round-trip-cost.cjs")
const processor = readFileSync(resolve(process.cwd(), "scripts/direct-trade-processor.mjs"), "utf8")

describe("one round-trip cost for replay, live model and Direct-Trade simulation", () => {
  test("the TypeScript module and the plain-Node module are the same implementation", () => {
    expect(roundTripCostPercent()).toBe(cjs.roundTripCostPercent())
    expect(DEFAULT_TAKER_FEE_FRACTION).toBe(cjs.DEFAULT_TAKER_FEE_FRACTION)
    expect(DEFAULT_SLIPPAGE_FRACTION).toBe(cjs.DEFAULT_SLIPPAGE_FRACTION)
    expect(roundTripCostPercent({ takerFeeFraction: 0.0005, slippageFraction: 0.0003 })).toBeCloseTo(0.13, 10)
  })
  test("the Direct-Trade processor charges the shared round-trip cost, not PositionCost", () => {
    expect(processor).toContain('import roundTripCost from "../lib/trading-round-trip-cost.cjs"')
    expect(processor).toContain("const positionCostPercent = roundTripCost.roundTripCostPercent()")
    expect(processor).not.toContain("Number(pos.positionCostPercent) || Number(state.positionCostPercent) || 0.1))")
  })
})
