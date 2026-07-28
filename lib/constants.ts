import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
} from "./main-trade-profit-factor"
import {
  POS_COUNT_VOLUME_RATIO_DEFAULT,
  POS_COUNT_VOLUME_RATIO_MAX,
  POS_COUNT_VOLUME_RATIO_MIN,
} from "./pos-count-volume-ratio"

// Volume factor for live exchange positions (scaling multiplier)
export const MIN_VOLUME_FACTOR = 1
export const MAX_VOLUME_FACTOR = 10
export const BASE_VOLUME_RATIO = 1.0

/**
 * Base is the immutable coordination identity.
 *
 * The argument is intentionally accepted for compatibility with old settings
 * payloads and snapshots, but it can never influence pseudo-position or live
 * sizing. Explicit Main, Preset, Signal, Position-Count, DCA and Block factors
 * are applied by their own lanes.
 */
export function normalizeBaseVolumeFactor(_raw?: unknown): number {
  return BASE_VOLUME_RATIO
}

/**
 * Canonical shared/channel volume factor.
 *
 * Base, Main, Preset and Signal all use ratio 1 as their identity basis.
 * Sub-unit ratios belong only to explicitly independent adjustment lanes
 * (Position-Count, DCA and Block) and must never leak into these factors.
 */
export function normalizeIdentityVolumeFactor(
  raw: unknown,
  fallback = MIN_VOLUME_FACTOR,
): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed)) {
    return Math.max(MIN_VOLUME_FACTOR, Math.min(MAX_VOLUME_FACTOR, parsed))
  }
  const parsedFallback = Number(fallback)
  return Number.isFinite(parsedFallback)
    ? Math.max(MIN_VOLUME_FACTOR, Math.min(MAX_VOLUME_FACTOR, parsedFallback))
    : MIN_VOLUME_FACTOR
}

// Volume step ratio system - ratio-based defaults
// Default ratio 1.0 = system internal baseline
// Live exchange volumes calculated by: base_notional * ratio
// Strategy internal calculations use higher ratios for optimization
export const DEFAULT_VOLUME_STEP_RATIO = 1.0  // System internal default ratio
export const MIN_VOLUME_STEP_RATIO = 0.2
export const MAX_VOLUME_STEP_RATIO = 1.8

/** Independent balance-recalculation ratio; unlike shared channel factors,
 * this control is intentionally allowed below one. */
export function normalizeVolumeStepRatio(
  raw: unknown,
  fallback = DEFAULT_VOLUME_STEP_RATIO,
): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed)) {
    return Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, parsed))
  }
  const parsedFallback = Number(fallback)
  return Number.isFinite(parsedFallback)
    ? Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, parsedFallback))
    : DEFAULT_VOLUME_STEP_RATIO
}

// Volume calculation is ratio-based:
// - Ratio 1.0 (default): Base volume for live trading
// - Ratio > 1.0: Higher volume for strategy evaluations and optimizations
// - Ratio < 1.0: Reserved for explicit Position-Count/DCA variants only;
//   shared Base/channel factors normalize to identity 1.0
// Pos-count axis Set volume ratio (independent from Base volume)
export const DEFAULT_POS_COUNT_VOLUME_RATIO = POS_COUNT_VOLUME_RATIO_DEFAULT
export const MIN_POS_COUNT_VOLUME_RATIO = POS_COUNT_VOLUME_RATIO_MIN
export const MAX_POS_COUNT_VOLUME_RATIO = POS_COUNT_VOLUME_RATIO_MAX

// ────────────────────────────────────────────────────────────────────────────
// STRATEGY STAGE CONFIGURATION (Base, Main, Real)
// ────────────────────────────────────────────────────────────────────────────

// Legacy named exports now mirror the canonical Main-Trade settings instead
// of exposing a second, obsolete PF/cap contract. PF is the PositionCost-
// relative stage ratio, not classic gross-profit / gross-loss.
export const MIN_PROFIT_FACTOR = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT
export const MAX_DRAWDOWN_TIME_MINUTES = 240
export const MAX_DRAWDOWN_TIME_MS = MAX_DRAWDOWN_TIME_MINUTES * 60 * 1000

