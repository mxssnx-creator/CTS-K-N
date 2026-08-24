import fs from "node:fs"
import path from "node:path"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("Direct-Trade position/order statistics contract", () => {
  test("renders the scoped confirmed order count beside open positions", () => {
    const section = read("components/dashboard/direct-trade-section.tsx")

    expect(section).toContain("Open: <strong>{openPositions}</strong>")
    expect(section).toContain("Orders: <strong data-testid=\"direct-trade-orders-count\">{stats.totalOrders.toLocaleString()}</strong>")
    expect(section).toContain("Confirmed Direct-Trade entry, Block and DCA order fills in this connection scope")
  })

  test("keeps Direct-Trade positions, orders and PF from the same connection scope", () => {
    const status = read("app/api/trade-engine/direct-trade/status/route.ts")
    const overview = read("lib/direct-trade-overview-stats.ts")

    expect(status).toContain("const keys = directTradeKeyspace(connectionId)")
    expect(status).toContain("stats: responseStats")
    expect(status).toContain("openPositions: openPositions.length")
    expect(status).toContain("closedPositions: closedPositions.length")
    expect(status).toContain("accountingPending")
    expect(status).toContain("processorHeartbeatRaw")
    expect(status).toContain("const overview48h = buildDirectTradeOverview48h(positions, now)")
    expect(overview).toContain('(["simulated", "exchange"] as DirectTradeOverviewMode[])')
  })

  test("labels combinatorial histories as variants and separates exchange accounting", () => {
    const section = read("components/dashboard/direct-trade-section.tsx")
    const statistics = read("components/statistics/direct-trade-statistics.tsx")
    const logistics = read("app/logistics/page.tsx")

    expect(section).toContain("configuration variants indexed")
    expect(section).toContain("Accounting pending")
    expect(statistics).toContain("Evaluated variants")
    expect(statistics).toContain("Realized exchange PnL")
    expect(statistics).toContain("Exchange accounting pending")
    expect(logistics).toContain("configuration variants")
  })
})
