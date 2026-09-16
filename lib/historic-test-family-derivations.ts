/**
 * Historic Test — per-family derivations.
 *
 * Two families change the baseline replay in ways that are EXACTLY derivable
 * from its trade series, so they are computed here rather than being refused:
 *
 *   block — a Block count changes only the position VOLUME, never the entry or
 *           the exit. Each trade's result therefore scales by the multiplier
 *           its count carried at entry: base x (1 + count x ratio x level).
 *           The count follows the lane's real recovery rule — it rises while
 *           that lane keeps settling non-positive and resets to zero on a
 *           positive result — using the same shared block math the live engine
 *           uses, so the historic and live meaning cannot drift.
 *
 *   axis  — a Position-Count axis changes only WHICH entries are admitted,
 *           never their price path. Filtering the baseline series by the axis
 *           windows (prev/last/cont plus the pause that follows a trigger) is
 *           therefore the exact axis result, not an approximation.
 *
 * Trailing is not here on purpose: it replaces the exit rule, so it cannot be
 * derived from trades whose exits are already fixed. It needs a replay that
 * walks the price path, and inventing it from closed results would produce a
 * number that looks measured but is not.
 */
import blockVolume from "@/lib/block-volume-ratio.cjs"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

export interface BlockDerivationParams {
  /** Additive volume ratio per block count. */
  volumeRatio: number
  /** Operator recovery levels (1..6). */
  incrementSteps: number
  /** Highest count the lane may reach. */
  maxStack: number
}

export const DEFAULT_BLOCK_DERIVATION: BlockDerivationParams = {
  volumeRatio: 1,
  incrementSteps: 3,
  maxStack: 3,
}

/**
 * Scale each baseline trade by the Block volume multiplier its count carried.
 *
 * The first trade of a lane runs at count 0 — plain base volume — because a
 * Block add-on only exists after a settled non-positive result. That is why a
 * profitable baseline is not simply multiplied: Block amplifies recovery
 * attempts, so it magnifies losses that follow losses just as much as the
 * wins that end a streak.
 */
export function deriveBlockTrades(
  baseline: readonly HistoricTestTrade[],
  params: Partial<BlockDerivationParams> = {},
): HistoricTestTrade[] {
  const config = { ...DEFAULT_BLOCK_DERIVATION, ...params }
  const maxStack = Math.max(0, Math.floor(Number(config.maxStack) || 0))
  const out: HistoricTestTrade[] = []
  let count = 0
  let level = 1
  let nonPositiveRun = 0

  for (const trade of baseline || []) {
    const ranAtCount = count
    const multiplier = ranAtCount > 0
      ? blockVolume.blockVolumeMultiplier(ranAtCount, config.volumeRatio, config.incrementSteps, level)
      : 1
    const result = Number(trade?.signedResultR) || 0
    out.push({
      signedResultR: Number((result * (multiplier > 0 ? multiplier : 1)).toFixed(12)),
      openedAt: trade?.openedAt,
      closedAt: trade?.closedAt,
    })

    if (result > 0) {
      // A positive result ends the recovery: the lane returns to base volume.
      count = 0
      level = 1
      nonPositiveRun = 0
    } else {
      // Only a settled BLOCK attempt advances the recovery level. The trade
      // that merely opened the streak ran at base volume, so it establishes
      // the count without escalating the level.
      if (ranAtCount > 0) {
        nonPositiveRun++
        if (nonPositiveRun % Math.max(1, ranAtCount) === 0) {
          level = Math.min(Math.max(1, Math.floor(Number(config.incrementSteps) || 1)), level + 1)
        }
      }
      count = Math.min(maxStack, count + 1)
    }
  }
  return out
}

export interface AxisDerivationParams {
  /** Outcomes inspected for the admission decision. */
  prev: number
  /** Positive results required inside the `prev` window. */
  last: number
  /** Consecutive non-positive results that trigger a pause. */
  cont: number
  /** Entries skipped after a trigger. */
  pause: number
}

export const DEFAULT_AXIS_DERIVATION: AxisDerivationParams = {
  prev: 12,
  last: 4,
  cont: 8,
  pause: 8,
}

/**
 * Admit only the baseline entries the axis windows allow.
 *
 * The axis has no opinion before it has seen `prev` outcomes, so the leading
 * entries are admitted unchanged — gating on an unfilled window would silently
 * discard the start of every window and bias the result toward whatever
 * happened later.
 */
export function deriveAxisTrades(
  baseline: readonly HistoricTestTrade[],
  params: Partial<AxisDerivationParams> = {},
): HistoricTestTrade[] {
  const config = { ...DEFAULT_AXIS_DERIVATION, ...params }
  const prev = Math.max(1, Math.floor(Number(config.prev) || 1))
  const last = Math.max(0, Math.floor(Number(config.last) || 0))
  const cont = Math.max(1, Math.floor(Number(config.cont) || 1))
  const pause = Math.max(0, Math.floor(Number(config.pause) || 0))

  const admitted: HistoricTestTrade[] = []
  const outcomes: number[] = []
  let consecutiveNonPositive = 0
  let pauseRemaining = 0

  for (const trade of baseline || []) {
    const result = Number(trade?.signedResultR) || 0
    const windowFilled = outcomes.length >= prev

    let admit = true
    if (pauseRemaining > 0) {
      admit = false
      pauseRemaining--
    } else if (windowFilled) {
      const positives = outcomes.slice(-prev).filter((value) => value > 0).length
      admit = positives >= last
    }

    if (admit) admitted.push({ signedResultR: result, openedAt: trade?.openedAt, closedAt: trade?.closedAt })

    // The outcome history follows the market, not the admission decision: a
    // skipped entry still has an observable result in the baseline replay.
    outcomes.push(result)
    if (result > 0) consecutiveNonPositive = 0
    else {
      consecutiveNonPositive++
      if (consecutiveNonPositive >= cont) {
        pauseRemaining = pause
        consecutiveNonPositive = 0
      }
    }
  }
  return admitted
}
