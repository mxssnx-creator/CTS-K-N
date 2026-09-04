import fs from "node:fs"
import path from "node:path"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("connection card stage overview contract", () => {
  test("the stats route builds one coordinated cycle/open overview with real coverage", () => {
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    expect(route).toContain("buildConnectionStageOverview")
    expect(route).toContain("connectionStageOverview,")
    expect(route).toContain("totalOpen: strategyRows.base.totalOpen")
    expect(route).toContain("validOpen: strategyRows.base.validOpen")
    expect(route).toContain("breakdown: strategyRows.main.breakdown")
    expect(route).toContain("bySymbol: liveBySymbol")
    expect(route).toContain("positions: liveOrderRelations")
    expect(route).toContain("closedPositions: sharedClosedParsed")
    expect(route).toContain("summarizeStageRowCoverage")
    expect(route).toContain("expectedStageSymbolCount")
    expect(route).toContain("const useCross = freshSymbols > 0")
    expect(route).toContain("sumFreshStageRowField")
    expect(route).not.toContain("coverage.complete ? detail.length : 0")
    expect(route).toContain("const stageEvaluated = evaluation.evaluated")
    expect(route).toContain("symbolCount:       coverage.covered")
    expect(route).not.toContain("return samples > 0 ? total : n(hash[field] ?? hash[legacyField])")
    expect(route).toContain("engineRunning: !engineIsStopped")
    expect(route).toContain('semantics: "latest-cycle-and-current-open-row-snapshot"')
    expect(route).not.toContain("updatedAt: Date.now(),")
  })

  test("the card consumes the canonical stats snapshot once and clears prior connection state", () => {
    const card = read("components/dashboard/active-connection-card.tsx")

    expect(card).toContain("const [statsSnapshot, setStatsSnapshot]")
    expect(card).toContain("setStatsSnapshot(data)")
    expect(card).toContain("const rows = data.strategyRows || {}")
    expect(card).toContain("rows.base?.total ?? sd.base?.row_total")
    expect(card).toContain("stratBase:  nonNegativeMetric(rows.base?.total ?? strat.base)")
    expect(card).toContain("stratMain:  nonNegativeMetric(rows.main?.overall ?? strat.main)")
    expect(card).toContain("stratReal:  nonNegativeMetric(")
    expect(card).toContain("strat.realLogicalPassed ?? sd.real?.passed ?? rows.real?.valid ?? strat.real")
    expect(card).toContain("Current Coordinated Stage Sets &amp; Open Positions")
    expect(card).toContain('isLive ? "pos" : "Sets"')
    expect(card).toContain("Overall (all Sets)")
    expect(card).toContain("used at Real")
    expect(card).not.toContain("stratBase:  strat.base || 0")
    expect(card).not.toContain("stratMain:  strat.main || 0")
    expect(card).not.toContain("stratReal:  strat.real || 0")
    expect(card).toContain("progressionFetchSeqRef.current++")
    expect(card).toContain("setConnectionStageOverview(null)")
    expect(card).not.toContain('fetch(`/api/connections/progression/${connection.connectionId}/tracking/strategies`')
  })

  test("Main writer persists mutually exclusive open-lineage buckets", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    for (const field of [
      "row_overall_open_standard",
      "row_overall_open_trailing",
      "row_overall_open_position_count",
      "row_overall_open_block",
      "row_overall_open_dca",
    ]) {
      expect(coordinator).toContain(field)
    }
    expect(coordinator).toContain("countOpenMainBreakdown(mainSets, activeKeys)")
    expect(coordinator).toContain("resolveMainOpenAccounting(")
  })

  test("Real PF is snapshotted before Live execution and rendered on the card", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const card = read("components/dashboard/active-connection-card.tsx")

    expect(coordinator).toContain("netEffectivePF: set.avgProfitFactor")
    expect(liveStage).toContain("realProfitFactorAtEntry")
    expect(card).toContain('data-testid="connection-stage-overview"')
    expect(card).toContain("Stage Overview")
    expect(card).toContain("Latest completed cycle")
    expect(card).toContain("stageSnapshot.coverage.processed")
    expect(card).toContain("PF ≥")
    expect(card).toContain("placed/running")
    expect(card).toContain("Real ↔ Live PF")
    expect(card).toContain("Ratio <strong")
  })

  test("Base setting copy and engine share the 0.80 selectable floor", () => {
    const settings = read("components/settings/strategy/base-strategy-settings.tsx")
    const ratios = read("lib/main-trade-profit-factor.ts")
    expect(settings).toContain("selectable range 0.80–2.30 in 0.02 steps; default 0.80")
    expect(ratios).toContain("MAIN_TRADE_BASE_PF_RATIO_MIN = 0.8")
    expect(ratios).toContain("MAIN_TRADE_BASE_PF_RATIO_DEFAULT = 0.8")
  })
})
