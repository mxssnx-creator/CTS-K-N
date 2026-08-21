import { overlayVolatileProgressionStats } from "@/lib/progression-live-snapshot"

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
      metadata: { lastUpdate: "1700000000000" },
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
})
