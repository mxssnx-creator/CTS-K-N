/**
 * One explicit basket limit for every Direct-Trade entry point. Keeping this
 * here prevents the UI, configuration route, and calculation route from
 * silently evaluating different symbol universes.
 */
export const DIRECT_TRADE_MAX_SYMBOLS = 32

// Direct-Trade capacity is intentionally defined once.  The dashboard,
// Settings page, API defaults, headless processor and simulation reports must
// admit the same basket before the global 300-position ceiling is applied.
export const DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL = 12
export const DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION = 6

export function clampDirectTradeSymbolCount(value: unknown, fallback = 8): number {
  const parsed = Number(value)
  const candidate = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(
    DIRECT_TRADE_MAX_SYMBOLS,
    Math.max(1, Math.floor(candidate)),
  )
}
