import { getRedisClient } from "@/lib/redis-db"
import {
  baseMeasuredHistoryRejection,
  getPosWindowBatch,
  recordPosClosedBatch,
  type RecordPosClosedBatchEntry,
} from "@/lib/pos-history"
import { selectBaseHistoryWindow } from "@/lib/strategy-coordinator"

/**
 * The Base gate must have measured data right after the prehistoric run:
 *  - a Set's own short ring never overrides a complete type bucket;
 *  - thin buckets are extended backwards over older real bars (capped), and
 *    those older closes land behind the newer ones in the ring;
 *  - the gate then decides on measured PF, not "awaiting history".
 */
const DAY = 24 * 3_600_000
const BEFORE = Date.UTC(2026, 9, 7, 0, 0)

jest.mock("@/lib/trade-engine/prehistoric-type-replay", () => {
  const actual = jest.requireActual("@/lib/trade-engine/prehistoric-type-replay")
  return {
    ...actual,
    // Two trend:long closes per replayed day; "optimal" never fires.
    replayDirectIndicationTypes: jest.fn(async (input: any) => ({
      closes: [0, 1].map((i) => ({
        type: "trend",
        direction: "long",
        rule: "r",
        entryTime: input.rangeStartMs + i * 3_600_000,
        exitTime: input.rangeStartMs + i * 3_600_000 + 600_000,
        entryPrice: 100,
        exitPrice: 99.4,
        takeProfitPct: 0.4,
        stopLossPct: 0.6,
        grossPct: -0.6,
        netPct: -0.86,
        positionCostPct: 0.1,
        holdMinutes: 10,
        reason: "stop_loss",
      })),
      open: [],
      openAtEnd: 0,
      lastBarMs: input.rangeEndMs,
      steps: 1,
      stepIndicatorCalls: 0,
    })),
  }
})

const closes = (n: number, pnl: number): RecordPosClosedBatchEntry[] =>
  Array.from({ length: n }, () => ({
    symbol: "BTCUSDT",
    indicationType: "trend",
    direction: "long" as const,
    pnl,
    pnlPct: pnl,
    positionCostPct: 0.1,
    drawdownMinutes: 3,
  }))

async function write(connectionId: string, entries: RecordPosClosedBatchEntry[], older = false) {
  const pipeline = getRedisClient().multi()
  recordPosClosedBatch({ connectionId, entries, pipeline, older })
  await pipeline.exec()
}

describe("selectBaseHistoryWindow", () => {
  const w = (count: number, ratioCount = count) => ({ count, positionCostRatioCount: ratioCount })

  it("a Set's own ring below the minimum does not override a complete type bucket", () => {
    const bucket = w(30)
    expect(selectBaseHistoryWindow(w(2), bucket, 5)).toBe(bucket)
  })

  it("the Set's own ring wins once it has the minimum", () => {
    const exact = w(5)
    expect(selectBaseHistoryWindow(exact, w(30), 5)).toBe(exact)
  })

  it("neither complete: the one with more measured closes reports progress", () => {
    const exact = w(3)
    expect(selectBaseHistoryWindow(exact, w(1), 5)).toBe(exact)
    const bucket = w(4)
    expect(selectBaseHistoryWindow(w(1), bucket, 5)).toBe(bucket)
    expect(selectBaseHistoryWindow(undefined, undefined, 5)).toBeUndefined()
  })

  it("is what createBaseSets uses", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
    expect(src).toContain("const posStats = selectBaseHistoryWindow(exactStats, legacyStats, prevPosMinCount)")
  })
})

describe("older closes append behind newer ones", () => {
  it("the measured window keeps reading the newest closes", async () => {
    const connectionId = `older-${Date.now()}-${Math.random()}`
    await write(connectionId, closes(3, 0.4))
    await write(connectionId, closes(4, -0.2), true)
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "trend", direction: "long" }], 3)
    expect(windows.get("trend|long")?.recentPnlPcts).toEqual([0.4, 0.4, 0.4])
    const all = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "trend", direction: "long" }], 25)
    expect(all.get("trend|long")?.count).toBe(7)
  })
})

describe("backfillTypeMeasurement", () => {
  const context = { positionCostPct: 0.1, indicationSettings: {} as any }

  it("extends a thin bucket day by day until the Base gate has its minimum", async () => {
    const { backfillTypeMeasurement } = await import("@/lib/trade-engine/type-measurement")
    const connectionId = `backfill-${Date.now()}-${Math.random()}`
    await write(connectionId, closes(1, 0.4))
    const loads: Array<[number, number]> = []
    const result = await backfillTypeMeasurement({
      connectionId,
      symbol: "BTCUSDT",
      types: ["trend"],
      beforeMs: BEFORE,
      minCount: 5,
      context,
      maxHours: 72,
      loadBars: async (startMs, endMs) => { loads.push([startMs, endMs]); return [{ timestamp: startMs }] },
    })
    // trend:long: 1 + 2 + 2 = 5 after two days; trend:short never fires.
    expect(result.counts["trend:long"]).toBe(5)
    expect(result.thin).toEqual(["trend:short"])
    // Causal: every load ends at or before the measured range start.
    expect(loads.every(([, end]) => end <= BEFORE)).toBe(true)
    expect(loads[1][1]).toBe(BEFORE - DAY)
    // The newest close (from the measured range) still leads the window.
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "trend", direction: "long" }], 25)
    const window = windows.get("trend|long")
    expect(window?.recentPnlPcts?.[0]).toBe(0.4)
    // The gate now judges on measured history.
    expect(baseMeasuredHistoryRejection(window, 5)).toBeNull()
  })

  it("stops at the cap and reports thin buckets instead of looping", async () => {
    const { backfillTypeMeasurement } = await import("@/lib/trade-engine/type-measurement")
    const connectionId = `backfill-cap-${Date.now()}-${Math.random()}`
    const result = await backfillTypeMeasurement({
      connectionId,
      symbol: "BTCUSDT",
      types: ["optimal"],
      beforeMs: BEFORE,
      minCount: 5,
      context,
      maxHours: 48,
      loadBars: async (startMs) => [{ timestamp: startMs }],
    })
    expect(result.hours).toBe(48)
    expect(result.thin.sort()).toEqual(["optimal:long", "optimal:short"])
  })

  it("is wired into the prehistoric measurement", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(process.cwd(), "lib/trade-engine/config-set-processor.ts"), "utf8")
    expect(src).toContain("const backfill = await backfillTypeMeasurement({")
    expect(src).toContain("type_measurement_status:")
  })
})
