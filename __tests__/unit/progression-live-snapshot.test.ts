import { overlayVolatileProgressionStats } from "@/lib/progression-live-snapshot"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("volatile progression stats overlay", () => {
  it("keeps realtime counters fresh while preserving the cached heavy projection", () => {
    const cached = {
      historic: { symbolsProcessed: 0, symbolsTotal: 32, cyclesCompleted: 0 },
      realtime: { cycleCounters: { indication: 0, strategy: 0, realtime: 0 } },
      mainCoordination: {
        activeVariants: ["default"],
        activeVariantCount: 1,
        totalCycles: 0,
        totalCreated: 0,
        totalReused: 0,
        positionContext: { continuous: 0, lastWins: 0, lastLosses: 0, prevLosses: 0, prevTotal: 0 },
      },
      metadata: { lastUpdate: "old" },
      connectionStageOverview: { base: { total: 99 } },
    }
    const result = overlayVolatileProgressionStats(cached, {
      progression: {
        indication_cycle_count: "7",
        strategy_cycle_count: "7",
        realtime_cycle_count: "7",
        strategies_main_active_variants: "default,trailing",
        strategies_main_active_variant_count: "2",
        strategies_main_cycles: "7",
        strategies_main_related_created: "11",
        strategies_main_related_reused: "4",
        strategies_main_ctx_continuous: "3",
        frames_processed: "21",
        last_activity_at: "1700000000000",
        phase: "prehistoric_data",
        progress: "46",
      },
      prehistoric: { symbols_processed: "3", symbols_selection_epoch: "new" },
      realtime: {},
      engineState: { symbol_selection_epoch: "new" },
      now: 1700000000100,
    })

    expect(result).toMatchObject({
      historic: { symbolsProcessed: 3, symbolsTotal: 32, progressPercent: 9 },
      realtime: {
        cycleCounters: { indication: 7, strategy: 7, realtime: 7 },
        framesProcessed: 21,
      },
      mainCoordination: {
        activeVariants: ["default", "trailing"],
        activeVariantCount: 2,
        totalCycles: 7,
        totalCreated: 11,
        totalReused: 4,
        reuseRate: 26.7,
        positionContext: { continuous: 3 },
      },
      connectionStageOverview: { base: { total: 99 } },
      metadata: { lastUpdate: "1700000000000", phase: "prehistoric_data", progress: 46 },
      phase: "prehistoric_data",
      progress: 46,
    })
    expect(cached.realtime.cycleCounters.indication).toBe(0)
  })

  it("rejects a stale historic numerator from a different selection epoch", () => {
    const result = overlayVolatileProgressionStats({
      historic: { symbolsProcessed: 32, symbolsTotal: 5 },
      realtime: { cycleCounters: {} },
    }, {
      progression: {},
      prehistoric: { symbols_processed: "32", symbol_selection_epoch: "old" },
      realtime: {},
      engineState: { symbol_selection_epoch: "new" },
    })

    expect(result).toMatchObject({
      historic: { symbolsProcessed: 0, symbolsTotal: 5, progressPercent: 0, isComplete: false },
    })
  })

  it("overlays real config-group progress and the cold-start protection loop", () => {
    const result = overlayVolatileProgressionStats({
      historic: {
        symbolsProcessed: 0,
        symbolsTotal: 32,
        progressPercent: 0,
        configWork: { completed: 0, total: 0, failed: 0 },
      },
      realtime: { cycleCounters: { livePositions: 0 } },
      metadata: {},
    }, {
      progression: {
        prehistoric_config_work_units_completed: "147",
        prehistoric_config_work_units_total: "320",
        prehistoric_config_work_failed_units: "2",
        prehistoric_config_work_current_symbol: "BTCUSDT",
        prehistoric_config_work_current_stage: "strategies",
        prehistoric_config_work_last_activity_at: "2026-08-21T12:00:00.000Z",
        live_positions_cycle_count: "9",
      },
      prehistoric: {
        symbols_processed: "0",
        symbol_selection_epoch: "active",
      },
      realtime: {},
      engineState: { symbol_selection_epoch: "active" },
    })

    expect(result).toMatchObject({
      historic: {
        symbolsProcessed: 0,
        progressPercent: 0,
        configWork: {
          completed: 147,
          total: 320,
          failed: 2,
          progressPercent: 46,
          currentSymbol: "BTCUSDT",
          currentStage: "strategies",
          lastActivityAt: "2026-08-21T12:00:00.000Z",
        },
      },
      realtime: { cycleCounters: { livePositions: 9 } },
      metadata: { lastUpdate: "2026-08-21T12:00:00.000Z" },
    })
  })

  it("keeps historic symbol progress independent from config-work progress", () => {
    const result = overlayVolatileProgressionStats({
      historic: {
        symbolsProcessed: 0,
        symbolsTotal: 32,
        configWork: { completed: 0, total: 0, failed: 0 },
      },
      realtime: { cycleCounters: {} },
      metadata: {},
    }, {
      progression: {
        prehistoric_config_work_units_completed: "275",
        prehistoric_config_work_units_total: "320",
      },
      prehistoric: {
        symbols_processed: "27",
        symbol_selection_epoch: "active",
      },
      realtime: {},
      engineState: { symbol_selection_epoch: "active" },
    })

    expect(result).toMatchObject({
      historic: {
        symbolsProcessed: 27,
        progressPercent: 84,
        configWork: { progressPercent: 86 },
      },
    })
  })

  it("keeps current stage rows and the card overview live during a stale heavy projection", () => {
    const now = 1_700_000_000_000
    const result = overlayVolatileProgressionStats({
      historic: { symbolsProcessed: 0, symbolsTotal: 1 },
      realtime: { cycleCounters: {} },
      strategyRows: {
        base: { total: 0, valid: 0, totalOpen: 0, validOpen: 0 },
        main: { valid: 0, overall: 0, validOpen: 0, overallOpen: 0, breakdown: {} },
        real: { valid: 0, evaluated: 0, active: 0, activeExactRows: 0 },
        live: { total: 0, mirrored: 0, active: 0 },
      },
      stageEvalPercent: { base: 0, main: 0, real: 0, live: 0 },
      connectionStageOverview: {
        base: { total: 0, valid: 0, pfMinimum: 1.1, validPercent: 0 },
        main: { valid: 0, overall: 0, additional: 0, expansionPercent: 0, breakdown: {} },
        real: { valid: 0, active: 0, activeExactSets: 0, activePercent: 0 },
        live: { total: 0, long: 0, short: 0, symbols: 0, orders: { placed: 0, running: 0 } },
        integrity: { valid: true, errors: [] },
      },
    }, {
      progression: {},
      prehistoric: {},
      realtime: {},
      engineState: {
        active_symbols: '["BTCUSDT"]',
        status: "running",
        last_processor_heartbeat: String(now - 1_000),
      },
      runningHint: "1",
      strategyDetails: {
        base: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_total": "4",
          "s:BTCUSDT:row_valid": "3",
          "s:BTCUSDT:row_total_open": "2",
          "s:BTCUSDT:row_valid_open": "1",
          // A removed symbol must not inflate the current basket.
          "s:ETHUSDT:ts": String(now - 1_000),
          "s:ETHUSDT:row_total": "99",
          "s:ETHUSDT:row_valid": "99",
        },
        main: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "1",
          "s:BTCUSDT:row_overall": "2",
          "s:BTCUSDT:row_valid_open": "1",
          "s:BTCUSDT:row_overall_open": "2",
          "s:BTCUSDT:row_overall_open_standard": "1",
          "s:BTCUSDT:row_overall_open_trailing": "1",
        },
        real: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "1",
          "s:BTCUSDT:row_real_evaluated": "2",
          "s:BTCUSDT:row_active": "1",
          "s:BTCUSDT:row_active_exact": "1",
        },
        live: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_total": "1",
          "s:BTCUSDT:row_mirrored": "1",
          "s:BTCUSDT:row_active": "1",
        },
      },
      now,
    })

    expect(result).toMatchObject({
      strategyRows: {
        base: { total: 4, valid: 3, totalOpen: 2, validOpen: 1 },
        main: { valid: 1, overall: 2, validOpen: 1, overallOpen: 2 },
        real: { valid: 1, evaluated: 2, active: 1, activeExactRows: 1 },
        live: { total: 1, mirrored: 1, active: 1 },
      },
      // Main evaluates the Base-valid pool (3), not the raw Base output (4).
      // The logical parent pass rate is therefore 1/3 = 33.3%.
      stageEvalPercent: { base: 75, main: 33.3, real: 50, live: 100 },
      connectionStageOverview: {
        base: { total: 2, valid: 1 },
        main: { valid: 1, overall: 2, additional: 1 },
        real: { valid: 1, active: 1, activeExactSets: 1 },
        integrity: { valid: true, errors: [] },
      },
    })
  })

  it("withholds partial symbol rows from global stage totals", () => {
    const now = 1_700_000_000_000
    const result = overlayVolatileProgressionStats({
      historic: { symbolsProcessed: 2, symbolsTotal: 2, isComplete: true },
      realtime: { cycleCounters: {} },
      strategyRows: {
        base: { total: 400, valid: 400, totalOpen: 0, validOpen: 0 },
        main: { valid: 400, overall: 800, validOpen: 0, overallOpen: 0, breakdown: {} },
        real: { valid: 700, evaluated: 700, active: 0, activeExactRows: 0 },
        live: { total: 700, mirrored: 700, active: 0 },
      },
      connectionStageOverview: {
        base: { total: 0, valid: 0, pfMinimum: 1.1, validPercent: 0 },
        main: { valid: 0, overall: 0, additional: 0, expansionPercent: 0, breakdown: {} },
        real: { valid: 0, active: 0, activeExactSets: 0, activePercent: 0 },
        live: { total: 0, long: 0, short: 0, symbols: 0, orders: { placed: 0, running: 0 } },
        integrity: { valid: true, errors: [] },
      },
    }, {
      progression: {},
      prehistoric: {},
      realtime: {},
      engineState: {
        active_symbols: '["BTCUSDT","ETHUSDT"]',
        status: "running",
      },
      runningHint: "1",
      strategyDetails: {
        base: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_total": "400",
          "s:BTCUSDT:row_valid": "400",
        },
        main: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "400",
          "s:BTCUSDT:row_overall": "800",
        },
        real: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "700",
          "s:BTCUSDT:row_real_evaluated": "700",
        },
        live: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_total": "700",
          "s:BTCUSDT:row_mirrored": "700",
        },
      },
      now,
    })

    expect(result).toMatchObject({
      strategyRows: {
        base: { total: 0, valid: 0 },
        main: { valid: 0, overall: 0 },
        real: { valid: 0, evaluated: 0 },
        live: { total: 0, mirrored: 0 },
        snapshot: { coverage: { processed: 1, total: 2, complete: false } },
      },
      connectionStageOverview: {
        snapshot: { coverage: { processed: 1, total: 2, complete: false } },
        latestCycle: {
          base: { total: 0, valid: 0 },
          main: { valid: 0, overall: 0 },
          real: { valid: 0, active: 0 },
          live: { total: 0, mirrored: 0 },
        },
      },
    })
  })

  it("clears cached current-open rows when Redis no longer proves runtime liveness", () => {
    const now = 1_700_000_000_000
    const result = overlayVolatileProgressionStats({
      historic: { symbolsProcessed: 1, symbolsTotal: 1, isComplete: true },
      realtime: { cycleCounters: {} },
      strategyRows: {},
      connectionStageOverview: {
        base: { total: 8, valid: 5 },
        main: { valid: 5, overall: 7, breakdown: {} },
        real: { valid: 4, active: 3, activeExactSets: 3 },
        integrity: { valid: true, errors: [] },
      },
    }, {
      progression: {},
      prehistoric: { symbols_processed: "1" },
      realtime: {},
      engineState: {
        active_symbols: '["BTCUSDT"]',
        status: "stopped",
        last_processor_heartbeat: String(now - 10 * 60_000),
      },
      runningHint: "0",
      strategyDetails: {
        base: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_total": "8",
          "s:BTCUSDT:row_valid": "5",
          "s:BTCUSDT:row_total_open": "8",
          "s:BTCUSDT:row_valid_open": "5",
        },
        main: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "5",
          "s:BTCUSDT:row_overall": "7",
          "s:BTCUSDT:row_valid_open": "5",
          "s:BTCUSDT:row_overall_open": "7",
        },
        real: {
          "s:BTCUSDT:ts": String(now - 1_000),
          "s:BTCUSDT:row_valid": "4",
          "s:BTCUSDT:row_active": "3",
          "s:BTCUSDT:row_active_exact": "3",
        },
      },
      now,
    })

    expect(result).toMatchObject({
      strategyRows: {
        base: { total: 8, valid: 5, totalOpen: 0, validOpen: 0 },
        main: { valid: 5, overall: 7, validOpen: 0, overallOpen: 0 },
        real: { valid: 4, active: 0, activeExactRows: 0 },
        snapshot: { engineRunning: false },
      },
      connectionStageOverview: {
        snapshot: { engineRunning: false, fresh: false },
        latestCycle: {
          base: { total: 8, valid: 5 },
          main: { valid: 5, overall: 7 },
          real: { valid: 4, active: 3, activeExactSets: 3 },
        },
        base: { total: 0, valid: 0 },
        main: { valid: 0, overall: 0 },
        real: { valid: 4, active: 0, activeExactSets: 0 },
      },
    })
  })

  it("prefers the current worker phase over a stale QuickStart recoordination marker", () => {
    const result = overlayVolatileProgressionStats({
      historic: { symbolsProcessed: 0, symbolsTotal: 32 },
      realtime: { cycleCounters: {} },
      metadata: { phase: "recoordination", progress: 0 },
    }, {
      progression: { phase: "recoordination", progress: "0" },
      prehistoric: { symbols_processed: "7" },
      realtime: {},
      engineState: {},
      engineProgression: {
        phase: "prehistoric_data",
        progress: "41",
        updated_at: "2026-08-21T12:01:00.000Z",
      },
    })

    expect(result).toMatchObject({
      phase: "prehistoric_data",
      progress: 41,
      metadata: {
        phase: "prehistoric_data",
        progress: 41,
        lastUpdate: "2026-08-21T12:01:00.000Z",
      },
    })
  })

  it("keeps settings acknowledgements volatile while the full stats projection is stale", () => {
    const statsRoute = readFileSync(
      join(process.cwd(), "app/api/connections/progression/[id]/stats/route.ts"),
      "utf8",
    )
    expect(statsRoute).toContain("overlaid.settingsRecoordination = buildSettingsRecoordinationState(progression)")
    expect(statsRoute).toContain("overlaid.statsRecalculation = buildStatsRecalculationState(progression)")
    expect(statsRoute).toContain("progressionHashes.reduce<Record<string, string>>")
    expect(statsRoute).toContain("return responseFromVolatileStatsSnapshot(cached.snapshot, request, connectionId)")
  })

  it("keeps the Live funnel numerator independent from the Real-stage numerator", () => {
    const statsRoute = readFileSync(
      join(process.cwd(), "app/api/connections/progression/[id]/stats/route.ts"),
      "utf8",
    )
    expect(statsRoute).toContain('suffix === "live:evaluated"')
    expect(statsRoute).toContain("stratEvaluated.live / real")
  })
})
