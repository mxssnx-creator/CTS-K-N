import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SLIPPAGE_FRACTION, DEFAULT_TAKER_FEE_FRACTION, roundTripCostPercent, simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"

describe("systemwide round-trip cost", () => {
  test("is 0.15 %: taker fee 0.05 % per side plus 0.05 % slippage, charged once", () => {
    expect(DEFAULT_TAKER_FEE_FRACTION).toBe(0.0005)
    expect(DEFAULT_SLIPPAGE_FRACTION).toBe(0.0005)
    expect(roundTripCostPercent()).toBeCloseTo(0.15, 10)
    // PositionCost at or below the round trip is only the PF unit; above it, the larger budget is charged (never both).
    expect(simulatedCloseCostPercent(0.1)).toBeCloseTo(0.15, 10)
    expect(simulatedCloseCostPercent(0.15)).toBeCloseTo(0.15, 10)
    expect(simulatedCloseCostPercent(0.4)).toBe(0.4)
  })
})

describe("Direct Trade module default", () => {
  test("is disabled and not live until an operator enables it", () => {
    const route = readFileSync(join(process.cwd(), "app/api/trade-engine/direct-trade/route.ts"), "utf8")
    const state = route.slice(route.indexOf("const DEFAULT_STATE"), route.indexOf("const DEFAULT_STATE") + 400)
    expect(state).toMatch(/enabled:\s*false/)
    expect(state).toMatch(/liveMode:\s*false/)
  })
})
