/**
 * Historic Test — per-family replay mechanics.
 *
 * Every family is derived from the SAME entry stream, so their results stay
 * comparable: only the exit rule, the sizing or the admission differs, which is
 * exactly how the families differ in the live engine. Deriving each family from
 * its own entry rule would make the ProfitFactors incomparable and the
 * comparison meaningless.
 *
 *   normal   — the entry stream unchanged: configured take-profit / stop-loss.
 *   trailing — same entries, trailing-stop exit: the stop follows the best
 *              price reached and the trade closes on the retrace.
 *   axis     — same entries, admission gated by the outcome sequence of the
 *              prior trades (the Position-Count window contract).
 *   block    — same entries, additive volume by block count. Each count is an
 *              INDEPENDENT config: count N is replayed on its own, with its own
 *              recovery-level lifecycle, and validated on its own result.
 *   dca      — the connection's DCA profile (multi-step accumulation).
 *
 * The block sizing and its recovery lifecycle come from the shared, verified
 * implementation the live lane uses, not from a copy.
 */
import blockVolume from "@/lib/block-volume-ratio.cjs"
import type { DcaBacktestCandle, DcaBacktestTrade } from "@/lib/dca-backtest"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

export interface FamilyReplayOptions {
  /** Round-trip cost in percent; results are expressed in these units. */
  positionCostPercent: number
  /** Trailing retrace from the best price, in percent of entry. */
  trailingRetracePct?: number
  /** Stop loss in percent of entry, shared with the entry stream. */
  stopLossPct?: number
  /** Axis window: how many prior trades are inspected. */
  axisWindow?: number
  /** Axis admission: how many of those must be positive. */
  axisMinPositive?: number
  /** Block volume ratio per count. */
  blockVolumeRatio?: number
  /** Block recovery levels (1..6). */
  blockIncrementSteps?: number
}

function pctToResultR(pct: number, positionCostPercent: number): number {
  const cost = Number(positionCostPercent) > 0 ? Number(positionCostPercent) : 0.1
  return Number((pct / cost).toFixed(12))
}

function asTrade(entryTime: number, exitTime: number, netPct: number, positionCostPercent: number): HistoricTestTrade {
  return {
    signedResultR: pctToResultR(netPct, positionCostPercent),
    openedAt: entryTime,
    closedAt: exitTime,
  }
}

/** The entry stream, unchanged: this is the `normal` family. */
export function replayNormal(
  trades: readonly DcaBacktestTrade[],
  options: FamilyReplayOptions,
): HistoricTestTrade[] {
  return trades.map((trade) =>
    asTrade(trade.entryTime, trade.exitTime, trade.pnlPctOfInitialNotional, options.positionCostPercent))
}

/**
 * Same entries, trailing-stop exit.
 *
 * The stop follows the best price reached since entry and the trade closes when
 * price retraces by `trailingRetracePct`. A candle that would hit both the
 * trailing stop and a new extreme is resolved pessimistically — the stop wins —
 * because intra-candle order is unknown and an optimistic reading would inflate
 * every trailing result.
 */
export function replayTrailing(
  candles: readonly DcaBacktestCandle[],
  trades: readonly DcaBacktestTrade[],
  options: FamilyReplayOptions,
): HistoricTestTrade[] {
  const retrace = Number(options.trailingRetracePct) > 0 ? Number(options.trailingRetracePct) : 0.4
  const stopLossPct = Number(options.stopLossPct) > 0 ? Number(options.stopLossPct) : 2.5
  const out: HistoricTestTrade[] = []

  for (const trade of trades) {
    const startIndex = candles.findIndex((candle) => candle.time >= trade.entryTime)
    if (startIndex < 0) continue
    const entry = Number(trade.initialEntryPrice) > 0 ? Number(trade.initialEntryPrice) : candles[startIndex].open
    if (!(entry > 0)) continue
    const long = trade.direction === "long"
    let best = entry
    let exitTime = candles[candles.length - 1].time
    let exitPrice = candles[candles.length - 1].close

    for (let i = startIndex; i < candles.length; i++) {
      const candle = candles[i]
      const hardStop = long ? entry * (1 - stopLossPct / 100) : entry * (1 + stopLossPct / 100)
      if (long ? candle.low <= hardStop : candle.high >= hardStop) {
        exitTime = candle.time
        exitPrice = hardStop
        break
      }
      const trailStop = long ? best * (1 - retrace / 100) : best * (1 + retrace / 100)
      // Pessimistic: the retrace is honoured before the new extreme.
      if (long ? candle.low <= trailStop : candle.high >= trailStop) {
        exitTime = candle.time
        exitPrice = trailStop
        break
      }
      best = long ? Math.max(best, candle.high) : Math.min(best, candle.low)
    }

    const grossPct = long
      ? ((exitPrice - entry) / entry) * 100
      : ((entry - exitPrice) / entry) * 100
    out.push(asTrade(trade.entryTime, exitTime, grossPct - options.positionCostPercent, options.positionCostPercent))
  }
  return out
}

