import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(
  path.join(process.cwd(), "components/presets/preset-config-bar.tsx"),
  "utf8",
)

describe("preset configuration display contract", () => {
  test("uses the configuration's PositionCost instead of a hard-coded 0.1%", () => {
    expect(source).toContain("const positionCostPct")
    expect(source).toContain("const takeProfitPct = takeprofitFactor * positionCostPct")
    expect(source).toContain("const stopLossPct = stoplossRatio * takeProfitPct")
    expect(source).not.toContain("(0.1% cost)")
    expect(source).not.toContain("takeprofitFactor * 0.1")
  })

  test("does not fabricate a random performance chart", () => {
    expect(source).not.toContain("Math.random")
    expect(source).toContain("config.performance_history")
    expect(source).toContain("No persisted performance series is available")
  })

  test("labels the persisted preset metric as classic net PF", () => {
    expect(source).toContain("Classic PF (net)")
  })
})
