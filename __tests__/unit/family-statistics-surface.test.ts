import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const route = readFileSync(resolve(process.cwd(), "app/api/statistics/families/route.ts"), "utf8")
const panel = readFileSync(resolve(process.cwd(), "components/statistics/family-performance-panel.tsx"), "utf8")
const page = readFileSync(resolve(process.cwd(), "app/statistics/page.tsx"), "utf8")

describe("per-family realised statistics reach an operator surface", () => {
  test("the module is no longer library-only — an API serves it", () => {
    expect(route).toContain("buildLiveFamilyStatistics")
    expect(route).toContain("families: combined.families")
    expect(route).toContain("overall: combined.overall")
    expect(route).toContain("foreign: combined.foreign")
  })

  test("rows come from the single existing trade-history assembly, not a second path", () => {
    expect(route).toContain("/api/trading/trade-history?connection_id=")
    // A second assembly would drift and report different numbers on the same data.
    expect(route).not.toContain("mergeTradeHistory")
  })

  test("aggregation covers connection-relevant lanes only, and an explicit id still works", () => {
    expect(route).toContain("isConnectionAssignedToMain(connection)")
    expect(route).toContain("const connectionIds = requested")
    expect(route).toContain("? [requested]")
  })

  test("the panel is mounted on the statistics page", () => {
    expect(page).toContain("<FamilyPerformancePanel />")
    expect(page).toContain('from "@/components/statistics/family-performance-panel"')
  })

  test("a family that never traded shows no verdict instead of a neutral 1.00", () => {
    expect(panel).toContain('if (row.trades === 0) return "text-muted-foreground"')
    expect(panel).toContain('{row.trades === 0 ? "—" : row.profitFactor.toFixed(4)}')
  })

  test("foreign rows are surfaced as excluded, never folded into a family", () => {
    expect(panel).toContain("foreign row(s) excluded")
    expect(route).toContain("foreign: combined.foreign")
  })
})
