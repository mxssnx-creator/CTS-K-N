import { getRedisClient } from "@/lib/redis-db"
import {
  baseMeasuredHistoryRejection,
  getPosWindowBatch,
  getPosWindowOverall,
  recordPosClosedBatch,
  type RecordPosClosedBatchEntry,
} from "@/lib/pos-history"

// A fresh database has no live closes. Base only qualifies from measured
// history, so the prehistoric per-type measurement books its closes into the
// exact buckets Base reads, pos_ring:{conn}:{symbol}:{indicationType}:{direction},
// each close into the bucket of the type that produced it.
const MIN_COUNT = 5

function prehistoricCloses(count: number, indicationType: string): RecordPosClosedBatchEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "BCHUSDT",
    indicationType,
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

  test("a generic strategy family label qualifies no Base type", async () => {
    const connectionId = `prefix-${Date.now()}-${Math.random()}`
    await write(connectionId, prehistoricCloses(12, "MA_Cross"))
    const rejections = await baseRejections(connectionId)
    expect(rejections.get("direction")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    expect(rejections.get("move")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
  })

  test("a type's measured closes qualify only that type; other types and Signal stay rejected", async () => {
    const connectionId = `fixed-${Date.now()}-${Math.random()}`
    await write(connectionId, [...prehistoricCloses(12, "direction"), ...prehistoricCloses(7, "move")])
    const rejections = await baseRejections(connectionId)
    expect(rejections.get("direction")).toBeNull()
    expect(rejections.get("move")).toBeNull()
    // No fan-out: Active was not measured, so its own bucket stays empty.
    expect(rejections.get("active")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    // Signal is realtime-only external consensus; replay never measures it.
    expect(rejections.get("signal")).toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    // Each bucket holds exactly its own closes.
    const windows = await getPosWindowBatch(connectionId, "BCHUSDT", [
      { indicationType: "direction", direction: "long" },
      { indicationType: "move", direction: "long" },
      { indicationType: "direction", direction: "short" },
    ], 25)
    expect(windows.get("direction|long")?.count).toBe(12)
    expect(windows.get("move|long")?.count).toBe(7)
    expect(baseMeasuredHistoryRejection(windows.get("direction|short"), MIN_COUNT))
      .toBe(`base_awaiting_measured_history: 0 < ${MIN_COUNT}`)
    // Too little history is still rejected.
    const thinConnection = `thin-${Date.now()}-${Math.random()}`
    await write(thinConnection, prehistoricCloses(MIN_COUNT - 1, "direction"))
    expect((await baseRejections(thinConnection)).get("direction"))
      .toBe(`base_awaiting_measured_history: ${MIN_COUNT - 1} < ${MIN_COUNT}`)
    // The connection rollup counts every close once.
    await expect(getPosWindowOverall(connectionId, 600)).resolves.toMatchObject({ count: 19 })
  })
})
