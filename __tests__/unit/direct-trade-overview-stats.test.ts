import {
  buildDirectTradeOverview48h,
  directTradeOverviewCategory,
} from "@/lib/direct-trade-overview-stats"

const NOW = Date.parse("2026-08-11T12:00:00.000Z")
const atHoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString()

function row(
  overview: ReturnType<typeof buildDirectTradeOverview48h>,
  mode: "simulated" | "exchange",
  category: "general" | "trailing" | "block" | "dca",
) {
  return overview.environments
    .find((environment) => environment.mode === mode)!
    .rows.find((entry) => entry.category === category)!
}

describe("Direct-Trade 48-hour overview", () => {
  test("separates environments and classifies General, Trailing, Block and DCA exactly once", () => {
    const positions = [
      { id: "open-old", status: "open", mode: "simulated", openedAt: atHoursAgo(80), strategyType: "standard" },
      { id: "trail", status: "closed", mode: "simulated", closedAt: atHoursAgo(2), strategyType: "trailing_fixed", pnl: 1, realizedPnlUsdt: 5 },
      { id: "block-open", status: "open", mode: "live", blockCount: 3, strategyType: "standard" },
      { id: "dca", status: "closed", mode: "live", closedAt: atHoursAgo(1), strategyType: "dca", blockCount: 4, pnl: 2, realizedPnlUsdt: 4 },
    ]

    const overview = buildDirectTradeOverview48h(positions, NOW)

    expect(row(overview, "simulated", "general")).toMatchObject({ open: 1, closed: 0 })
    expect(row(overview, "simulated", "trailing")).toMatchObject({ open: 0, closed: 1 })
    expect(row(overview, "exchange", "block")).toMatchObject({ open: 1, closed: 0 })
    expect(row(overview, "exchange", "dca")).toMatchObject({ open: 0, closed: 1 })
    expect(row(overview, "exchange", "general")).toMatchObject({ open: 0, closed: 0 })
    expect(directTradeOverviewCategory(positions[3])).toBe("dca")
  })

  test("counts a durable exchange opening as active without treating it as closed", () => {
    const overview = buildDirectTradeOverview48h([{
      id: "opening-live-dca",
      mode: "live",
      status: "opening",
      strategyType: "dca",
      openedAt: new Date(NOW - 5_000).toISOString(),
    }], NOW)

    expect(row(overview, "exchange", "dca")).toMatchObject({ open: 1, closed: 0 })
  })

  test("uses canonical summed profit factor and overall equity-curve drawdown duration", () => {
    const positions = [
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(6), pnl: 10, realizedPnlUsdt: 10 },
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(5), pnl: -2, realizedPnlUsdt: -2 },
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(4), pnl: -3, realizedPnlUsdt: -3 },
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(3), pnl: 6, realizedPnlUsdt: 6 },
    ]

    const general = row(buildDirectTradeOverview48h(positions, NOW), "simulated", "general")

    expect(general.closed).toBe(4)
    expect(general.profitFactor).toBe(3.2)
    expect(general.profitFactorInfinite).toBe(false)
    expect(general.pnlBasis).toBe("usdt")
    expect(general.netPnl).toBe(11)
    expect(general.averagePositionPnl).toBe(2.75)
    expect(general.overallDrawdownTimeMin).toBe(120)
    expect(general.maxDrawdownEpisodeMin).toBe(120)
    expect(general.currentDrawdownTimeMin).toBe(0)
  })

  test("keeps unfinished DDT running to now and excludes closes outside the exact window", () => {
    const positions = [
      { status: "closed", mode: "live", closedAt: atHoursAgo(50), pnl: 100, realizedPnlUsdt: 100 },
      { status: "closed", mode: "live", closedAt: atHoursAgo(4), pnl: 4, realizedPnlUsdt: 4 },
      { status: "closed", mode: "live", closedAt: atHoursAgo(1.5), pnl: -2, realizedPnlUsdt: -2 },
    ]

    const general = row(buildDirectTradeOverview48h(positions, NOW), "exchange", "general")

    expect(general.closed).toBe(2)
    expect(general.profitFactor).toBe(2)
    expect(general.overallDrawdownTimeMin).toBe(90)
    expect(general.maxDrawdownEpisodeMin).toBe(90)
    expect(general.currentDrawdownTimeMin).toBe(90)
  })

  test("falls back the complete bucket to percentages instead of mixing units", () => {
    const positions = [
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(2), pnl: 4, realizedPnlUsdt: 40 },
      { status: "closed", mode: "simulated", closedAt: atHoursAgo(1), pnl: -2 },
    ]

    const general = row(buildDirectTradeOverview48h(positions, NOW), "simulated", "general")

    expect(general.pnlBasis).toBe("percent")
    expect(general.grossProfit).toBe(4)
    expect(general.grossLoss).toBe(2)
    expect(general.profitFactor).toBe(2)
  })

  test("represents all-win PF as explicit infinity and empty PF as unavailable", () => {
    const overview = buildDirectTradeOverview48h([
      { status: "closed", mode: "live", closedAt: atHoursAgo(1), strategyType: "dca", pnl: 1, realizedPnlUsdt: 1 },
    ], NOW)

    expect(row(overview, "exchange", "dca")).toMatchObject({
      profitFactor: null,
      profitFactorInfinite: true,
    })
    expect(row(overview, "exchange", "general")).toMatchObject({
      profitFactor: null,
      profitFactorInfinite: false,
    })
  })
})
