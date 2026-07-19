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
