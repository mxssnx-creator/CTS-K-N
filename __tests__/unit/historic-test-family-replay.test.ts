import { runHistoricTest } from "@/lib/historic-test-runner"
import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"
import { combinationKeyOf } from "@/lib/historic-test-scoring"
import {
  replayAxis,
  replayBlockCount,
  replayNormal,
  replayTrailing,
} from "@/lib/historic-test-family-replay"

const opts = { positionCostPercent: 0.1 }
const entryTrade = (netPct: number, t = 1_000) => ({
  direction: "long" as const, entryTime: t, exitTime: t + 60_000, exitReason: "tp" as const,
  initialEntryPrice: 100, averageEntryPrice: 100, exitPrice: 100 * (1 + netPct / 100),
  volumeRatio: 1, dcaSteps: 1, pnlPctOfInitialNotional: netPct, holdTimeMin: 1,
  drawdownTimeMin: 0, maxAdversePnlPct: 0,
})

describe("per-family replay shares one entry stream", () => {
  test("normal is the entry stream expressed in PositionCost units", () => {
    const out = replayNormal([entryTrade(0.3), entryTrade(-0.2)], opts)
    expect(out.map((t) => t.signedResultR)).toEqual([3, -2])
    expect(out[0].openedAt).toBe(1_000)
  })

  test("trailing resolves an ambiguous candle pessimistically", () => {
    // Price runs up then retraces past the trail: the stop must win over the extreme.
    const candles = [
      { time: 1_000, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 2_000, open: 100, high: 110, low: 100, close: 110, volume: 1 },
      { time: 3_000, open: 110, high: 120, low: 104, close: 106, volume: 1 },
    ]
    const out = replayTrailing(candles, [entryTrade(5)], { ...opts, trailingRetracePct: 4, stopLossPct: 20 })
    expect(out).toHaveLength(1)
    // Best 110, trail 4% -> 105.6; the candle low 104 triggers it.
    expect(out[0].signedResultR).toBeCloseTo(((105.6 - 100) / 100 * 100 - 0.1) / 0.1, 6)
    expect(out[0].closedAt).toBe(3_000)
  })

  test("axis gates on its OWN outcome sequence and stays open until the window fills", () => {
    const trades = [entryTrade(-1, 1), entryTrade(-1, 2), entryTrade(-1, 3), entryTrade(-1, 4), entryTrade(2, 5)]
    const out = replayAxis(trades, { ...opts, axisWindow: 3, axisMinPositive: 1 })
    // First 3 are admitted (window not full); afterwards the window holds only
    // losses, so the lane closes and later entries are declined.
    expect(out).toHaveLength(3)
    expect(out.every((t) => t.signedResultR < 0)).toBe(true)
  })

  test("each block count is replayed independently with its own additive size", () => {
    const trades = [entryTrade(0.2), entryTrade(0.2)]
    const one = replayBlockCount(trades, 1, { ...opts, blockVolumeRatio: 1, blockIncrementSteps: 3 })
    const three = replayBlockCount(trades, 3, { ...opts, blockVolumeRatio: 1, blockIncrementSteps: 3 })
    // count 1 -> x2, count 3 -> x4 of the base result (level 1, ratio 1).
    expect(one[0].signedResultR).toBeCloseTo(4, 6)
    expect(three[0].signedResultR).toBeCloseTo(8, 6)
  })

  test("a losing block count is amplified too — size never flatters a loser", () => {
    const losing = [entryTrade(-0.2)]
    const one = replayBlockCount(losing, 1, { ...opts, blockVolumeRatio: 1 })
    const three = replayBlockCount(losing, 3, { ...opts, blockVolumeRatio: 1 })
    expect(one[0].signedResultR).toBeLessThan(0)
    expect(three[0].signedResultR).toBeLessThan(one[0].signedResultR)
  })

  test("block counts are validated as separate configs in a run", async () => {
    const result = await runHistoricTest({
      connectionId: "c1",
      settings: normalizeHistoricTestSettings({ enabled: true, symbolCount: 1, minProfitFactor: 1.2, strategies: { normal: false, trailing: false, axis: false, dca: false } }),
      rankedSymbols: ["BTCUSDT"],
      indications: ["momentum"],
      familyVariants: { block: ["count1", "count2", "count3"] },
      // count2 loses, the others win: only the winners may validate.
      simulate: async (req) => req.variant === "count2" ? [{ signedResultR: -3 }] : [{ signedResultR: 3 }],
      now: 1_800_000_000_000,
    })
    expect(result.scores).toHaveLength(3)
    expect(result.validatedKeys).toEqual([
      "BTCUSDT|momentum|block|count1",
      "BTCUSDT|momentum|block|count3",
    ])
    expect(combinationKeyOf({ symbol: "b", indication: "i", family: "block", variant: "count2" }))
      .toBe("B|i|block|count2")
  })
})
