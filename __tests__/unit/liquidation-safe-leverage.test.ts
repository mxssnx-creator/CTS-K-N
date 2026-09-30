import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { effectiveLeverageCap, liquidationSafetyFactor, maxLeverageForStop } from "@/lib/liquidation-safe-leverage"

describe("leverage never puts the liquidation in front of the stop", () => {
  test("a 0.5 % stop allows at most 100x; a 1 % stop 50x; a 0.25 % stop 200x", () => {
    expect(maxLeverageForStop(0.5, 2)).toBe(100)
    expect(maxLeverageForStop(1, 2)).toBe(50)
    expect(maxLeverageForStop(0.25, 2)).toBe(200)
  })
  test("X01, 2026-09-28..30: the 500x and 300x entries at a 0.5 % stop are capped to 100x, the 100x/75x/50x ones are untouched", () => {
    const cap = effectiveLeverageCap(0, 0.5)
    const venueMax = [500, 300, 200, 125, 100, 75, 50]
    const used = venueMax.map((v) => Math.min(v, cap || v))
    expect(used).toEqual([100, 100, 100, 100, 100, 75, 50])
    // the liquidation distance (100/leverage) is now at least twice the stop for every one of them
    expect(used.every((lev) => 100 / lev >= 0.5)).toBe(true)
  })
  test("the connection's own max_leverage still applies: the smaller of the two wins", () => {
    expect(effectiveLeverageCap(20, 0.5)).toBe(20)
    expect(effectiveLeverageCap(500, 0.5)).toBe(100)
    expect(effectiveLeverageCap(0, 0.5)).toBe(100)
  })
  test("no usable stop means no stop-based cap, and the cap never goes below 1x", () => {
    expect(maxLeverageForStop(0, 2)).toBe(0)
    expect(maxLeverageForStop(NaN, 2)).toBe(0)
    expect(effectiveLeverageCap(0, 0)).toBe(0)
    expect(maxLeverageForStop(80, 2)).toBe(1)
  })
  test("CTS_LIQUIDATION_SAFETY_FACTOR sets the margin, 0 turns the cap off, junk falls back to 2", () => {
    expect(liquidationSafetyFactor({})).toBe(2)
    expect(liquidationSafetyFactor({ CTS_LIQUIDATION_SAFETY_FACTOR: "3" })).toBe(3)
    expect(liquidationSafetyFactor({ CTS_LIQUIDATION_SAFETY_FACTOR: "0" })).toBe(0)
    expect(liquidationSafetyFactor({ CTS_LIQUIDATION_SAFETY_FACTOR: "abc" })).toBe(2)
    expect(maxLeverageForStop(0.5, 0)).toBe(0)
    expect(effectiveLeverageCap(0, 0.5, 0)).toBe(0)
  })
  test("the live stage applies it where the entry leverage is chosen, and the later re-check keeps it", () => {
    const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(live).toContain("const leverageCapForEntry = effectiveLeverageCap(connectionCap, stopLossForLeverage)")
    expect(live).toContain("livePosition.leverage = leverageCapForEntry > 0 ? Math.max(1, Math.min(venueMax, leverageCapForEntry)) : venueMax")
    expect(live).toContain("(livePosition as any).leverageCap = leverageCapForEntry > 0 ? leverageCapForEntry : undefined")
    // the re-check after the volume calculator reads leverageCap, so the stop-aware cap survives it
    expect(live).toContain("const cap = Number((livePosition as any).leverageCap || 0)")
  })
})