// A zero stage cap is the canonical persisted representation of Unlimited.
// Base and Main enumerate the complete configured Cartesian space; their only
// admission bound is one open Base pseudo-position per exact
// symbol × type/name × config × direction lane.
export const STAGE_1_MAX_LONG_POSITIONS = 0
export const STAGE_1_MAX_SHORT_POSITIONS = 0
export const STAGE_1_MAX_TOTAL_POSITIONS = 0

export const STAGE_2_MAX_LONG_POSITIONS = 0
export const STAGE_2_MAX_SHORT_POSITIONS = 0
export const STAGE_2_MAX_TOTAL_POSITIONS = 0

// Real and Live retain independent, operator-visible output safety ceilings.
export const STAGE_2_2_MAX_LONG_POSITIONS = 5_000
export const STAGE_2_2_MAX_SHORT_POSITIONS = 5_000
export const STAGE_2_2_MAX_TOTAL_POSITIONS = 5_000

export const STAGE_3_MAX_LONG_POSITIONS = 500
export const STAGE_3_MAX_SHORT_POSITIONS = 500
export const STAGE_3_MAX_TOTAL_POSITIONS = 500

// Risk Management Parameters (Applied to All Stages)
export const MAX_PORTFOLIO_DRAWDOWN_PCT = 25    // Max 25% portfolio drawdown (increased from 15%)
export const DAILY_LOSS_LIMIT_PCT = 20          // Max 20% daily loss (increased from 10%)
export const MIN_WIN_RATE_PCT = 40              // Min 40% win rate for entry (decreased from 50%)
export const MIN_SHARPE_RATIO = 1.0             // Min Sharpe ratio for main stage

// Main-Trade PositionCost-relative stage ratios. These are not realised PF.
export const STAGE_BASE_MIN_PF = MAIN_TRADE_BASE_PF_RATIO_DEFAULT
export const STAGE_MAIN_MIN_PF = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT
export const STAGE_REAL_MIN_PF = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT
export const STAGE_LIVE_MIN_PF = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT

// Stage Configuration Object (Convenient Reference)
export const STAGE_CONFIG = {
  stage1_base: {
    name: "Entry (Base)",
    maxLong: STAGE_1_MAX_LONG_POSITIONS,
    maxShort: STAGE_1_MAX_SHORT_POSITIONS,
    total: STAGE_1_MAX_TOTAL_POSITIONS,
    minProfitFactor: STAGE_BASE_MIN_PF,
    purpose: "Generate base positions from indications",
  },
  stage2_main: {
    name: "Main Profit",
    maxLong: STAGE_2_MAX_LONG_POSITIONS,
    maxShort: STAGE_2_MAX_SHORT_POSITIONS,
    total: STAGE_2_MAX_TOTAL_POSITIONS,
    minProfitFactor: STAGE_MAIN_MIN_PF,
    purpose: "Primary profit-taking stage, near-full coverage",
  },
  stage2_2_real: {
    name: "Real",
    maxLong: STAGE_2_2_MAX_LONG_POSITIONS,
    maxShort: STAGE_2_2_MAX_SHORT_POSITIONS,
    total: STAGE_2_2_MAX_TOTAL_POSITIONS,
    minProfitFactor: STAGE_REAL_MIN_PF,
    purpose: "Real rows that pass the configured cost-relative result and DDT gates",
  },
  stage3_live: {
    name: "Live (Exchange Orders)",
    maxLong: STAGE_3_MAX_LONG_POSITIONS,
    maxShort: STAGE_3_MAX_SHORT_POSITIONS,
    total: STAGE_3_MAX_TOTAL_POSITIONS,
    minProfitFactor: STAGE_LIVE_MIN_PF,
    purpose: "Live exchange orders, full exit capacity",
  },
  global: {
    minProfitFactor: MIN_PROFIT_FACTOR,
    stageBasePf: STAGE_BASE_MIN_PF,
    stageMainPf: STAGE_MAIN_MIN_PF,
    stageRealPf: STAGE_REAL_MIN_PF,
    stageLivePf: STAGE_LIVE_MIN_PF,
    maxDrawdownTimeMinutes: MAX_DRAWDOWN_TIME_MINUTES,
    maxPortfolioDrawdownPct: MAX_PORTFOLIO_DRAWDOWN_PCT,
    dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
    minWinRatePct: MIN_WIN_RATE_PCT,
    minSharpeRatio: MIN_SHARPE_RATIO,
  },
}
