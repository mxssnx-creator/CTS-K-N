/**
 * One explicit basket limit for every Direct-Trade entry point. Keeping this
 * here prevents the UI, configuration route, and calculation route from
 * silently evaluating different symbol universes.
 */
import { CANONICAL_FORCED_SYMBOLS } from "@/lib/forced-symbols"
import {
  EXCHANGE_SYMBOL_COUNT_MAX,
  clampExchangeSymbolCount,
} from "@/lib/symbol-capacity"

export const DIRECT_TRADE_MAX_SYMBOLS = EXCHANGE_SYMBOL_COUNT_MAX
export const DIRECT_TRADE_MIN_SYMBOLS = CANONICAL_FORCED_SYMBOLS.length

// Direct-Trade capacity is intentionally defined once.  The dashboard,
// Settings page, API defaults, headless processor and simulation reports must
// admit the same basket before the global active-position ceiling is applied.
// One hundred is the shipped operating target; 300 remains an explicit hard
// upper bound for operators that intentionally provision a larger basket.
export const DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS = 100
export const DIRECT_TRADE_MAX_TOTAL_POSITIONS = 300
export const DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL = 12
export const DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION = 6

// Direct-Trade sizing is deliberately independent from PositionCost and from
// Block/DCA accumulation ratios. The factor controls the requested base
// notional; exchange quantity/notional rules are applied later at submission.
export const DIRECT_TRADE_VOLUME_FACTOR_MIN = 0.1
export const DIRECT_TRADE_VOLUME_FACTOR_MAX = 10
export const DIRECT_TRADE_VOLUME_FACTOR_DEFAULT = 0.1
// Economic base request before the factor and the global 0.2 reduction. The
// connector remains authoritative for a larger venue minimum.
export const DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT = 5
// Keep the operator-facing factor grid unchanged while reducing the effective
// requested notional systemwide. A configured factor of 1.0 therefore requests
// the old 0.2× amount; venue minimums may still raise the final executable lot.
export const DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO = 0.2

export function clampDirectTradeVolumeFactor(
  value: unknown,
  fallback = DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
): number {
  const parsed = Number(value)
  const candidate = Number.isFinite(parsed) ? parsed : fallback
  const bounded = Math.max(
    DIRECT_TRADE_VOLUME_FACTOR_MIN,
    Math.min(DIRECT_TRADE_VOLUME_FACTOR_MAX, candidate),
  )
  return Number((Math.round(bounded * 10) / 10).toFixed(1))
}

export function clampDirectTradeSymbolCount(value: unknown, fallback = 8): number {
  return clampExchangeSymbolCount(
    value,
    fallback,
    DIRECT_TRADE_MIN_SYMBOLS,
  )
}
