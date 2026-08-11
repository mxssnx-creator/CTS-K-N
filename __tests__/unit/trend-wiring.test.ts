import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), "utf8")

describe("Trend indication project wiring", () => {
  test("runs Trend last in both set-backed and realtime indication paths", () => {
    const sets = source("lib/indication-sets-processor.ts")
    const realtime = source("lib/trade-engine/indication-processor-fixed.ts")

    const optimalRun = sets.indexOf('{ type: "optimal", enabled: this.optimalEnabled, run: () => this.processOptimalSet(symbol, marketData) }')
    const activeRun = sets.indexOf('runType("active", () => this.processActiveSet(symbol, marketData))')
    const trendRun = sets.indexOf('runType("trend", () => this.processTrendSet(symbol, marketData))')
    expect(optimalRun).toBeGreaterThan(-1)
    expect(activeRun).toBeGreaterThan(optimalRun)
    expect(trendRun).toBeGreaterThan(activeRun)
    expect(sets).toContain("Active/Outbreak is an explicit completion barrier")
    expect(sets).toContain("Trend is intentionally the final completion barrier")
    expect(sets).toContain('await this.batchSaveIndications(pendingWrites, "trend")')
    expect(sets).toContain("(!hasExplicitPrices && hasCandles)")

    const autoPush = realtime.indexOf('type: "auto"')
    const activeBarrier = realtime.indexOf("indications.push(...deferredActiveIndications)")
    const trendPush = realtime.lastIndexOf('type: "trend"')
    expect(autoPush).toBeGreaterThan(-1)
    expect(activeBarrier).toBeGreaterThan(autoPush)
    expect(trendPush).toBeGreaterThan(activeBarrier)
    expect(realtime).toContain("oneMinuteClosesOldestFirst")
    expect(realtime).toContain("strongestByTimeframe")
    expect(realtime).toContain("for (const trendEvaluation of trendEvaluations)")
  })

  test("keeps each Trend window independent through Strategy and applies adaptive TP", () => {
    const strategy = source("lib/strategy-coordinator.ts")

    // The complete persisted indication configuration is the Strategy identity;
    // this is stronger than reassembling a parallel Trend-only suffix.
    expect(strategy).toContain("configurationIdentity")
    expect(strategy).toContain('encodeURIComponent(configurationIdentity || "default")')
    expect(strategy).toContain("ind.config?.tpFactors")
    expect(strategy).toContain("adaptiveTpFactors")
    expect(strategy).toContain("const adaptiveTrendTp")
    expect(strategy).toContain("adaptiveTrendTp ??")
    expect(strategy).toContain('group.indicationType === "trend" && adaptiveTpFactors.length > 0')
    const stateManager = source("lib/indication-state-manager.ts")
    expect(stateManager).toContain('type === "active_advanced"')
    expect(stateManager).toContain("positions_advanced:${this.connectionId}:${symbol}")
  })

  test("exposes independent Trend controls and adaptive TP defaults in Settings", () => {
    const ui = source("components/settings/tabs/indication-tab.tsx")
    const defaults = source("app/api/settings/route.ts")

    expect(ui.indexOf('<TabsTrigger value="trend">Trend</TabsTrigger>')).toBeGreaterThan(
      ui.indexOf('<TabsTrigger value="auto">Auto</TabsTrigger>'),
    )
    for (const field of [
      "trendTimeframesMinutes",
      "trendDrawdownValues",
      "trendLastSituationRatios",
      "trendActiveSituationRatios",
      "trendTpMinMultiplier",
      "trendTpMaxFactor",
      "trendTpStep",
    ]) {
      expect(ui).toContain(field)
      expect(defaults).toContain(field)
    }
  })

  test("persists Trend defaults through migration 074 and tracks it in progression", () => {
    const migrations = source("lib/redis-migrations.ts")
    const stats = source("app/api/connections/progression/[id]/stats/route.ts")
    const base = source("lib/base-pseudo-position-manager.ts")

    expect(migrations).toContain('version: 74')
    expect(migrations).toContain('name: "074-trend-indication-adaptive-base-ranges"')
    expect(migrations).toContain('"settings:app_settings"')
    expect(migrations).toContain('"settings:all_settings"')
    expect(stats).toContain('"auto", "signal", "trend"] as const')
    expect(stats).toContain('trend:          indCounts.trend')
    expect(base).toMatch(/"active_advanced"\s*\|\s*"signal"\s*\|\s*"trend"/)
    expect(base).toContain("active_situation_ratio")
    expect(base).toContain("getOrCreateEligibleBasePositions")
    expect(base).toContain("BASE_POSITION_MUTATION_QUEUES")
  })

  test("keeps Trend visible in connection controls and complete overview counters", () => {
    const activeRoute = source("app/api/settings/connections/[id]/active-indications/route.ts")
    const connectionCard = source("components/dashboard/connection-card.tsx")
    const quickStart = source("app/api/trade-engine/quick-start/route.ts")
    const detailedLogs = source("app/api/trade-engine/detailed-logs/route.ts")

    expect(activeRoute).toContain("trend:     main.trend.enabled")
    expect(connectionCard).toContain("checked={activeIndications.trend}")
    expect(quickStart).toContain("basePseudoTrend")
    expect(quickStart).toContain("dirInd + moveInd + actInd + actAdvInd + optInd + autoInd + signalInd + trendInd")
    expect(detailedLogs).toContain("acc.trend += item.indicationsByType.trend")
  })
})
