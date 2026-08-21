import fs from "node:fs"
import path from "node:path"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("active connection scope contract", () => {
  test("preset activation persists independently per selected connection", () => {
    const listRoute = read("app/api/presets/route.ts")
    const activateRoute = read("app/api/presets/activate/route.ts")

    expect(listRoute).toContain("active_preset:${requestedConnectionId}")
    expect(activateRoute).toContain("active_preset:${scopedConnectionId}")
    expect(activateRoute).toContain("Select an active connection before activating a preset")
    expect(activateRoute).not.toContain("UPDATE presets SET is_active = false")
  })

  test("dashboard data and preset control never silently fall back to X01", () => {
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const monitoring = read("app/monitoring/page.tsx")
    const logistics = read("app/logistics/page.tsx")
    const globalControls = read("components/dashboard/global-trade-engine-controls.tsx")

    expect(quickstart).toContain("/api/exchange/live-summary?connectionId=${encodeURIComponent(connectionId)}")
    expect(monitoring).toContain("<PnLDashboard connectionId={selectedConnectionId} />")
    expect(logistics).toContain("const connId = selectedConnectionId ?? null")
    expect(globalControls).toContain("body: JSON.stringify({ presetId, connectionId: selectedConnectionId })")
  })

  test("statistics and live ledgers require the selected connection", () => {
    const presetStats = read("components/statistics/preset-trade-stats.tsx")
    const statisticsPage = read("app/statistics/page.tsx")
    const pnlStats = read("app/api/trade-engine/pnl-stats/route.ts")
    const livePositions = read("app/api/trading/live-positions/route.ts")
    const symbolStats = read("app/api/exchange-positions/symbols-stats/route.ts")
    const presetTest = read("app/api/presets/[id]/test/route.ts")
    const presetGenerator = read("lib/preset-config-generator.ts")
    const integrationSuite = read("lib/integration-test-suite.ts")
    const coordinator = read("lib/trade-engine.ts")
    const productionSeeder = read("lib/production-seeder.ts")

    expect(presetStats).toContain("/api/presets?connectionId=${encodeURIComponent(connectionId)}")
    expect(statisticsPage).toContain("connectionId={selectedConnectionId}")
    expect(pnlStats).toContain("connection_id query parameter required")
    expect(livePositions).toContain("connection_id query parameter required")
    expect(symbolStats).toContain("connection_id query parameter required")
    expect(presetTest).toContain("select an active connection before testing a preset")
    expect(presetTest).toContain("scopedConnectionId")
    expect(presetGenerator).toContain("getCanonicalConnectionSettingsOverlay(scope)")
    expect(integrationSuite).toContain("requires an explicit connectionId")
    expect(integrationSuite).not.toContain('connectionId = "bingx-x01"')
    expect(coordinator).not.toContain("DEV one-engine guard")
    expect(coordinator).not.toContain('connections → running only')
    expect(productionSeeder).not.toContain('connectionId: "bingx-x01"')
    expect(productionSeeder).toContain("No active connection selected; skipping unscoped market-data seed")
  })
})
