import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("the signal statistics page shows the source quorum (it rendered 'undefined crypto')", () => {
  test("the route delivers both quorum values", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/statistics/indications/route.ts"), "utf8")
    expect(route).toContain("minimumSourceSignals: signalSettings.minimumSourceSignals,")
    expect(route).toContain("minimumSourceSignalsForex: signalSettings.minimumSourceSignalsForex,")
  })
  test("the page never prints 'undefined' for a missing value", () => {
    const page = readFileSync(resolve(process.cwd(), "components/statistics/indication-analytics-dashboard.tsx"), "utf8")
    expect(page).toContain('${payload.signal.settings.minimumSourceSignals ?? "–"} crypto · ${payload.signal.settings.minimumSourceSignalsForex ?? "–"} Forex')
  })
})
