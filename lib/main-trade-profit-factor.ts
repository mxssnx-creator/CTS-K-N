/**
 * Canonical Main Trade stage ratio contract.
 *
 * The operator-facing value is intentionally not the classic realised
 * gross-profit / gross-loss Profit Factor.  It is a PositionCost-relative
 * result ratio:
 *
 *   required net move % = PositionCost % × ((ratio - 1.00) / 0.10)
 *
 * Inputs are cost-adjusted first: one PositionCost is subtracted from a gross
 * price move. The neutral value is therefore 1.00: gross move = one
 * PositionCost, net result = 0. Each 0.10 adds one further PositionCost, so
 * 1.10 means gross = 2× cost, 1.20 = 3× cost, and 1.30 = 4× cost.
 * Realised Profit Factor remains available separately from `lib/profit-factor.ts`.
 *
 * This coordinate is deliberately not an accounting sign.  Code which needs
 * a win/loss decision must use signed net PnL (or signed Result-R), never a
 * naked `profitFactor < 1` comparison from a mixed legacy payload.
 */

export const MAIN_TRADE_PF_RATIO_MIN = 1.0
export const MAIN_TRADE_PF_RATIO_MAX = 2.2
// One tenth of the operator ratio is exactly one additional PositionCost.
// Keeping the control on that grid prevents half-cost thresholds such as 1.05
// from being rendered as a misleading "double cost" setting.
export const MAIN_TRADE_PF_RATIO_STEP = 0.1
export const MAIN_TRADE_PF_RATIO_BASE = 1.0
export const MAIN_TRADE_PF_RATIO_MOVE_SCALE = 0.1
/**
 * Canonical minimum for every Previous/Last-position quality check.
 *
 * This is deliberately independent from the Base/Main/Real/Live promotion
 * thresholds below. With PositionCost 0.10%, ratio 1.30 means the rolling
 * realised market move must average at least 0.30% (3 × PositionCost).
 */
export const PREVIOUS_POSITION_MIN_PF_RATIO = 1.1

// Base is exhaustive, but the separate Base Valid row remains meaningful in
// the neutral domain: 1.00 means no result remains after one PositionCost.
// Positive gate tuning is an explicit operator setting, not an implicit
// stricter floor on hot reload.
export const MAIN_TRADE_BASE_PF_RATIO_MIN = 1.0
export const MAIN_TRADE_BASE_PF_RATIO_DEFAULT = 1.1
export const MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT = 1.1

export type MainTradeStage = "base" | "main" | "real" | "live"

