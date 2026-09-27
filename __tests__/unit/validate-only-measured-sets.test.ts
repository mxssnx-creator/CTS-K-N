import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
const gate = src.slice(src.indexOf("const requireMeasuredHistoryForBaseValidity"))
// The measured-count rule lives in one reusable helper next to the window reader.
const posHistorySrc = readFileSync(resolve(process.cwd(), "lib/pos-history.ts"), "utf8")
const helper = posHistorySrc.slice(posHistorySrc.indexOf("export function baseMeasuredHistoryRejection"))

describe("a Set validates on measured results, not on an expectation", () => {
  test("the history gate runs BEFORE the PF/DDT comparison", () => {
    const historyCheck = gate.indexOf("baseMeasuredHistoryRejection(baseSet.prevPos, baseHistoryMinCount)")
    const pfCheck = gate.indexOf("baseSet.avgProfitFactor < metricsBase.minProfitFactor")
    expect(historyCheck).toBeGreaterThan(0)
    expect(historyCheck).toBeLessThan(pfCheck)
  })

  test("it counts MEASURED results, not entries or estimates", () => {
    expect(helper).toContain("Number(prevPos?.positionCostRatioCount ?? 0)")
    // entryCount is live candidates, prevPos.count includes unmeasured rows.
    expect(gate).not.toContain("baseSet.entryCount < baseHistoryMinCount")
  })

  test("a Set below the threshold is rejected with a distinct, readable reason", () => {
    expect(helper).toContain("base_awaiting_measured_history:")
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
