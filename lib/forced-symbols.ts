/** Canonical mandatory trading basket shared by every processing lane. */
export const CANONICAL_FORCED_BASE_SYMBOLS = ["BTC", "SOL", "BCH", "XRP"] as const
export const CANONICAL_FORCED_SYMBOLS = CANONICAL_FORCED_BASE_SYMBOLS.map(
  (symbol) => `${symbol}USDT`,
) as readonly string[]

function normalizeSymbol(value: unknown): string | null {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s/_-]/g, "")
  if (!compact || !/^[A-Z0-9]{2,36}$/.test(compact)) return null
  return compact.endsWith("USDT") ? compact : `${compact}USDT`
}

/**
 * Put the mandatory quartet first, then retain every valid operator/dynamic
 * symbol exactly once. Optional caps can limit additional symbols but can
 * never remove BTC, SOL, BCH, or XRP.
 */
export function withCanonicalForcedSymbols(
  values: unknown,
  requestedMaximum = Number.POSITIVE_INFINITY,
): string[] {
  const input = Array.isArray(values) ? values : values == null ? [] : [values]
  const normalized = input
    .map(normalizeSymbol)
    .filter((symbol): symbol is string => symbol !== null)
  const combined = Array.from(new Set([...CANONICAL_FORCED_SYMBOLS, ...normalized]))
  const parsedMaximum = Number(requestedMaximum)
  if (!Number.isFinite(parsedMaximum)) return combined
  const maximum = Math.max(
    CANONICAL_FORCED_SYMBOLS.length,
    Math.floor(parsedMaximum),
  )
  return combined.slice(0, maximum)
}

export function canonicalForcedBaseSymbols(): string[] {
  return [...CANONICAL_FORCED_BASE_SYMBOLS]
}

export function canonicalForcedSymbols(): string[] {
  return [...CANONICAL_FORCED_SYMBOLS]
}
