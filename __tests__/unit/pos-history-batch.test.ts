import { getRedisClient } from "@/lib/redis-db"
import {
  getPosHistory,
  getPosHistoryOverall,
  getPosWindow,
  getPosWindowOverall,
  recordPosClosedBatch,
} from "@/lib/pos-history"

describe("recordPosClosedBatch", () => {
  test("preserves exact counter and newest-first rolling-window semantics with bounded commands", async () => {
    const connectionId = `pos-history-batch-${Date.now()}-${Math.random()}`
    const client = getRedisClient()
    const bucketHash = `pi_history:${connectionId}:BTCUSDT:trend:long`
    const bucketRing = `pos_ring:${connectionId}:BTCUSDT:trend:long`
    const overallHash = `pi_history:${connectionId}:_overall:_overall:_overall`
    const overallRing = `pos_ring:${connectionId}:_overall:_overall:_overall`

    try {
      await client.del(bucketHash, bucketRing, overallHash, overallRing)
      const pipeline = client.multi()
      recordPosClosedBatch({
        connectionId,
        entries: [
          {
            symbol: "BTCUSDT",
            indicationType: "trend",
            direction: "long",
            pnl: -0.2,
            pnlPct: -0.2,
            positionCostPct: 0.1,
            drawdownMinutes: 4.25,
          },
          {
            symbol: "BTCUSDT",
            indicationType: "trend",
            direction: "long",
            pnl: 0.6,
            pnlPct: 0.6,
            positionCostPct: 0.1,
            drawdownMinutes: 1.5,
          },
          {
            symbol: "ETHUSDT",
            indicationType: "trend",
            direction: "short",
            pnl: 0.4,
            pnlPct: 0.4,
            positionCostPct: 0.1,
            drawdownMinutes: 2,
          },
        ],
        pipeline,
      })
      await pipeline.exec()

      const bucketStats = await getPosHistory(connectionId, "BTCUSDT", "trend", "long", 2)
      expect(bucketStats).toMatchObject({ count: 2, hasSignal: true })
      expect(bucketStats.successRate).toBeCloseTo(0.5)
      // The original writer rounds each position before accumulating, so
      // 4.25 minutes is persisted as 4.3 minutes in the integer counter.
      expect(bucketStats.profitFactor).toBeCloseTo(3)
      expect(bucketStats.avgDDT).toBeCloseTo(2.9)

      const overallStats = await getPosHistoryOverall(connectionId, 3)
      expect(overallStats).toMatchObject({ count: 3, hasSignal: true })
      expect(overallStats.successRate).toBeCloseTo(2 / 3)
      expect(overallStats.profitFactor).toBeCloseTo(5)
      await expect(getPosWindow(connectionId, "BTCUSDT", "trend", "long", 2)).resolves.toMatchObject({
        count: 2,
        recentPnls: [0.6, -0.2],
        recentPnlPcts: [0.6, -0.2],
      })
      await expect(getPosWindowOverall(connectionId, 3)).resolves.toMatchObject({
        count: 3,
        recentPnls: [0.4, 0.6, -0.2],
      })

      // Four stable data structures (two bucket, two overall), with no key
      // or command proportional to the number of historic close rows.
      await expect(client.llen(bucketRing)).resolves.toBe(2)
      await expect(client.llen(overallRing)).resolves.toBe(3)
    } finally {
      await client.del(bucketHash, bucketRing, overallHash, overallRing)
    }
  })
})
