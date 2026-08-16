/**
 * Canonical Main Trade stage ratio contract.
 *
 * The operator-facing value is intentionally not the classic realised
 * gross-profit / gross-loss Profit Factor.  It is a PositionCost-relative
 * result ratio:
 *
 *   required move % = PositionCost % × ((ratio - 1.00) / 0.10)
 *
 * The neutral value is 1.00: no move above PositionCost. Each 0.10 of PF
 * represents one additional PositionCost of positive move, so 1.10 means one
 * PositionCost, 1.30 means three PositionCosts, and 2.20 means twelve.
 * Realised Profit Factor remains available separately from `lib/profit-factor.ts`.
 */

export const MAIN_TRADE_PF_RATIO_MIN = 1.05
export const MAIN_TRADE_PF_RATIO_MAX = 2.2
export const MAIN_TRADE_PF_RATIO_STEP = 0.05
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

// Base is exhaustive, but the separate Base Valid row is intentionally
// meaningful: a complete Set must clear at least 0.80 before it can enter the
// Main funnel. Keeping the coded minimum equal to the default prevents an old
// 0.40 value from silently weakening the stage on a hot reload.
export const MAIN_TRADE_BASE_PF_RATIO_MIN = 1.1
export const MAIN_TRADE_BASE_PF_RATIO_DEFAULT = 1.15
export const MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT = 1.15

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
 * Clamp and snap a stage ratio onto the exact 1.05 + n×0.05 grid.
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
  const steps = Math.round(
    (clamped - MAIN_TRADE_PF_RATIO_MIN) / MAIN_TRADE_PF_RATIO_STEP,
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
 * Convert an operator ratio into the percentage move required for the current
 * PositionCost. Example: PositionCost=0.10 %, ratio=1.30 -> 0.30 %.
 */
export function mainTradePfRatioToMovePct(
  ratio: unknown,
  positionCostPct: unknown,
): number {
  const cost = Math.max(0, finite(positionCostPct, 0))
  const normalized = normalizeMainTradePfRatio(ratio)
  return round(cost * ((normalized - MAIN_TRADE_PF_RATIO_BASE) / MAIN_TRADE_PF_RATIO_MOVE_SCALE))
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
  return round(MAIN_TRADE_PF_RATIO_BASE +
    (finite(movePct, 0) / cost) * MAIN_TRADE_PF_RATIO_MOVE_SCALE)
}

export function mainTradePfRatioPasses(
  movePct: unknown,
  positionCostPct: unknown,
  minimumRatio: unknown,
): boolean {
  return movePctToMainTradePfRatio(movePct, positionCostPct) + Number.EPSILON >=
    normalizeMainTradePfRatio(minimumRatio)
}
