/**
 * Canonical Main Trade stage ratio contract.
 *
 * The operator-facing value is intentionally not the classic realised
 * gross-profit / gross-loss Profit Factor.  It is a PositionCost-relative
 * result ratio:
 *
 *   required move % = PositionCost % × (ratio / 0.10)
 *
 * Therefore, with the default PositionCost of 0.10 %, ratio 0.30 requires a
 * 0.30 % result.  Realised Profit Factor remains available separately from
 * `lib/profit-factor.ts`.
 */

export const MAIN_TRADE_PF_RATIO_MIN = 0.08
export const MAIN_TRADE_PF_RATIO_MAX = 2.7
export const MAIN_TRADE_PF_RATIO_STEP = 0.02
export const MAIN_TRADE_PF_RATIO_BASE = 0.1

export const MAIN_TRADE_BASE_PF_RATIO_MIN = 0.8
export const MAIN_TRADE_BASE_PF_RATIO_DEFAULT = 0.8
export const MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT = 1.12

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
 * Clamp and snap a stage ratio onto the exact 0.08 + n×0.02 grid.
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
 * PositionCost.  Example: PositionCost=0.10 %, ratio=0.30 -> 0.30 %.
 */
export function mainTradePfRatioToMovePct(
  ratio: unknown,
  positionCostPct: unknown,
): number {
  const cost = Math.max(0, finite(positionCostPct, 0))
  return round(
    cost *
      (normalizeMainTradePfRatio(ratio) / MAIN_TRADE_PF_RATIO_BASE),
  )
}

/**
 * Convert a signed percentage result back to the operator ratio scale.
 */
export function movePctToMainTradePfRatio(
  movePct: unknown,
  positionCostPct: unknown,
): number {
  const cost = finite(positionCostPct, 0)
  if (!(cost > 0)) return 0
  return round((finite(movePct, 0) / cost) * MAIN_TRADE_PF_RATIO_BASE)
}

export function mainTradePfRatioPasses(
  movePct: unknown,
  positionCostPct: unknown,
  minimumRatio: unknown,
): boolean {
  return movePctToMainTradePfRatio(movePct, positionCostPct) + Number.EPSILON >=
    normalizeMainTradePfRatio(minimumRatio)
}
