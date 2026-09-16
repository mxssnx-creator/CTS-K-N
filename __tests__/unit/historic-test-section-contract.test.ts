import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("Historic Test section is wired end to end", () => {
  test("the section renders in the connection settings overview with every operator control", () => {
    const section = read("components/settings/historic-test-section.tsx")
    for (const control of [
      'id="historic-test-enabled"',
      'aria-label="Historic Test period hours"',
      'id="historic-test-min-pf"',
      'aria-label="Historic Test symbol count"',
      'aria-label="Historic Test recalc interval hours"',
      'id="historic-test-exchange"',
      'id="historic-test-order"',
      'aria-label="Historic Test max progress count"',
    ]) expect(section).toContain(control)
    // every strategy family is offered as its own switch
    expect(section).toContain("HISTORIC_TEST_STRATEGY_FAMILIES.map((family)")
    expect(section).toContain('volatility_1h: "1H Volatility"')
    const dialog = read("components/settings/connection-settings-dialog.tsx")
    expect(dialog).toContain("<HistoricTestSection")
    expect(dialog).toContain("setHistoricTest(normalizeHistoricTestSettings(settings))")
    expect((dialog.match(/historic_test_settings: historicTest/g) || []).length).toBe(2)
  })

  test("the settings route normalizes and mirrors the document, and changes recoordinate", () => {
    const route = read("app/api/settings/connections/[id]/settings/route.ts")
    expect(route).toContain("function normalizeHistoricTestInSettings(")
    expect((route.match(/normalizeHistoricTestInSettings\(\w+\)/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(route).toContain("Object.assign(settings, historicTestSettingsToHashFields(normalized))")
    const fields = read("lib/trade-engine/settings-change-fields.ts")
    expect(fields).toContain("...HISTORIC_TEST_SETTINGS_CHANGE_FIELDS,")
    const recoord = read("lib/connection-recoordinator.ts")
    expect(recoord).toContain('"historic_test_settings",')
    expect(recoord).toContain('"historicTestEnabled",')
    expect(recoord).not.toContain('"blockOnlyEnabled",')
  })
})
