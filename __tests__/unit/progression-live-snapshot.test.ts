import { overlayVolatileProgressionStats } from "@/lib/progression-live-snapshot"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("volatile progression stats overlay", () => {
  it("keeps realtime counters fresh while preserving the cached heavy projection", () => {
    const cached = {
      historic: { symbolsProcessed: 0, symbolsTotal: 32, cyclesCompleted: 0 },
      realtime: { cycleCounters: { indication: 0, strategy: 0, realtime: 0 } },
      metadata: { lastUpdate: "old" },
      connectionStageOverview: { base: { total: 99 } },
    }
    const result = overlayVolatileProgressionStats(cached, {
      progression: {
        indication_cycle_count: "7",
        strategy_cycle_count: "7",
        realtime_cycle_count: "7",
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
        progressPercent: 46,
        configWork: {
          completed: 147,
          total: 320,
          failed: 2,
          currentSymbol: "BTCUSDT",
          currentStage: "strategies",
          lastActivityAt: "2026-08-21T12:00:00.000Z",
        },
      },
      realtime: { cycleCounters: { livePositions: 9 } },
      metadata: { lastUpdate: "2026-08-21T12:00:00.000Z" },
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
})
