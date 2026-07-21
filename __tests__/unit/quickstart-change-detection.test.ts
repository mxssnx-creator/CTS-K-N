import {
  collectQuickStartChangedFields,
  quickStartValuesEqual,
  sameOrderedSymbols,
} from "@/lib/quickstart-change-detection"

describe("QuickStart change detection", () => {
  test("treats serialized equivalents as the same setting", () => {
    expect(quickStartValuesEqual("true", "1")).toBe(true)
    expect(quickStartValuesEqual("0.050", 0.05)).toBe(true)
    expect(quickStartValuesEqual('["BTCUSDT","ETHUSDT"]', ["BTCUSDT", "ETHUSDT"])).toBe(true)
  })

  test("keeps the selection generation for the same ordered basket", () => {
    expect(sameOrderedSymbols(["btcusdt", "ETHUSDT"], ["BTCUSDT", "ethusdt"])).toBe(true)
    expect(sameOrderedSymbols(["BTCUSDT", "ETHUSDT"], ["ETHUSDT", "BTCUSDT"])).toBe(false)
  })

  test("does not turn an idempotent QuickStart audit refresh into a processing reset", () => {
    const fields = collectQuickStartChangedFields({
      beforeConnection: {
        is_enabled: "1",
        force_symbols: '["BTCUSDT","ETHUSDT"]',
        live_volume_factor: "1",
        updated_at: "old",
      },
      beforeSettings: {
        symbols: '["BTCUSDT","ETHUSDT"]',
        mainProfitFactor: "1.2",
        updated_at: "old",
      },
      nextConnection: {
        is_enabled: true,
        force_symbols: ["BTCUSDT", "ETHUSDT"],
        live_volume_factor: 1,
        updated_at: "new",
        last_test_at: "new",
        state_switch_version: "99",
      },
      nextSettings: {
        symbols: ["BTCUSDT", "ETHUSDT"],
        mainProfitFactor: 1.2,
        updated_at: "new",
      },
    })

    expect(fields).toEqual([])
  })

  test("reports the exact basket and strategy fields that really changed", () => {
    const fields = collectQuickStartChangedFields({
      beforeConnection: { force_symbols: '["BTCUSDT"]' },
      beforeSettings: { mainProfitFactor: "1.2" },
      nextConnection: { force_symbols: '["BTCUSDT","ETHUSDT"]' },
      nextSettings: { mainProfitFactor: "1.3" },
    })

    expect(fields).toEqual([
      "force_symbols",
      "connection_settings.mainProfitFactor",
    ])
  })
})
