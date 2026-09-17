import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")
const route = read("app/api/connections/[id]/historic-test/route.ts")
const panel = read("components/settings/historic-test-stats-panel.tsx")
const dialog = read("components/settings/connection-settings-dialog.tsx")

describe("Historic Test statistics surface", () => {
  test("the API reports per-family summaries, validated configs and every rejection reason", () => {
    expect(route).toContain("summaries: Array.isArray(report?.summaries) ? report.summaries : []")
    expect(route).toContain("validated: {")
    expect(route).toContain("byReason: rejected.reduce(")
    expect(route).toContain("simulationErrors: Number(report?.errors) || 0")
    // A pass that never ran reports null, not an empty result.
    expect(route).toContain("ranAt: report?.ranAt ?? null")
  })

  test("the API reads settings through the canonical overlay", () => {
    expect(route).toContain("getCanonicalConnectionSettingsOverlay(connectionId)")
    expect(route).not.toContain("hgetall(`connection_settings:")
  })

  test("the panel shows a PF row per family plus overall, with drawdown time", () => {
    expect(panel).toContain('["normal", "trailing", "axis", "block", "dca", "overall"]')
    for (const label of ["Normal", "Trailing", "Axis", "Block", "DCA", "Overall"]) {
      expect(panel).toContain(`${label}"`)
    }
    expect(panel).toContain("Ø DDT")
    expect(panel).toContain("Max DDT")
  })

  test("a family that was never measured is labelled as such, not shown as a neutral PF", () => {
    expect(panel).toContain("const measured = row.combinations > 0")
    expect(panel).toContain('measured ? formatPf(row.profitFactor) : "not measured"')
  })

  test("PF is presented on the PositionCost-relative coordinate", () => {
    expect(panel).toContain("const costs = (value - 1) / 0.1")
    expect(panel).toContain("PositionCosts")
  })

  test("the panel is mounted in the connection settings dialog", () => {
    expect(dialog).toContain("<HistoricTestStatsPanel connectionId={connectionId} />")
  })
})
