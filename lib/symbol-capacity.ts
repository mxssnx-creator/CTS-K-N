/** Shared capacity and concurrency contract for exchange-wide symbol baskets. */
export const EXCHANGE_SYMBOL_COUNT_MAX = 1_000
export const HIGH_SCALE_SYMBOL_THRESHOLD = 100
export const HIGH_SCALE_SYMBOL_STRESS_TARGET = 128
export const ATR_ENRICHMENT_MAX_SYMBOLS = 128
export const MARKET_DATA_REQUEST_CONCURRENCY = 8

export function clampExchangeSymbolCount(
  raw: unknown,
  fallback = 8,
  minimum = 1,
): number {
  const parsed = Number(raw)
  const fallbackParsed = Number(fallback)
  const candidate = Number.isFinite(parsed)
    ? parsed
    : Number.isFinite(fallbackParsed)
      ? fallbackParsed
      : minimum
  return Math.max(
    Math.max(1, Math.floor(minimum)),
    Math.min(EXCHANGE_SYMBOL_COUNT_MAX, Math.floor(candidate)),
  )
}

export function isHighScaleSymbolCount(raw: unknown): boolean {
  return clampExchangeSymbolCount(raw) >= HIGH_SCALE_SYMBOL_THRESHOLD
}

export function summarizeSymbols(symbols: readonly string[], visible = 12): string {
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || "").trim()).filter(Boolean))]
  const head = normalized.slice(0, Math.max(1, visible))
  const omitted = normalized.length - head.length
  return omitted > 0 ? `${head.join(", ")} … +${omitted}` : head.join(", ")
}

/** Compare symbol membership without sorting or serializing high-scale arrays. */
export function sameSymbolSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const members = new Set(left)
  return members.size === left.length && right.every((symbol) => members.has(symbol))
}
