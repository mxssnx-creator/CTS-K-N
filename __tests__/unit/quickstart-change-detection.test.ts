import {
  collectQuickStartChangedFields,
  quickStartValuesEqual,
  resolveQuickStartPreviousSymbolBasket,
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

  test("uses durable operator symbols before a stale runtime mirror for epoch ownership", () => {
    expect(resolveQuickStartPreviousSymbolBasket(
      { selected_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]' },
      { force_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]' },
      { force_symbols: '["XRPUSDT","BTCUSDT","SOLUSDT","BCHUSDT"]' },
    )).toEqual(["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"])
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

  test("does not reset Historic when the same basket is completed across missing aliases", () => {
    const fields = collectQuickStartChangedFields({
      beforeConnection: {
        selected_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        symbol_count: "4",
      },
      beforeSettings: {
        force_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        symbol_count: "4",
      },
      nextConnection: {
        selected_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        active_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        force_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        symbol_count: "4",
      },
      nextSettings: {
        symbols: ["btcusdt", "SOLUSDT", "BCHUSDT", "XRPUSDT"],
        active_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        force_symbols: '["BTCUSDT","SOLUSDT","BCHUSDT","XRPUSDT"]',
        symbol_count: 4,
      },
    })

    expect(fields).toEqual([])
  })
})
