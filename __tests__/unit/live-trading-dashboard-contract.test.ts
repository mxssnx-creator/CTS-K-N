import { readFileSync } from "node:fs"
import { join } from "node:path"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("live trading dashboard release contract", () => {
  test("uses canonical server state and coordinated operator endpoints", () => {
    const page = source("app/live-trading/page.tsx")

    expect(page).toContain("/api/trading/live-positions?connection_id=")
    expect(page).toContain("/api/trading/trade-history?connection_id=")
    expect(page).toContain("/api/exchange/live-summary?connection_id=")
    expect(page).toContain("method: \"DELETE\"")
    expect(page).toContain("method: \"PATCH\"")
    expect(page).toContain("usePositionUpdates")
    expect(page).not.toContain("Math.random")
    expect(page).not.toContain("Start Simulation")
  })

  test("renders every requested compact overview window", () => {
    const overview = source("components/live-trading/live-overview-compact.tsx")

    for (const label of ["Balance", "Equity", "Margin", "Open positions", "Drawdown time · 5d"]) {
      expect(overview).toContain(label)
    }
    for (const window of ["4h", "12h", "24h", "48h", "25", "75", "150"]) {
      expect(overview).toContain(`\"${window}\"`)
    }
    expect(overview).toContain("1.00 = break-even")
  })

  test("provides per-position close, TP, SL, trailing and strategy restore controls", () => {
    const table = source("components/live-trading/live-position-table.tsx")

    expect(table).toContain("Active live positions")
    expect(table).toContain("Stop loss")
    expect(table).toContain("Take profit")
    expect(table).toContain("Trailing protection")
    expect(table).toContain("Restore strategy")
    expect(table).toContain("Confirm close")
  })

  test("provides detailed, pageable history filters and execution lineage", () => {
    const history = source("components/live-trading/trade-history-panel.tsx")

    for (const label of [
      "Time range",
      "Direction",
      "Result",
      "Source",
      "Strategy variant",
      "Execution",
      "Strategy lineage",
      "Risk settings",
      "Position detail",
    ]) {
      expect(history).toContain(label)
    }
    expect(history).toContain("pageSize = 50")
    expect(history).toContain("Last 48h")
  })

  test("ratchets manual trailing before quota and system-close early returns", () => {
    const liveStage = source("lib/trade-engine/stages/live-stage.ts")
    const updateStart = liveStage.indexOf("async function updateProtectionOrders(")
    const ratchet = liveStage.indexOf("if (ratchetManualTrailingStop(pos))", updateStart)
    const quota = liveStage.indexOf("if (isProtectionQuotaBlocked(pos.connectionId))", updateStart)
    const systemClose = liveStage.indexOf("const systemCloseOnly = await", updateStart)

    expect(updateStart).toBeGreaterThanOrEqual(0)
    expect(ratchet).toBeGreaterThan(updateStart)
    expect(ratchet).toBeLessThan(quota)
    expect(ratchet).toBeLessThan(systemClose)
  })
})
