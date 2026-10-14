import { readFileSync } from "node:fs"
import path from "node:path"

/** The Backtest section sits at the bottom of the main connection settings dialog's first page. */
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("connection backtest UI", () => {
  const dialog = source("components/settings/connection-settings-dialog.tsx")
  const section = source("components/settings/connection-backtest-section.tsx")
  const stats = source("components/settings/connection-backtest-dialog.tsx")

  test("is the last block of the Overview tab", () => {
    const overview = dialog.slice(dialog.indexOf('<TabsContent value="overview"'))
    const end = overview.indexOf("</TabsContent>")
    const block = overview.indexOf("<ConnectionBacktestSection connectionId={connectionId}")
    expect(block).toBeGreaterThan(overview.indexOf("<HistoricTestStatsPanel"))
    expect(block).toBeLessThan(end)
    expect(overview.slice(block, end).trim().split("\n")).toHaveLength(1)
  })

  test("range slider 5–75 h, step 5, default 15; mode and execution choices", () => {
    expect(section).toContain('aria-label="Backtest range hours"')
    expect(section).toContain("min={BACKTEST_HOURS.min}")
    expect(section).toContain("max={BACKTEST_HOURS.max}")
    expect(section).toContain("step={BACKTEST_HOURS.step}")
    expect(section).toContain("useState<number>(BACKTEST_HOURS.default)")
    expect(section).toContain("useState<BacktestMode>(BACKTEST_DEFAULT_MODE)")
    expect(section).toContain('aria-label="Backtest mode"')
    expect(section).toContain('aria-label="Backtest execution"')
    expect(section).toContain("/api/connections/${encodeURIComponent(connectionId)}/backtest")
  })

  test("the statistics dialog has charts, a heatmap with a table view and the trades", () => {
    for (const marker of ["<LineChart", "<AreaChart", "<BarChart", 'TabsTrigger value="heatmap"', "Table view", "<TradesTable", 'TabsTrigger value="breakdown"']) {
      expect(stats).toContain(marker)
    }
    expect(stats).toContain("result.heatmapSymbolHour")
    expect(stats).toContain("result.heatmapTypeHour")
  })

  test("the route exposes start, status and cancel", () => {
    const route = source("app/api/connections/[id]/backtest/route.ts")
    expect(route).toContain("export async function POST")
    expect(route).toContain("export async function GET")
    expect(route).toContain("export async function DELETE")
  })

  test("client components import only the client-safe module (server modules broke the build)", () => {
    for (const file of [section, stats]) {
      expect(file).not.toMatch(/from "@\/lib\/connection-backtest"/)
      expect(file).not.toMatch(/from "@\/lib\/connection-backtest-jobs"/)
    }
    const settings = source("lib/connection-backtest-settings.ts")
    expect(settings.match(/^import (?!type )/gm)).toBeNull()
  })
})