export const MAIN_TRADE_STAGE_PF_DEFAULTS: Readonly<Record<MainTradeStage, number>> = {
  base: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  main: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  real: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  live: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/**
 * Clamp and snap a stage ratio onto the exact 1.00 + n×0.10 grid.
 */
export function normalizeMainTradePfRatio(
  value: unknown,
  fallback = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
): number {
  const safeFallback = Math.max(
    MAIN_TRADE_PF_RATIO_MIN,
    Math.min(MAIN_TRADE_PF_RATIO_MAX, finite(fallback, MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT)),
  )
  const clamped = Math.max(
    MAIN_TRADE_PF_RATIO_MIN,
    Math.min(MAIN_TRADE_PF_RATIO_MAX, finite(value, safeFallback)),
  )
  // Decimal binary representation can place an exact operator midpoint such
  // as 1.15 infinitesimally below 1.5. Use a tiny unit-free epsilon so the
  // documented half-up grid is stable without changing genuine values below
  // a grid midpoint.
  const steps = Math.round(
    (clamped - MAIN_TRADE_PF_RATIO_MIN) / MAIN_TRADE_PF_RATIO_STEP + 1e-9,
  )
  return round(Math.min(
    MAIN_TRADE_PF_RATIO_MAX,
    MAIN_TRADE_PF_RATIO_MIN + steps * MAIN_TRADE_PF_RATIO_STEP,
  ), 2)
}

export function mainTradeStagePfDefault(stage: MainTradeStage): number {
  return MAIN_TRADE_STAGE_PF_DEFAULTS[stage]
}

export function mainTradeStagePfMin(stage: MainTradeStage): number {
  return stage === "base"
    ? MAIN_TRADE_BASE_PF_RATIO_MIN
    : MAIN_TRADE_PF_RATIO_MIN
}

export function normalizeMainTradeStagePfRatio(
  stage: MainTradeStage,
  value: unknown,
): number {
  return Math.max(
    mainTradeStagePfMin(stage),
    normalizeMainTradePfRatio(value, mainTradeStagePfDefault(stage)),
  )
}

/**
 * Convert an operator ratio into the net percentage result required after one
 * PositionCost has been deducted. Example: PositionCost=0.10%, ratio=1.10
 * requires net +0.10%, i.e. a gross +0.20% price move.
 */
export function mainTradePfRatioToMovePct(
  ratio: unknown,
  positionCostPct: unknown,
): number {
  const cost = Math.max(0, finite(positionCostPct, 0))
  // This is a pure math conversion, not a configured-setting normalization.
  // The neutral base ratio (1.00, net result 0 after cost) must convert to
  // exactly 0%, not be pulled up to a configured positive setting.
  return round(cost * mainTradePfRatioToSignedResultR(ratio))
}

/**
 * Convert a Main-stage coordinate into the gross market move that must be
 * reserved by an order before the configured PositionCost is deducted.
 *
 * This is intentionally distinct from a classic gross-profit/gross-loss PF:
 * with PositionCost=0.10%, ratio 1.00 maps to a 0.10% gross move (neutral
 * after costs), and ratio 1.10 maps to 0.20% (one positive cost unit after
 * costs). Execution callers may add only venue buffers that are not already
 * represented by PositionCost.
 */
export function mainTradePfRatioToGrossMovePct(
  ratio: unknown,
  positionCostPct: unknown,
): number {
  const cost = Math.max(0, finite(positionCostPct, 0))
  return round(cost + mainTradePfRatioToMovePct(ratio, cost))
}

/**
 * Convert a Main-stage coordinate into a signed net PositionCost multiple.
 *
 * This conversion intentionally does not clamp: historic diagnostics may be
 * below the configured floor and callers need to retain that information.
 * `0` is the neutral Result-R value; it is not a negative result.
 */
export function mainTradePfRatioToSignedResultR(ratio: unknown): number {
  return round(
    (finite(ratio, MAIN_TRADE_PF_RATIO_BASE) - MAIN_TRADE_PF_RATIO_BASE) /
      MAIN_TRADE_PF_RATIO_MOVE_SCALE,
  )
}

/**
 * Convert a signed net Result-R value into the Main-stage coordinate.
 * Result-R 0 maps to the neutral coordinate 1.00; +1 maps to 1.10.
 */
export function signedResultRToMainTradePfRatio(signedResultR: unknown): number {
  return round(
    MAIN_TRADE_PF_RATIO_BASE +
      finite(signedResultR, 0) * MAIN_TRADE_PF_RATIO_MOVE_SCALE,
  )
}

/**
 * Convert a signed percentage result back to the operator ratio scale.
 * Zero move is neutral at 1.00; every PositionCost adds 0.10 PF.
 */
export function movePctToMainTradePfRatio(
  movePct: unknown,
  positionCostPct: unknown,
): number {
  const cost = finite(positionCostPct, 0)
  if (!(cost > 0)) return MAIN_TRADE_PF_RATIO_BASE
  return signedResultRToMainTradePfRatio(finite(movePct, 0) / cost)
}

/** Deduct one PositionCost from a signed gross price move exactly once. */
export function netMovePctAfterPositionCost(
  grossMovePct: unknown,
  positionCostPct: unknown,
): number {
  const gross = finite(grossMovePct, 0)
  const cost = Math.max(0, finite(positionCostPct, 0))
  return round(gross - cost)
}

export function mainTradePfRatioPasses(
  movePct: unknown,
  positionCostPct: unknown,
  minimumRatio: unknown,
): boolean {
  return movePctToMainTradePfRatio(movePct, positionCostPct) + Number.EPSILON >=
    normalizeMainTradePfRatio(minimumRatio)
}
