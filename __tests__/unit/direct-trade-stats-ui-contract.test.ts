import fs from "node:fs"
import path from "node:path"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("Direct-Trade position/order statistics contract", () => {
  test("renders the scoped confirmed order count beside open positions", () => {
    const section = read("components/dashboard/direct-trade-section.tsx")
    const processor = read("scripts/direct-trade-processor.mjs")

    expect(section).toContain("Open: <strong>{openPositions}</strong>")
    expect(section).toContain("Confirmed fills: <strong data-testid=\"direct-trade-orders-count\">{stats.totalFilled.toLocaleString()}</strong>")
    expect(section).toContain("rejected or unconfirmed submissions are excluded")
    expect(section).toContain("Win/Loss/BE")
    expect(processor).toContain("stats.breakEvenCount = closed.length - stats.winCount - stats.lossCount")
    expect(processor).not.toContain("stats.lossCount = closed.length - stats.winCount")
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
    expect(status).toContain("buildDirectTradeIndicationTypeStats")
    expect(status).toContain("indicationTypeStats")
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

  test("renders live indication sliders and settled-versus-internal results in Performance Stats", () => {
    const section = read("components/dashboard/direct-trade-section.tsx")
    const settings = read("components/settings/direct-trade-settings.tsx")
    const processor = read("scripts/direct-trade-processor.mjs")

    expect(section).toContain("Live entry indication types")
    expect(section).toContain("All live entries blocked")
    expect(section).toContain("Indication types · results overview")
    expect(section).toContain("Realized PF")
    expect(section).toContain("PF coordinate")
    expect(section).toContain("Internal valid / eval")
    expect(section).toContain("Internal avg/set / PF")
    expect(section).toContain("row.internalAveragePnlPerSet")
    expect(section).toContain("Aggregate across")
    expect(section).not.toContain("{formatPnl(row.internalTotalPnl)} / {formatPF")
    expect(section).toContain("W / L / BE")
    expect(settings).toContain("enabledIndicationTypes")
    expect(settings).toContain("All sliders may be off")
    expect(processor).toContain("state.liveMode")
    expect(processor).toContain("normalizeEnabledIndicationTypes(state.enabledIndicationTypes, [])")
    expect(processor).toContain("entryTactic: config.entryTactic")
  })

  test("bounds close latency, identifies already-flat controls and reports lifecycle progress independently", () => {
    const processor = read("scripts/direct-trade-processor.mjs")
    const orderService = read("lib/live-order-service.ts")
    const status = read("app/api/trade-engine/direct-trade/status/route.ts")

    expect(orderService).toContain("isAlreadyClosedReduceOnlyError")
    expect(orderService).toContain("alreadyClosed: true")
    expect(processor).toContain("DIRECT_TRADE_MAX_LIVE_CLOSE_ACTIONS_PER_CYCLE = 1")
    expect(processor).toContain("DIRECT_TRADE_CONTROL_REQUEST_TIMEOUT_MS = 10_000")
    expect(processor).toContain("exchange_position_absent_pending")
    expect(processor).toContain("lifecycleCycleCount++")
    expect(status).toContain("processorRuntime.heartbeatHealthy")
    expect(status).toContain("processorRuntime.progressHealthy")
  })
})
