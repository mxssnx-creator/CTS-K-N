import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { applyIncomingHistoricPrecedence, normalizeHistoricTestSettings, historicTestSettingsToHashFields } from "@/lib/historic-test-settings"

const stored = () => ({
  enabled: true, periodHours: 20, minProfitFactor: 1.2, symbolCount: 22, recalcIntervalHours: 2, liveCheckPositions: 15,
  strategies: { normal: true, trailing: true, axis: true, block: true, dca: false },
  symbols: { exchange: "", order: "volatility_1h", maxProgressCount: 200 },
})
/** What the route hands over: the stored settings with the request merged in. */
const merge = (base: Record<string, any>, request: Record<string, any>) => ({ ...base, ...request })

describe("a Historic Test save is the last word, whatever name it uses", () => {
  test("2026-09-29: stored historic_test_settings (3rd alias, on) vs submitted historicTestSettings (4th alias, off)", () => {
    const base = { historic_test_settings: stored(), historicTestSettings: stored() }
    const request = { historicTestSettings: { ...stored(), enabled: false } }
    const merged = merge(base, request)
    expect(normalizeHistoricTestSettings(merged).enabled).toBe(true) // the bug: the stored 3rd alias outranks the request
    applyIncomingHistoricPrecedence(merged, request)
    const result = normalizeHistoricTestSettings(merged)
    expect(result.enabled).toBe(false)
    expect(result.minProfitFactor).toBe(1.2)
    expect(result.symbolCount).toBe(22)
    expect(merged.historic_test_settings).toBeUndefined()
  })
  test("a partial nested request keeps every field it does not name, including strategy families", () => {
    const base = { historic_test_settings: stored() }
    const request = { historicTestSettings: { enabled: false, strategies: { axis: false } } }
    const merged = merge(base, request)
    applyIncomingHistoricPrecedence(merged, request)
    const r = normalizeHistoricTestSettings(merged)
    expect(r.enabled).toBe(false)
    expect(r.strategies).toEqual({ normal: true, trailing: true, axis: false, block: true, dca: false })
    expect(r.periodHours).toBe(20); expect(r.symbols.maxProgressCount).toBe(200)
  })
  test("a flat-only request wins against a stored nested object and leaves the other stored fields alone", () => {
    const base = { historicTestSettings: stored(), ...historicTestSettingsToHashFields(normalizeHistoricTestSettings(stored())) }
    const request = { historicTestEnabled: false }
    const merged = merge(base, request)
    expect(normalizeHistoricTestSettings(merged).enabled).toBe(true) // the stored nested object outranks the flat field
    applyIncomingHistoricPrecedence(merged, request)
    const r = normalizeHistoricTestSettings(merged)
    expect(r.enabled).toBe(false)
    expect(r.minProfitFactor).toBe(1.2); expect(r.symbolCount).toBe(22); expect(r.strategies.dca).toBe(false)
    for (const alias of ["historicTest", "historic_test", "historic_test_settings", "historicTestSettings"]) expect(merged[alias]).toBeUndefined()
  })
  test("a flat-only request against settings that were never stored keeps the defaults for the rest", () => {
    const merged = merge({}, { historicTestEnabled: true })
    applyIncomingHistoricPrecedence(merged, { historicTestEnabled: true })
    expect(normalizeHistoricTestSettings(merged).enabled).toBe(true)
  })
  test("a request that names no Historic Test field leaves the settings exactly as they are", () => {
    const base = { historic_test_settings: stored(), historicTestSettings: stored(), other: 1 }
    const merged = merge(base, { other: 2 })
    const before = JSON.stringify(merged)
    applyIncomingHistoricPrecedence(merged, { other: 2 })
    expect(JSON.stringify(merged)).toBe(before)
    applyIncomingHistoricPrecedence(merged, null)
    expect(JSON.stringify(merged)).toBe(before)
  })
  test("both handlers of the settings route apply it before normalising", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")
    expect(route).toContain("applyIncomingHistoricPrecedence(mergedSettings, incomingSettings)\n    normalizeHistoricTestInSettings(mergedSettings)")
    expect(route).toContain("applyIncomingHistoricPrecedence(merged, settings)\n    normalizeHistoricTestInSettings(merged)")
  })
})
