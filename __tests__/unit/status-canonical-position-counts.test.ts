import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("engine status position/trade counts use the canonical execution summary", () => {
  const status = read("app/api/trade-engine/status/route.ts")

  test("status no longer reads the unmaintained positions:<id> / trades:<id> sets (they always read 0)", () => {
    expect(status).not.toContain("`positions:${conn.id}`")
    expect(status).not.toContain("`trades:${conn.id}`")
    expect(status).not.toMatch(/scard\(positionsKey\)|scard\(tradesKey\)/)
  })

  test("status derives positions, trades, open positions and open orders from getLiveExecutionSummary", () => {
    expect(status).toContain('import { getLiveExecutionSummary } from "@/lib/live-execution-summary"')
    expect(status).toContain("getLiveExecutionSummary(conn.id)")
    for (const field of ["totalPositions", "totalTrades", "openPositions", "openOrders"]) {
      expect(status).toContain(`executionSummary?.${field}`)
    }
    expect(status).toContain("totalOpenPositions: connectionStatuses.reduce")
    expect(status).toContain("totalOpenOrders: connectionStatuses.reduce")
  })

  test("positions/stats and tracking/overview read the same summary, so all three surfaces agree", () => {
    expect(read("app/api/positions/stats/route.ts")).toContain("getLiveExecutionSummary")
    expect(read("app/api/tracking/overview/route.ts")).toContain("getLiveExecutionSummary(connection.id)")
  })

  test("dashboard 'active positions' prefers the open-position total over the lifetime total", () => {
    const controls = read("components/dashboard/global-trade-engine-controls.tsx")
    expect(controls).toContain("data.summary?.totalOpenPositions || data.summary?.totalPositions")
  })
})

describe("engine-progress aggregate is process-independent", () => {
  test("the no-connectionId listing enumerates canonical connections instead of only the in-process registry", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/engine-progress/route.ts"), "utf8")
    expect(route).toContain("getActiveConnectionsForEngine")
    expect(route).toContain("new Set<string>([...allManagers.keys(), ...canonical.map")
    expect(route).toContain("realtimeRotation: await rotationProgress(id, engineType)")
  })
})

// The functional overview's stage figures are the last-observed per-symbol
// basket snapshot (rows retained up to 24 h with explicit freshness), not
// "this cycle" counts; the former labels misdescribed them.
describe("overview panels label snapshot counters distinctly from cumulative counters", () => {
  test("QuickStart summary marks strategy funnel sizes as basket snapshots", () => {
    const ui = readFileSync(resolve(process.cwd(), "components/dashboard/quick-start-button.tsx"), "utf8")
    expect(ui).toContain("Strategies Evaluated (basket snapshot):")
    expect(ui).toContain("Sets (basket snapshot):")
    expect(ui).not.toContain("(this cycle)")
    expect(ui).toContain("Indication Cycles (since engine start):")
    expect(ui).toContain("Strategy Cycles (since engine start):")
  })

  test("seed dialog no longer shows the indication cycle count under two different labels", () => {
    const ui = readFileSync(resolve(process.cwd(), "components/dashboard/seed-system-dialog.tsx"), "utf8")
    expect(ui).toContain("Evaluations (basket snapshot)")
    expect(ui).toContain("{fmt(stats.data.strategyCycles)}")
    expect(ui).toContain('<div className="text-xs text-muted-foreground">Strategy Cycles (since start)</div>')
    expect(ui).toContain('<div className="text-xs text-muted-foreground">Indication Cycles (since start)</div>')
    expect(ui).not.toContain('>Evaluations</div>')
  })
})
