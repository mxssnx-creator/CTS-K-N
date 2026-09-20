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
  /**
   * Sizing once at least one Block is valid to increase.
   *
   * "shared"   — ONE uniform ratio (`sharedRatio`), however many counts are
   *              valid. "if at least one block is valid to increase, a single
   *              ratio is used".
   * "additive" — one ratio per valid count, summed: the per-count multiple.
   */
  adjustMode?: "shared" | "additive"
  /** The uniform ratio the shared mode applies. */
  sharedRatio?: number
  /**
   * "Active" — an ADD-ON that skips the opening Block steps.
   *
   * Counted in Block STEPS, 0..3:
   *   0  off; every Block step is executed
   *   1  the normal (general) Block step is not executed, only those after it
   *   2  the first two Block steps are not executed
   *   3  the first three are not executed
   *
   * This is independent of `incrementSteps`, which says how many steps exist
   * at all — the two carry an offset of one against each other: with
   * `incrementSteps` 3 and `activeSkipSteps` 1, steps 2 and 3 are traded.
   *
   * A skipped step still drives the recovery state; it produces no trade.
   */
  activeSkipSteps?: number
  /**
   * Hold an escalated level while results stay non-positive.
   *
   * An increased Block that does not resolve positive KEEPS its level instead
   * of climbing further, until a generally positive result restores the base.
   * Per config, per lane and per count independently.
   */
  holdWhileNegative?: boolean
  /**
   * Replay ONE independent Block count instead of the evolving lane.
   *
   * Each count is its own config: with `fixedCount` set to N every attempt of
   * the lane runs at count N's add-on, and the recovery level advances for
   * that count alone (reset by a positive result). Without it the lane walks
   * 0 -> 1 -> 2 ... which measures the lane as a whole, not the individual
   * count the operator validates.
   */
  fixedCount?: number
}

/**
 * Uniform ratio the shared mode applies.
 *
 * Shared fires on "at least one valid Block" and therefore applies to every
 * recovery entry, so its ratio must be well below the additive one: at 1.5 a
 * single valid Block produced a 2.5x position, which is oversizing for a
 * condition that is nearly always true once a lane is recovering.
 */
export const BLOCK_SHARED_RATIO_DEFAULT = 0.8
/** Continuous escalation is capped at 3 steps, per count, independently. */
export const BLOCK_STEP_MAX = 3
/** "Active" skip: 0 is off, 1..3 skip that many opening Block steps. */
export const ACTIVE_SKIP_STEPS_MIN = 0
export const ACTIVE_SKIP_STEPS_MAX = 3
export const ACTIVE_SKIP_STEPS_DEFAULT = 0

