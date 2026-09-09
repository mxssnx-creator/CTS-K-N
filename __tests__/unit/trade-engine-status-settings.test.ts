import { canonicalStageSettingsOverlay } from "@/lib/trade-engine-status-settings"

describe("canonical engine-status stage settings", () => {
  test("prefers canonical flat thresholds and keeps aliases coherent", () => {
    expect(canonicalStageSettingsOverlay({
      baseProfitFactor: "1.3",
      mainProfitFactor: "1.3",
      realProfitFactor: "1.3",
      liveProfitFactor: "1.3",
      settings_version: "x02:42",
      main_min_profit_factor: "1.1",
    })).toEqual({
      baseProfitFactor: "1.3",
      base_min_profit_factor: "1.3",
      mainProfitFactor: "1.3",
      main_min_profit_factor: "1.3",
      realProfitFactor: "1.3",
      real_min_profit_factor: "1.3",
      liveProfitFactor: "1.3",
      live_min_profit_factor: "1.3",
      settings_version: "x02:42",
    })
  })

  test("reads nested legacy strategy values and ignores malformed thresholds", () => {
    expect(canonicalStageSettingsOverlay({
      strategies: JSON.stringify({
        main: {
          base: { min_profit_factor: 1.25 },
          main: { min_profit_factor: 1.35 },
          real: { min_profit_factor: 1.45 },
          live: { min_profit_factor: 1.55 },
        },
      }),
      baseProfitFactor: "not-a-number",
    })).toEqual({
      mainProfitFactor: "1.35",
      main_min_profit_factor: "1.35",
      realProfitFactor: "1.45",
      real_min_profit_factor: "1.45",
      liveProfitFactor: "1.55",
      live_min_profit_factor: "1.55",
    })
  })

  test("returns no projection for missing or non-positive values", () => {
    expect(canonicalStageSettingsOverlay({
      baseProfitFactor: "0",
      mainProfitFactor: "-1",
      realProfitFactor: "",
      liveProfitFactor: "invalid",
    })).toEqual({})
  })
})
