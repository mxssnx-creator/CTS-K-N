import {
  CANONICAL_FORCED_SYMBOLS,
  withCanonicalForcedSymbols,
} from "@/lib/forced-symbols"
import { normalizeForexSymbol } from "@/lib/forex-market"
import { normalizeMarketType, type MarketType } from "@/lib/market-types"

const SYMBOL_ALIAS_FIELDS = [
  "force_symbols",
  "selected_symbols",
  "active_symbols",
  "symbols",
] as const

function parseSymbolAlias(value: unknown): string[] {
  const normalize = (values: unknown[]) =>
    Array.from(new Set(
      values
        .map((symbol) => String(symbol).trim().toUpperCase())
        .filter(Boolean),
    ))
  if (Array.isArray(value)) return normalize(value)
  if (typeof value !== "string" || !value.trim()) return []
  try {
    const decoded = JSON.parse(value)
    if (Array.isArray(decoded)) return normalize(decoded)
  } catch {
    // Legacy comma/newline/pipe-separated values remain accepted.
  }
  return normalize(value.split(/[\n,|]/))
}

function explicitlyClearsForcedSymbols(patch: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(patch, "force_symbols")) return false
  const value = patch.force_symbols
  return (Array.isArray(value) && value.length === 0)
    || (typeof value === "string" && value.trim() === "")
}

/**
 * Keep every persisted symbol alias on one canonical basket.
 *
 * `force_symbols` is the engine's durable operator intent and therefore wins
 * over stale `selected_symbols` snapshots. The requested count is a total
 * basket ceiling, so adding the mandatory quartet can never turn a 32-symbol
 * UI selection into 36 runtime symbols. Forex pairs remain six-character
 * broker symbols and never inherit crypto quote assets.
 */
export function normalizeSymbolAliasesInPatch(
  patch: Record<string, unknown>,
  market: { marketType?: unknown; exchange?: unknown } = {},
): Record<string, unknown> {
  if (explicitlyClearsForcedSymbols(patch)) {
    return {
      ...patch,
      force_symbols: "",
      selected_symbols: "",
      active_symbols: "",
      symbols: "",
    }
  }

  const candidate = SYMBOL_ALIAS_FIELDS
    .map((field) => parseSymbolAlias(patch[field]))
    .find((symbols) => symbols.length > 0)
  if (!candidate) return patch

  const configuredCount = Number(patch.symbol_count)
  const requestedMaximum = Number.isFinite(configuredCount) && configuredCount > 0
    ? Math.floor(configuredCount)
    : Math.max(CANONICAL_FORCED_SYMBOLS.length, candidate.length)
  const marketType: MarketType = normalizeMarketType(
    market.marketType ?? patch.market_type ?? patch.asset_class,
    market.exchange ?? patch.exchange,
  )
  const symbols = marketType === "forex"
    ? Array.from(new Set(candidate.map(normalizeForexSymbol).filter(Boolean))).slice(0, requestedMaximum)
    : withCanonicalForcedSymbols(candidate, requestedMaximum)
  const serialized = JSON.stringify(symbols)

  return {
    ...patch,
    force_symbols: serialized,
    selected_symbols: serialized,
    active_symbols: serialized,
    symbols: serialized,
    symbol_count: String(symbols.length),
    config_set_symbols_total:
      patch.config_set_symbols_total === undefined
        ? String(symbols.length)
        : patch.config_set_symbols_total,
  }
}
