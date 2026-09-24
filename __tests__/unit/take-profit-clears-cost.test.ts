import { MINIMUM_NET_TAKE_PROFIT_PCT, minimumViableTakeProfitPct } from "@/lib/trade-engine/stages/live-stage"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("a take profit can never be booked below its own cost", () => {
  test("the floor is the round-trip cost plus a minimum net gain", () => {
    expect(minimumViableTakeProfitPct()).toBeCloseTo(roundTripCostPercent() + MINIMUM_NET_TAKE_PROFIT_PCT, 10)
    expect(minimumViableTakeProfitPct()).toBeGreaterThan(roundTripCostPercent())
  })
  test("the production values that lost money on a win are lifted above cost", () => {
    for (const configured of [0.2, 0.205, 0.25]) {
      const applied = Math.max(configured, minimumViableTakeProfitPct())
      expect(applied - roundTripCostPercent()).toBeGreaterThanOrEqual(MINIMUM_NET_TAKE_PROFIT_PCT - 1e-9)
    }
  })
  test("a target already above the floor is left untouched, and the stop is never changed", () => {
    expect(Math.max(1.46, minimumViableTakeProfitPct())).toBe(1.46)
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(src).toContain("const rawTpPct = Math.max(Number(pos.takeProfit) || 0, minimumViableTakeProfitPct())")
    expect(src).not.toContain("minimumViableStopLossPct")
  })
})
