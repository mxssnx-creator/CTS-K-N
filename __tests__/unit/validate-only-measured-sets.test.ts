import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
const gate = src.slice(src.indexOf("const requireMeasuredHistoryForBaseValidity"))

describe("a Set validates on measured results, not on an expectation", () => {
  test("the history gate runs BEFORE the PF/DDT comparison", () => {
    const historyCheck = gate.indexOf("measuredCount < baseHistoryMinCount")
    const pfCheck = gate.indexOf("baseSet.avgProfitFactor < metricsBase.minProfitFactor")
    expect(historyCheck).toBeGreaterThan(0)
    expect(historyCheck).toBeLessThan(pfCheck)
  })

  test("it counts MEASURED results, not entries or estimates", () => {
    expect(gate).toContain("Number(baseSet.prevPos?.positionCostRatioCount ?? 0)")
    // entryCount is live candidates, prevPos.count includes unmeasured rows.
    expect(gate).not.toContain("baseSet.entryCount < baseHistoryMinCount")
  })

  test("a Set below the threshold is rejected with a distinct, readable reason", () => {
    expect(gate).toContain("base_awaiting_measured_history:")
    // Distinguishable from a genuine PF rejection.
    expect(gate).toContain("base_low_profitfactor:")
  })

  test("the previous behaviour is restorable without a code change", () => {
    expect(gate).toContain('String(process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY ?? "1").trim() !== "0"')
  })

  test("the threshold reuses the operator's existing definition of enough history", () => {
    expect(gate).toContain("this._prevPosMinCountValue >= 0 ? this._prevPosMinCountValue : 5")
  })
})