/**
 * Same entries and exits, admission gated by the outcome sequence.
 *
 * The Position-Count contract asks whether the recent window of own results
 * justifies the next entry. An entry is taken only when at least
 * `axisMinPositive` of the last `axisWindow` own outcomes were positive; the
 * window is built from the trades this family actually took, never from trades
 * it declined, so the gate cannot be fed by results it never earned.
 */
export function replayAxis(
  trades: readonly DcaBacktestTrade[],
  options: FamilyReplayOptions,
): HistoricTestTrade[] {
  const window = Math.max(1, Math.floor(Number(options.axisWindow) || 4))
  const minPositive = Math.max(0, Math.floor(Number(options.axisMinPositive) ?? 1))
  const taken: HistoricTestTrade[] = []
  const outcomes: number[] = []

  for (const trade of trades) {
    const recent = outcomes.slice(-window)
    const positives = recent.filter((value) => value > 0).length
    // Before the window is full the gate cannot judge; the axis lane stays
    // open so it is not starved of the history it needs to become meaningful.
    const admitted = recent.length < window || positives >= minPositive
    const net = trade.pnlPctOfInitialNotional
    if (admitted) {
      taken.push(asTrade(trade.entryTime, trade.exitTime, net, options.positionCostPercent))
      outcomes.push(net)
    }
  }
  return taken
}

/**
 * One block count, replayed independently.
 *
 * Count N carries its own additive volume (`base × (1 + N × ratio × level)`)
 * and its own recovery lifecycle: the level rises while that count keeps
 * settling non-positive and resets on a positive result — exactly the live
 * contract, from the same shared implementation. A result scales with the size
 * actually carried, so a larger count amplifies both sides symmetrically and a
 * losing count can never look better for being bigger.
 */
export function replayBlockCount(
  trades: readonly DcaBacktestTrade[],
  blockCount: number,
  options: FamilyReplayOptions,
): HistoricTestTrade[] {
  const count = Math.max(1, Math.floor(Number(blockCount) || 1))
  const ratio = Number(options.blockVolumeRatio) > 0 ? Number(options.blockVolumeRatio) : 1
  const steps = blockVolume.normalizeBlockIncrementSteps(options.blockIncrementSteps)
  const out: HistoricTestTrade[] = []
  let lifecycle: Record<string, unknown> | undefined

  for (const trade of trades) {
    const level = Math.max(1, Math.floor(Number(lifecycle?.incrementStep) || 1))
    const multiplier = blockVolume.blockVolumeMultiplier(count, ratio, steps, level)
    const netPct = trade.pnlPctOfInitialNotional * (multiplier > 0 ? multiplier : 1)
    out.push(asTrade(trade.entryTime, trade.exitTime, netPct, options.positionCostPercent))
    lifecycle = blockVolume.advanceBlockCountLifecycle(lifecycle, {
      setKey: `historic#block:${count}`,
      symbol: "HISTORIC",
      direction: trade.direction,
      sourceKey: "historic",
      blockCount: count,
      incrementSteps: steps,
      executedIncrementStep: level,
      pauseCount: count,
      netPnl: netPct,
      updatedAt: trade.exitTime,
    })
  }
  return out
}
