// Volume factor for live exchange positions (scaling multiplier)
export const MIN_VOLUME_FACTOR = 0.1

// Volume step ratio system - ratio-based defaults
// Default ratio 1.0 = system internal baseline
// Live exchange volumes calculated by: base_notional * ratio
// Strategy internal calculations use higher ratios for optimization
export const DEFAULT_VOLUME_STEP_RATIO = 1.0  // System internal default ratio
export const MIN_VOLUME_STEP_RATIO = 0.2
export const MAX_VOLUME_STEP_RATIO = 1.8

// Volume calculation is ratio-based:
// - Ratio 1.0 (default): Base volume for live trading
// - Ratio > 1.0: Higher volume for strategy evaluations and optimizations
// - Ratio < 1.0: Lower volume for conservative testing
export const BASE_VOLUME_RATIO = 1.0  // Identity ratio - 1:1 with notional

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
export const MAX_PORTFOLIO_DRAWDOWN_PCT = 15    // Max 15% portfolio drawdown
export const DAILY_LOSS_LIMIT_PCT = 10          // Max 10% daily loss
export const MIN_WIN_RATE_PCT = 50              // Min 50% win rate for entry
export const MIN_SHARPE_RATIO = 1.0             // Min Sharpe ratio for main stage

// Stage Configuration Object (Convenient Reference)
export const STAGE_CONFIG = {
  stage1: {
    name: "Entry (Base)",
    maxLong: STAGE_1_MAX_LONG_POSITIONS,
    maxShort: STAGE_1_MAX_SHORT_POSITIONS,
    total: STAGE_1_MAX_TOTAL_POSITIONS,
    purpose: "Generate base positions from indications",
  },
  stage2: {
    name: "Main Profit",
    maxLong: STAGE_2_MAX_LONG_POSITIONS,
    maxShort: STAGE_2_MAX_SHORT_POSITIONS,
    total: STAGE_2_MAX_TOTAL_POSITIONS,
    purpose: "Primary profit-taking stage, near-full coverage",
  },
  stage2_2: {
    name: "Quality (Min PF 2.2)",
    maxLong: STAGE_2_2_MAX_LONG_POSITIONS,
    maxShort: STAGE_2_2_MAX_SHORT_POSITIONS,
    total: STAGE_2_2_MAX_TOTAL_POSITIONS,
    purpose: "Conservative positions with PF >= 2.2",
  },
  stage3: {
    name: "Exit",
    maxLong: STAGE_3_MAX_LONG_POSITIONS,
    maxShort: STAGE_3_MAX_SHORT_POSITIONS,
    total: STAGE_3_MAX_TOTAL_POSITIONS,
    purpose: "Full exit capacity for all symbols",
  },
  global: {
    minProfitFactor: MIN_PROFIT_FACTOR,
    maxDrawdownTimeMinutes: MAX_DRAWDOWN_TIME_MINUTES,
    maxPortfolioDrawdownPct: MAX_PORTFOLIO_DRAWDOWN_PCT,
    dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
    minWinRatePct: MIN_WIN_RATE_PCT,
    minSharpeRatio: MIN_SHARPE_RATIO,
  },
}
