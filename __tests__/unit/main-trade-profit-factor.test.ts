import {
  MAIN_TRADE_PF_RATIO_MAX,
  MAIN_TRADE_PF_RATIO_MIN,
  MAIN_TRADE_STAGE_PF_DEFAULTS,
  mainTradeStagePfMin,
  mainTradePfRatioPasses,
  mainTradePfRatioToMovePct,
  movePctToMainTradePfRatio,
  normalizeMainTradePfRatio,
  normalizeMainTradeStagePfRatio,
} from "@/lib/main-trade-profit-factor"
import { derivePosWindowStats } from "@/lib/pos-history"
import fs from "node:fs"
import path from "node:path"

describe("Main Trade PositionCost-relative PF ratios", () => {
  test("uses the exact systemwide range, grid, and stage defaults", () => {
    expect(MAIN_TRADE_PF_RATIO_MIN).toBe(0.08)
    expect(MAIN_TRADE_PF_RATIO_MAX).toBe(2.7)
    expect(MAIN_TRADE_STAGE_PF_DEFAULTS).toEqual({
      base: 0.8,
      main: 1.12,
      real: 1.12,
      live: 1.12,
    })
    expect(normalizeMainTradePfRatio(0.079)).toBe(0.08)
    expect(normalizeMainTradePfRatio(0.111)).toBe(0.12)
    expect(normalizeMainTradePfRatio(99)).toBe(2.7)
  })

  test("enforces the Base 0.80 floor without weakening the downstream 0.08 floor", () => {
    expect(mainTradeStagePfMin("base")).toBe(0.8)
    expect(mainTradeStagePfMin("main")).toBe(0.08)
    expect(normalizeMainTradeStagePfRatio("base", 0.08)).toBe(0.8)
    expect(normalizeMainTradeStagePfRatio("base", 0.79)).toBe(0.8)
    expect(normalizeMainTradeStagePfRatio("base", 0.82)).toBe(0.82)
    expect(normalizeMainTradeStagePfRatio("main", 0.08)).toBe(0.08)
  })

  test("converts the ratio against PositionCost exactly once", () => {
    expect(mainTradePfRatioToMovePct(0.1, 0.1)).toBe(0.1)
    expect(mainTradePfRatioToMovePct(0.3, 0.1)).toBe(0.3)
    expect(mainTradePfRatioToMovePct(1.12, 0.2)).toBe(2.24)
    expect(movePctToMainTradePfRatio(0.3, 0.1)).toBe(0.3)
    expect(mainTradePfRatioPasses(0.299, 0.1, 0.3)).toBe(false)
    expect(mainTradePfRatioPasses(0.3, 0.1, 0.3)).toBe(true)
  })

  test("keeps classic PF diagnostic separate from the stage ratio", () => {
    const stats = derivePosWindowStats([
      "10|0|2|0.30|0.10",
      "-1|0|4|-0.10|0.10",
    ], 2)

    expect(stats.profitFactor).toBe(10)
    expect(stats.averagePnlPct).toBeCloseTo(0.1, 12)
    expect(stats.positionCostRatio).toBeCloseTo(0.1, 12)
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
    expect(source).toContain(
      "const realMinPos = this._coordinationSettings.realEvalPosCount",
    )
  })
})
