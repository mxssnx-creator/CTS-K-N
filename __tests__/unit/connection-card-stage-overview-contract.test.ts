import fs from "node:fs"
import path from "node:path"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("connection card stage overview contract", () => {
  test("the stats route builds one coordinated current-open overview", () => {
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    expect(route).toContain("buildConnectionStageOverview")
    expect(route).toContain("connectionStageOverview,")
    expect(route).toContain("totalOpen: strategyRows.base.totalOpen")
    expect(route).toContain("validOpen: strategyRows.base.validOpen")
    expect(route).toContain("breakdown: strategyRows.main.breakdown")
    expect(route).toContain("bySymbol: liveBySymbol")
    expect(route).toContain("positions: liveOrderRelations")
    expect(route).toContain("closedPositions: sharedClosedParsed")
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
    expect(coordinator).toContain("mainSetHasOpenLineage(s, activeKeys)")
    expect(coordinator).toContain("countOpenMainBreakdown(mainSets, activeKeys)")
  })

  test("Real PF is snapshotted before Live execution and rendered on the card", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const card = read("components/dashboard/active-connection-card.tsx")

    expect(coordinator).toContain("netEffectivePF: set.avgProfitFactor")
    expect(liveStage).toContain("realProfitFactorAtEntry")
    expect(card).toContain('data-testid="connection-stage-overview"')
    expect(card).toContain("Stage Overview")
    expect(card).toContain("PF ≥")
    expect(card).toContain("placed/running")
    expect(card).toContain("Real ↔ Live PF")
    expect(card).toContain("Ratio <strong")
  })

  test("Base setting copy and engine share the 1.10 minimum", () => {
    const settings = read("components/settings/strategy/base-strategy-settings.tsx")
    const ratios = read("lib/main-trade-profit-factor.ts")
    expect(settings).toContain("minimum 1.10, default 1.15; range 1.10–2.20")
    expect(ratios).toContain("MAIN_TRADE_BASE_PF_RATIO_MIN = 1.1")
    expect(ratios).toContain("MAIN_TRADE_BASE_PF_RATIO_DEFAULT = 1.15")
  })
})