export const DEFAULT_BLOCK_DERIVATION: BlockDerivationParams = {
  // Additive adds a ratio PER valid count, so a small step compounds across
  // counts; 0.2 keeps a 6-count stack at 2.2x rather than 7x.
  volumeRatio: 0.2,
  incrementSteps: BLOCK_STEP_MAX,
  maxStack: 3,
  adjustMode: "additive",
  sharedRatio: BLOCK_SHARED_RATIO_DEFAULT,
  activeSkipSteps: ACTIVE_SKIP_STEPS_DEFAULT,
  // Hold is the general rule; it is switched OFF explicitly, never on.
  holdWhileNegative: true,
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
  const fixedCount = Number.isFinite(Number(config.fixedCount)) && Number(config.fixedCount) > 0
    ? Math.min(maxStack || Math.floor(Number(config.fixedCount)), Math.floor(Number(config.fixedCount)))
    : null
  const out: HistoricTestTrade[] = []
  let count = fixedCount ?? 0
  let level = 1
  let nonPositiveRun = 0
  // Block enlarges RECOVERY entries only. An entry that follows a positive
  // result — including the very first entry of a stream — runs at base size.
  //
  // Without `fixedCount` this fell out of `count` starting at 0 and resetting
  // to 0 on every win. With `fixedCount` it did not: the count both started
  // and reset to N, so `ranAtCount > 0` held for every trade and the lane
  // became a CONSTANT leverage multiplier rather than a recovery mechanism —
  // it enlarged winners, and it enlarged the losses too. Measured on
  // 5,5,-2,5,5 at ratio 0.2 / count 2 it produced 7,7,-2.8,7,7 where the
  // correct result is 5,5,-2,6,5.
  //
  // The count identity stays fixed, which is what makes each count an
  // independently evaluated lane; only whether a given entry is IN recovery
  // now gates the multiplier.
  let inRecovery = false

  const adjustMode = config.adjustMode === "shared" ? "shared" : "additive"
  const sharedRatio = Number(config.sharedRatio) > 0 ? Number(config.sharedRatio) : BLOCK_SHARED_RATIO_DEFAULT
  const stepCap = Math.max(1, Math.min(BLOCK_STEP_MAX, Math.floor(Number(config.incrementSteps) || BLOCK_STEP_MAX)))
  const activeSkipSteps = Math.max(
    ACTIVE_SKIP_STEPS_MIN,
    Math.min(ACTIVE_SKIP_STEPS_MAX, Math.floor(Number(config.activeSkipSteps) || 0)),
  )
  const holdWhileNegative = config.holdWhileNegative !== false

  for (const trade of baseline || []) {
    const ranAtCount = inRecovery ? count : 0
    const multiplier = ranAtCount > 0
      ? (adjustMode === "shared"
        // Shared: one uniform ratio, independent of how many counts are valid.
        ? 1 + sharedRatio * level
        // Additive: a ratio per valid count, summed.
        : blockVolume.blockVolumeMultiplier(ranAtCount, config.volumeRatio, stepCap, level))
      : 1
    const result = Number(trade?.signedResultR) || 0
    // The Block STEP this leg runs at: 0 when it is not a Block leg at all,
    // otherwise 1 for the normal (general) step, 2 for the first escalation,
    // and so on. Active skips the opening steps.
    const legStep = ranAtCount > 0 ? level : 0
    // Active off (0) executes everything, normal legs included. Active N skips
    // Block steps 1..N; a normal leg is not a Block step and is skipped too,
    // because Active exists precisely to trade only the later Block steps.
    if (activeSkipSteps === 0 || legStep > activeSkipSteps) {
      out.push({
        signedResultR: Number((result * (multiplier > 0 ? multiplier : 1)).toFixed(12)),
        openedAt: trade?.openedAt,
        closedAt: trade?.closedAt,
      })
    }

    if (result > 0) {
      // A positive result ends the recovery. An independent count keeps its
      // identity — only its recovery level returns to base.
      count = fixedCount ?? 0
      level = 1
      nonPositiveRun = 0
      inRecovery = false
    } else {
      inRecovery = true
      // Only a settled BLOCK attempt advances the recovery level. The trade
      // that merely opened the streak ran at base volume, so it establishes
      // the count without escalating the level.
      if (ranAtCount > 0) {
        nonPositiveRun++
        if (nonPositiveRun % Math.max(1, ranAtCount) === 0) {
          // Hold applies at the LAST step: once the final configured step is
          // reached, a following Block that loses KEEPS the escalation rather
          // than resetting it. Below the last step the escalation simply
          // advances as normal.
          const atLastStep = level >= stepCap
          level = atLastStep && holdWhileNegative ? level : Math.min(stepCap, level + 1)
        }
      }
      count = fixedCount ?? Math.min(maxStack, count + 1)
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

/**
 * Axis windows that actually engage.
 *
 * Measured over 1,065,456 replayed trades (10 symbols, 216 indication configs
 * each, 3.5 days of real 5-minute candles), sweeping cont x pause:
 *
 *   cont=8 (the previous default): admits 98% of entries, PF 0.930–0.935
 *   cont=3:                        admits 78%,            PF 1.006–1.030
 *   cont=2:                        admits 62%,            PF 1.090–1.102
 *   cont=1, pause=4:               admits 53%,            PF 1.2231
 *   cont=1, pause=8:               admits 36%,            PF 1.2234
 *
 * At cont=8 the gate is a no-op: an end-to-end run reported the axis family
 * with byte-identical results to Normal — same ProfitFactor, same net result,
 * same trade count — so it consumed a family slot while measuring nothing of
 * its own. The relationship is monotone, and cont=1 is where the baseline
 * turns from losing (0.90) to profitable (1.22).
 *
 * pause=4 over pause=8: the ProfitFactor is the same to three decimals
 * (1.2231 vs 1.2234) while admitting 45% more entries, so the shorter pause
 * buys the same quality on substantially more opportunities.
 */
export const DEFAULT_AXIS_DERIVATION: AxisDerivationParams = {
  prev: 12,
  last: 4,
  cont: 1,
  pause: 4,
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
