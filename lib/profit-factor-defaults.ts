/**
 * Canonical fresh-install minimum for realised Profit Factor gates.
 *
 * This is intentionally separate from filters (where zero can mean "show
 * everything") and from Block/volume ratios. Persisted operator choices
 * remain valid; only missing seed values use this default.
 */
export const REALIZED_PROFIT_FACTOR_MIN_DEFAULT = 1.1
