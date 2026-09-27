import { getRedisClient } from "@/lib/redis-db"
import {
  baseMeasuredHistoryRejection,
  getPosWindowBatch,
  getPosWindowOverall,
  recordPosClosedBatch,
  type RecordPosClosedBatchEntry,
} from "@/lib/pos-history"
import {
  HISTORIC_POS_HISTORY_INDICATION_TYPES,
  STRATEGY_INDICATION_TYPES,
} from "@/lib/strategy-indication-policy"

// A fresh database has no live closes. Base only qualifies from measured
// history, so prehistoric closes must land in the exact buckets Base reads:
// pos_ring:{conn}:{symbol}:{indicationType}:{direction} with Base types.
const MIN_COUNT = 5

function prehistoricCloses(count: number, withBaseTypes: boolean): RecordPosClosedBatchEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "BCHUSDT",
    indicationType: "MA_Cross", // strategy family label from StrategyConfig.type
    ...(withBaseTypes && { indicationTypes: HISTORIC_POS_HISTORY_INDICATION_TYPES }),
    direction: "long" as const,
    pnl: i % 2 === 0 ? 0.4 : -0.2,
    pnlPct: i % 2 === 0 ? 0.4 : -0.2,
    positionCostPct: 0.1,
    drawdownMinutes: 2,
  }))
}

async function baseRejections(connectionId: string): Promise<Map<string, string | null>> {
  const pairs = ["direction", "move", "active", "signal"].map((indicationType) => ({
    indicationType,
    direction: "long" as const,
  }))
  const windows = await getPosWindowBatch(connectionId, "BCHUSDT", pairs, 25)
  return new Map(pairs.map((p) => [
    p.indicationType,
    baseMeasuredHistoryRejection(windows.get(`${p.indicationType}|long`), MIN_COUNT),
  ]))
}

async function write(connectionId: string, entries: RecordPosClosedBatchEntry[]) {
  const pipeline = getRedisClient().multi()
  recordPosClosedBatch({ connectionId, entries, pipeline })
  await pipeline.exec()
}

describe("Base measured-history bootstrap from prehistoric closes", () => {
  test("fresh DB: no history at all keeps every Base set rejected", async () => {
    const rejections = await baseRejections(`fresh-${Date.now()}-${Math.random()}`)
    for (const reason of rejections.values()) {
      expect(reason).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    }
  })

  test("pre-fix keying (strategy family label only) reproduces the deadlock", async () => {
    const connectionId = `prefix-${Date.now()}-${Math.random()}`
    await write(connectionId, prehistoricCloses(12, false))
    const rejections = await baseRejections(connectionId)
    expect(rejections.get("direction")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    expect(rejections.get("move")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
  })

  test("prehistoric closes keyed to Base buckets qualify Base; signal and empty buckets stay rejected", async () => {
    const connectionId = `fixed-${Date.now()}-${Math.random()}`
    await write(connectionId, prehistoricCloses(12, true))
    const rejections = await baseRejections(connectionId)
    expect(rejections.get("direction")).toBeNull()
    expect(rejections.get("move")).toBeNull()
    expect(rejections.get("active")).toBeNull()
    // Signal is realtime-only external consensus; replay never measures it.
    expect(rejections.get("signal")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    // Other symbols/directions without history remain gated.
    const shortWindows = await getPosWindowBatch(connectionId, "BCHUSDT", [
      { indicationType: "direction", direction: "short" },
    ])
    expect(baseMeasuredHistoryRejection(shortWindows.get("direction|short"), MIN_COUNT))
      .toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    // Too little history is still rejected.
    const thinConnection = `thin-${Date.now()}-${Math.random()}`
    await write(thinConnection, prehistoricCloses(MIN_COUNT - 1, true))
    expect((await baseRejections(thinConnection)).get("direction"))
      .toBe(`base_awaiting_measured_history: ${MIN_COUNT - 1} < ${MIN_COUNT}`)
    // Fan-out into type buckets does not inflate the connection rollup.
    await expect(getPosWindowOverall(connectionId, 600)).resolves.toMatchObject({ count: 12 })
  })

  test("historic buckets cover every Base type except realtime-only Signal", () => {
    expect([...HISTORIC_POS_HISTORY_INDICATION_TYPES].sort()).toEqual(
      STRATEGY_INDICATION_TYPES.filter((t) => t !== "signal").sort(),
    )
  })
})
