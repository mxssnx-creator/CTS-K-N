import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { maxNewNotionalForRiskBudget, openStopRiskUsd, riskBudgetPercentSetting, rowStopPercent, rowStopRiskUsd, UNKNOWN_STOP_PERCENT } from "@/lib/portfolio-risk-budget"

describe("account-wide stop-loss risk budget (high volume factor without risking the account)", () => {
  test("a row's stop risk is quantity x entry x stop distance", () => {
    expect(rowStopRiskUsd({ executedQuantity: 10, entryPrice: 5, stopLossPrice: 4.95, status: "open" })).toBeCloseTo(0.5, 6) // 1 %
    expect(rowStopPercent({ entryPrice: 100, stopLoss: 0.5 })).toBe(0.5)
    expect(rowStopPercent({ entryPrice: 100 })).toBe(UNKNOWN_STOP_PERCENT) // unknown counts conservatively
  })
  test("open risk sums own open real rows only", () => {
    const rows = [
      { status: "open", executedQuantity: 10, entryPrice: 5, stopLossPrice: 4.95 },
      { status: "closed", executedQuantity: 10, entryPrice: 5, stopLossPrice: 4.95 },
      { status: "open", executionMode: "simulated", executedQuantity: 10, entryPrice: 5, stopLossPrice: 4.95 },
    ]
    expect(openStopRiskUsd(rows)).toBeCloseTo(0.5, 6)
  })
  test("X01: 32 USDT, 30 %: 9.6 USDT of stop risk; with 9 USDT open and a 1.5 % stop the next entry may have 40 USDT", () => {
    expect(maxNewNotionalForRiskBudget({ balanceUsd: 32, budgetPercent: 30, openRiskUsd: 9, stopPercent: 1.5 })).toBeCloseTo(40, 6)
    expect(maxNewNotionalForRiskBudget({ balanceUsd: 32, budgetPercent: 30, openRiskUsd: 9.6, stopPercent: 1.5 })).toBe(0)
    expect(maxNewNotionalForRiskBudget({ balanceUsd: 32, budgetPercent: 0, openRiskUsd: 99, stopPercent: 1.5 })).toBe(Infinity)
    expect(maxNewNotionalForRiskBudget({ balanceUsd: 0, budgetPercent: 30, openRiskUsd: 0, stopPercent: 1.5 })).toBe(0)
  })
  test("the setting: default 30, 0 switches off, bounded to 100", () => {
    expect(riskBudgetPercentSetting(undefined)).toBe(30)
    expect(riskBudgetPercentSetting("0")).toBe(0)
    expect(riskBudgetPercentSetting(250)).toBe(100)
    expect(riskBudgetPercentSetting("x")).toBe(30)
  })
  test("the live entry applies it after the hard cap, for real orders, and the setting is stored", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(stage.indexOf("const allowedNotional = maxNewNotionalForRiskBudget(")).toBeGreaterThan(stage.indexOf("volumeNote = ` [hard-cap:"))
    expect(stage).toContain("Live entry refused: account stop-loss risk budget")
    const route = readFileSync(resolve(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")
    expect(route).toContain('"portfolioRiskBudgetPercent"')
  })
})
