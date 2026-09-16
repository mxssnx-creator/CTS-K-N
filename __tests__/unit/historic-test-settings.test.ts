import {
  DEFAULT_HISTORIC_TEST_SETTINGS,
  HISTORIC_TEST_SETTINGS_CHANGE_FIELDS,
  historicTestSettingsToHashFields,
  normalizeHistoricTestSettings,
} from "@/lib/historic-test-settings"

describe("Historic Test settings contract", () => {
  test("defaults: disabled, 20h, PF 1.20, 15 symbols, 2h recalc, every family on, 1H volatility, 200 steps", () => {
    expect(DEFAULT_HISTORIC_TEST_SETTINGS).toEqual({
      enabled: false,
      periodHours: 20,
      minProfitFactor: 1.2,
      symbolCount: 15,
      recalcIntervalHours: 2,
      strategies: { normal: true, trailing: true, axis: true, block: true, dca: true },
      symbols: { exchange: "", order: "volatility_1h", maxProgressCount: 200 },
    })
    expect(normalizeHistoricTestSettings(undefined)).toEqual(DEFAULT_HISTORIC_TEST_SETTINGS)
    expect(normalizeHistoricTestSettings({})).toEqual(DEFAULT_HISTORIC_TEST_SETTINGS)
    expect(normalizeHistoricTestSettings("not json")).toEqual(DEFAULT_HISTORIC_TEST_SETTINGS)
  })

  test("ranges are clamped and the period snaps to its 5-hour step", () => {
    expect(normalizeHistoricTestSettings({ periodHours: 4 }).periodHours).toBe(5)
    expect(normalizeHistoricTestSettings({ periodHours: 22 }).periodHours).toBe(20)
    expect(normalizeHistoricTestSettings({ periodHours: 23 }).periodHours).toBe(25)
    expect(normalizeHistoricTestSettings({ periodHours: 900 }).periodHours).toBe(85)
    expect(normalizeHistoricTestSettings({ symbolCount: 0 }).symbolCount).toBe(1)
    expect(normalizeHistoricTestSettings({ symbolCount: 51 }).symbolCount).toBe(50)
    expect(normalizeHistoricTestSettings({ recalcIntervalHours: 0 }).recalcIntervalHours).toBe(1)
    expect(normalizeHistoricTestSettings({ recalcIntervalHours: 9 }).recalcIntervalHours).toBe(8)
    expect(normalizeHistoricTestSettings({ symbols: { maxProgressCount: 5 } }).symbols.maxProgressCount).toBe(10)
    expect(normalizeHistoricTestSettings({ symbols: { maxProgressCount: 301 } }).symbols.maxProgressCount).toBe(300)
    // The PF threshold lives on the PositionCost-relative 1.02 + n x 0.02 grid.
    expect(normalizeHistoricTestSettings({ minProfitFactor: 1.2 }).minProfitFactor).toBe(1.2)
    expect(normalizeHistoricTestSettings({ minProfitFactor: 1.205 }).minProfitFactor).toBe(1.2)
    expect(normalizeHistoricTestSettings({ minProfitFactor: 1.239 }).minProfitFactor).toBe(1.24)
    expect(normalizeHistoricTestSettings({ minProfitFactor: "x" }).minProfitFactor).toBe(1.2)
  })

  test("accepts nested, flat-mirror and JSON-encoded shapes", () => {
    const nested = normalizeHistoricTestSettings({
      historic_test_settings: JSON.stringify({ enabled: true, periodHours: 35, strategies: { dca: false }, symbols: { order: "volume_24h", exchange: "BingX" } }),
    })
    expect(nested.enabled).toBe(true)
    expect(nested.periodHours).toBe(35)
    expect(nested.strategies).toEqual({ normal: true, trailing: true, axis: true, block: true, dca: false })
    expect(nested.symbols.order).toBe("volume_24h")
    expect(nested.symbols.exchange).toBe("bingx")

    const flat = normalizeHistoricTestSettings({
      historicTestEnabled: "true",
      historic_test_period_hours: "45",
      historicTestSymbolCount: "30",
      historicTestAxisEnabled: "false",
      historicTestSymbolOrder: "change_24h",
      historicTestMaxProgressCount: "120",
    })
    expect(flat).toMatchObject({ enabled: true, periodHours: 45, symbolCount: 30 })
    expect(flat.strategies.axis).toBe(false)
    expect(flat.symbols).toEqual({ exchange: "", order: "change_24h", maxProgressCount: 120 })
    // Unknown orders fall back to the default ranking.
    expect(normalizeHistoricTestSettings({ symbols: { order: "random" } }).symbols.order).toBe("volatility_1h")
  })

  test("hash mirrors round-trip and every mirror is a recoordination trigger", () => {
    const settings = normalizeHistoricTestSettings({ enabled: true, periodHours: 60, strategies: { block: false } })
    const fields = historicTestSettingsToHashFields(settings)
    expect(normalizeHistoricTestSettings(fields)).toEqual(settings)
    expect(fields.historicTestBlockEnabled).toBe("false")
    for (const key of Object.keys(fields)) expect(HISTORIC_TEST_SETTINGS_CHANGE_FIELDS).toContain(key)
  })
})
