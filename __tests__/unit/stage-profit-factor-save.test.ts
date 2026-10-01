import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  clampStageProfitFactorPatch, MAIN_TRADE_PF_RATIO_MAX, resolveCoherentStageThresholds, STAGE_PROFIT_FACTOR_SETTING_KEYS,
} from "@/lib/main-trade-profit-factor"

describe("a stage profit factor above the maximum is stored as the maximum", () => {
  test("X02, 2026-10-01: base 7 lifted every stage to 2.3 and nothing passed for two days", () => {
    const stored = resolveCoherentStageThresholds({ base: 7, main: 1.02, real: 1.02, live: 1.02 })
    expect([stored.base, stored.main, stored.real, stored.live]).toEqual([2.3, 2.3, 2.3, 2.3])
    expect(stored.lifted.map((l) => l.stage)).toEqual(["main", "real", "live"])
  })
  test("saving 7 stores 2.3, which is what reading would use, and reports the change", () => {
    const { patch, clamped } = clampStageProfitFactorPatch({ baseProfitFactor: 7, base_min_profit_factor: "9.5", mainProfitFactor: 1.02, symbols: ["BTCUSDT"] })
    expect(patch).toMatchObject({ baseProfitFactor: MAIN_TRADE_PF_RATIO_MAX, base_min_profit_factor: MAIN_TRADE_PF_RATIO_MAX, mainProfitFactor: 1.02, symbols: ["BTCUSDT"] })
    expect(clamped).toEqual([
      { key: "baseProfitFactor", requested: 7, stored: 2.3 },
      { key: "base_min_profit_factor", requested: 9.5, stored: 2.3 },
    ])
  })
  test("values within the range, the maximum itself, text and missing keys are left alone", () => {
    const input = { baseProfitFactor: 0.8, mainProfitFactor: 1.1, realProfitFactor: 2.3, liveProfitFactor: "abc", other: 99 }
    const { patch, clamped } = clampStageProfitFactorPatch(input)
    expect(patch).toEqual(input)
    expect(clamped).toEqual([])
    expect(clampStageProfitFactorPatch({}).clamped).toEqual([])
  })
  test("the input is not modified, and every stored alias is covered", () => {
    const input = { baseProfitFactor: 7 }
    clampStageProfitFactorPatch(input)
    expect(input.baseProfitFactor).toBe(7)
    expect(STAGE_PROFIT_FACTOR_SETTING_KEYS).toEqual(expect.arrayContaining([
      "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
      "base_min_profit_factor", "main_min_profit_factor", "real_min_profit_factor", "live_min_profit_factor",
    ]))
  })
  test("both save paths of the connection settings use it", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")
    expect(route).toContain("const profitFactorGuard = clampStageProfitFactorPatch(rawIncomingSettings as Record<string, unknown>)")
    expect(route).toContain("const incomingSettings = profitFactorGuard.patch as typeof rawIncomingSettings")
    expect(route).toContain("const requestSettings = clampStageProfitFactorPatch(requestSettingsRaw).patch")
  })
})
