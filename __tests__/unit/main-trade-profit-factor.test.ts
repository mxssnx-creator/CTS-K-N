import {
  MAIN_TRADE_PF_RATIO_MAX,
  MAIN_TRADE_PF_RATIO_MIN,
  MAIN_TRADE_STAGE_PF_DEFAULTS,
  mainTradePfRatioToGrossMovePct,
  mainTradeStagePfMin,
  mainTradePfRatioPasses,
  mainTradePfRatioToMovePct,
  mainTradePfRatioToSignedResultR,
  movePctToMainTradePfRatio,
  netMovePctAfterPositionCost,
  normalizeMainTradePfRatio,
  normalizeMainTradeStagePfRatio,
  signedResultRToMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"
import { derivePosWindowStats } from "@/lib/pos-history"
import fs from "node:fs"
import path from "node:path"

describe("Main Trade PositionCost-relative PF ratios", () => {
  test("uses the exact systemwide range, grid, and stage defaults", () => {
    expect(MAIN_TRADE_PF_RATIO_MIN).toBe(1)
    expect(MAIN_TRADE_PF_RATIO_MAX).toBe(2.2)
    expect(MAIN_TRADE_STAGE_PF_DEFAULTS).toEqual({
      base: 1.1,
      main: 1.1,
      real: 1.1,
      live: 1.1,
    })
    expect(normalizeMainTradePfRatio(0.079)).toBe(1)
    expect(normalizeMainTradePfRatio(1.081)).toBe(1.1)
    expect(normalizeMainTradePfRatio(1.15)).toBe(1.2)
    expect(normalizeMainTradePfRatio(99)).toBe(2.2)
  })

  test("enforces the systemwide PF stage floors", () => {
    expect(mainTradeStagePfMin("base")).toBe(1)
    expect(mainTradeStagePfMin("main")).toBe(1)
    expect(normalizeMainTradeStagePfRatio("base", 0.08)).toBe(1)
    expect(normalizeMainTradeStagePfRatio("base", 1.08)).toBe(1.1)
    expect(normalizeMainTradeStagePfRatio("base", 1.12)).toBe(1.1)
    expect(normalizeMainTradeStagePfRatio("main", 0.08)).toBe(1)
  })

  test("maps PF to PositionCost-relative positive move", () => {
    expect(mainTradePfRatioToMovePct(1.0, 0.1)).toBe(0)
    expect(mainTradePfRatioToMovePct(1.1, 0.1)).toBeCloseTo(0.1, 12)
    expect(mainTradePfRatioToMovePct(1.2, 0.1)).toBeCloseTo(0.2, 12)
    expect(mainTradePfRatioToMovePct(1.2, 0.2)).toBeCloseTo(0.4, 12)
    expect(mainTradePfRatioToGrossMovePct(1.0, 0.1)).toBeCloseTo(0.1, 12)
    expect(mainTradePfRatioToGrossMovePct(1.1, 0.1)).toBeCloseTo(0.2, 12)
    expect(mainTradePfRatioToGrossMovePct(1.2, 0.2)).toBeCloseTo(0.6, 12)
    expect(movePctToMainTradePfRatio(0, 0.1)).toBe(1)
    expect(movePctToMainTradePfRatio(0.1, 0.1)).toBeCloseTo(1.1, 12)
    expect(movePctToMainTradePfRatio(0.2, 0.1)).toBeCloseTo(1.2, 12)
    expect(mainTradePfRatioToSignedResultR(1)).toBe(0)
    expect(mainTradePfRatioToSignedResultR(1.1)).toBeCloseTo(1, 12)
    expect(mainTradePfRatioToSignedResultR(0.9)).toBeCloseTo(-1, 12)
    expect(signedResultRToMainTradePfRatio(0)).toBe(1)
    expect(signedResultRToMainTradePfRatio(0.6)).toBeCloseTo(1.06, 12)
    expect(signedResultRToMainTradePfRatio(-1)).toBeCloseTo(0.9, 12)
    // 0.104% is 1.104× PositionCost-relative PF and therefore clears 1.10.
    expect(mainTradePfRatioPasses(0.104, 0.1, 1.1)).toBe(true)
    expect(mainTradePfRatioPasses(0.1, 0.1, 1.1)).toBe(true)
    // Ratio 1.00 is neutral after one PositionCost; 1.10 needs two costs
    // gross, so the net result is one PositionCost.
    expect(netMovePctAfterPositionCost(0.1, 0.1)).toBe(0)
    expect(netMovePctAfterPositionCost(0.2, 0.1)).toBeCloseTo(0.1, 12)
  })

  test("keeps classic PF diagnostic separate from the stage ratio", () => {
    const stats = derivePosWindowStats([
      "10|0|2|0.30|0.10",
      "-1|0|4|-0.10|0.10",
    ], 2)

    expect(stats.profitFactor).toBe(10)
    expect(stats.averagePnlPct).toBeCloseTo(0.1, 12)
    expect(stats.positionCostRatio).toBeCloseTo(1.1, 12)
    expect(stats.positionCostRatioCount).toBe(2)
  })

  test("does not reinterpret legacy quote-currency rows as percentages", () => {
    const stats = derivePosWindowStats(["25|0|3", "-5|0|4"], 2)
    expect(stats.profitFactor).toBe(5)
    expect(stats.positionCostRatio).toBe(0)
    expect(stats.positionCostRatioCount).toBe(0)
  })

  test("never weakens Main or Real PF/history gates when Live is enabled", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/strategy-coordinator.ts"),
      "utf8",
    )
    expect(source).not.toContain("relaxed minProfitFactor")
    expect(source).not.toMatch(/Math\.min\([^)]*minProfitFactor[^)]*0\.75/)
    expect(source).not.toContain("injecting synthetic Real set")
    expect(source).not.toContain("promoted top REAL set for live dispatch")
    expect(source).toContain(
      "const mainMinPos = this._coordinationSettings.mainEvalPosCount",
    )
    expect(source).toContain("const baseValidSetKeys = new Set<string>()")
    expect(source).toContain("const metricsBase = this.METRICS.base")
    expect(source).toContain("const metricsMain = this.METRICS.main")
    expect(source).not.toContain("if (pf < this.PF_BASE_MIN) continue")
    expect(source).toContain(
      "const realMinPos = this._coordinationSettings.realEvalPosCount",
    )
  })
})
