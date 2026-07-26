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
export const DEFAULT_POS_COUNT_VOLUME_RATIO = 0.05
export const MIN_POS_COUNT_VOLUME_RATIO = 0.01
export const MAX_POS_COUNT_VOLUME_RATIO = 0.25

// ────────────────────────────────────────────────────────────────────────────
// STRATEGY STAGE CONFIGURATION (Base, Main, Real)
// ────────────────────────────────────────────────────────────────────────────

// Global Stage Parameters (Applied to All Stages)
export const MIN_PROFIT_FACTOR = 2.2         // Min PF requirement (stage 2.2)
export const MAX_DRAWDOWN_TIME_MINUTES = 40  // Max drawdown time: 40 minutes
export const MAX_DRAWDOWN_TIME_MS = MAX_DRAWDOWN_TIME_MINUTES * 60 * 1000

// Stage 1 (Entry) - Base Position Generation
export const STAGE_1_MAX_LONG_POSITIONS = 12    // Max long positions
export const STAGE_1_MAX_SHORT_POSITIONS = 12   // Max short positions
export const STAGE_1_MAX_TOTAL_POSITIONS = 24   // Total concurrent (12L + 12S)

// Stage 2 (Main) - Primary Profit Stage
export const STAGE_2_MAX_LONG_POSITIONS = 25    // Primary profit-taking stage
export const STAGE_2_MAX_SHORT_POSITIONS = 25   // Near-full symbol coverage
export const STAGE_2_MAX_TOTAL_POSITIONS = 50   // Total concurrent (25L + 25S)

// Stage 2.2 (Quality Filter) - Min PF >= 2.2
export const STAGE_2_2_MAX_LONG_POSITIONS = 20  // Quality filter (PF >= 2.2)
export const STAGE_2_2_MAX_SHORT_POSITIONS = 20 // Conservative positions only
export const STAGE_2_2_MAX_TOTAL_POSITIONS = 40 // Total concurrent (20L + 20S)

// Stage 3 (Exit) - Full Exit Capacity
export const STAGE_3_MAX_LONG_POSITIONS = 30    // Full exit capacity for all symbols
export const STAGE_3_MAX_SHORT_POSITIONS = 30   // All 30 symbols + buffer
export const STAGE_3_MAX_TOTAL_POSITIONS = 60   // Total concurrent (30L + 30S)

// Risk Management Parameters (Applied to All Stages)
export const MAX_PORTFOLIO_DRAWDOWN_PCT = 25    // Max 25% portfolio drawdown (increased from 15%)
export const DAILY_LOSS_LIMIT_PCT = 20          // Max 20% daily loss (increased from 10%)
export const MIN_WIN_RATE_PCT = 40              // Min 40% win rate for entry (decreased from 50%)
export const MIN_SHARPE_RATIO = 1.0             // Min Sharpe ratio for main stage

// Stage-Specific Profit Factor Requirements (All Stages: Min 2.2)
export const STAGE_BASE_MIN_PF = 2.2            // Base stage: Min PF 2.2
export const STAGE_MAIN_MIN_PF = 2.2            // Main stage: Min PF 2.2
export const STAGE_REAL_MIN_PF = 2.2            // Real stage: Min PF 2.2
export const STAGE_LIVE_MIN_PF = 2.2            // Live stage: Min PF 2.2

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
    name: "Real (Min PF 2.2)",
    maxLong: STAGE_2_2_MAX_LONG_POSITIONS,
    maxShort: STAGE_2_2_MAX_SHORT_POSITIONS,
    total: STAGE_2_2_MAX_TOTAL_POSITIONS,
    minProfitFactor: STAGE_REAL_MIN_PF,
    purpose: "Real positions with PF >= 2.2",
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
