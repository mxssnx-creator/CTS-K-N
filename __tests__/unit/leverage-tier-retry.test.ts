import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { leverageTierCapFromError, nextLowerLeverageTier } from "@/lib/trade-engine/stages/live-stage"

describe("BingX 101209: the position value exceeds the leverage tier", () => {
  test("the cap is read from the error in every shape the connector returns", () => {
    const msg = "BingX API error (code=101209): The maximum position value for this leverage is 10000 USDT."
    expect(leverageTierCapFromError(msg)).toBe(10000)
    expect(leverageTierCapFromError({ success: false, error: msg })).toBe(10000)
    expect(leverageTierCapFromError(new Error(msg.replace("10000", "5000")))).toBe(5000)
  })
  test("any other error is not a tier rejection", () => {
    expect(leverageTierCapFromError("BingX API error (code=101204): Insufficient margin")).toBeNull()
    expect(leverageTierCapFromError({ success: true })).toBeNull()
    expect(leverageTierCapFromError(null)).toBeNull()
  })
  test("the next tier halves the leverage down to 5x and then stops", () => {
    expect(nextLowerLeverageTier(300)).toBe(150)
    expect(nextLowerLeverageTier(150)).toBe(75)
    expect(nextLowerLeverageTier(8)).toBe(5)
    expect(nextLowerLeverageTier(5)).toBeNull()
    expect(nextLowerLeverageTier(1)).toBeNull()
  })
  test("the entry path retries at a lower tier with the same quantity before the margin fallback", () => {
    const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const tier = live.indexOf("// ── Leverage tier on 101209")
    const margin = live.indexOf("// ── Volume reduction on 101204")
    expect(tier).toBeGreaterThan(0)
    expect(margin).toBeGreaterThan(tier)
    expect(live).toContain("submitEntryQuantity(computedVolume, `tier-${lower}x`)")
    expect(live).toContain("{ marginType: livePosition.marginType, leverage: lower }")
  })
})
