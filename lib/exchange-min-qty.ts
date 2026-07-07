/**
 * Per-base-asset minimum order quantity (in base units), keyed by the
 * uppercased base ticker extracted from a CCXT-style symbol.
 *
 * Used by:
 *   • app/api/test/live-orders-test/route.ts — test harness floors
 *   • lib/trade-engine/stages/live-stage.ts   — live SL/TP placement floor
 *
 * Single source of truth so the test and engine never drift apart.
 *
 * Values are conservative floors derived from BingX/Bybit/Binance
 * public exchangeInfo for USDT-perp pairs. They are NOT meant to be
 * authoritative — the connector should ideally call `/exchangeInfo`
 * at boot and cache the real values per venue — but as a static floor
 * they reliably prevent code=110422 ("minimum size per order")
 * rejections both in the test harness and live engine.
 *
 * The default for unknown symbols is 1 base unit, which is restrictive
 * enough to surface coverage gaps as the operator adds new pairs (a
 * sub-1-unit position will be force-floored to 1 — visible in logs —
 * rather than silently rejected by the venue).
 */
export const VENUE_MIN_QTY_BY_BASE: Record<string, number> = {
  BTC: 0.0001,
  ETH: 0.01,
  BNB: 0.01,
  SOL: 0.1,
  XRP: 1,
  ADA: 1,
  DOGE: 10,
  MATIC: 1,
  AVAX: 0.1,
  LINK: 0.1,
  DOT: 0.1,
  LTC: 0.01,
  TRX: 10,
  MLN: 0.1,
  ATOM: 0.1,
  // Common alts seen in production presets
  ARB: 1,
  OP: 0.1,
  SUI: 1,
  APT: 0.1,
  TON: 1,
  NEAR: 1,
  FIL: 0.1,
  ICP: 0.1,
  INJ: 0.1,
  RUNE: 0.1,
  TIA: 0.1,
  SEI: 1,
  PEPE: 1000000,
  SHIB: 100000,
  WIF: 1,
}

/**
 * Common quote currencies appended in exchange-native concatenated symbols.
 * Listed longest-first so "USDT" is stripped before "USD" and "BTC" is not
 * accidentally consumed as a base when the actual base starts with "BTC".
 */
const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "EUR", "GBP"]

/**
 * Looks up the minimum order quantity for the given symbol's base asset.
 *
 * Handles three formats:
 *   • Separated  : `BTC/USDT`, `BTC-USDT`, `BTC_USDT`  → split on separator
 *   • Native/concat: `BTCUSDT`, `SOLUSDT`, `BNBUSDT`    → strip known quote suffix
 *
 * @param symbol - Symbol in any of the above formats.
 * @returns The minimum quantity in base units, or 1 if the base asset
 *          is not in the table.
 */
export function getVenueMinQty(symbol: string | undefined | null): number {
  if (!symbol) return 1
  const raw = String(symbol).toUpperCase()

  // Fast path: separator-based symbol (BTC/USDT, BTC-USDT, BTC_USDT)
  const hasSep = /[/\-_]/.test(raw)
  if (hasSep) {
    const base = raw.split(/[/\-_]/)[0] ?? ""
    return VENUE_MIN_QTY_BY_BASE[base] ?? 1
  }

  // Slow path: native concatenated symbol (BTCUSDT, SOLUSDT, …)
  // Try exact match first (handles unusual tickers not decomposable below)
  if (VENUE_MIN_QTY_BY_BASE[raw] !== undefined) {
    return VENUE_MIN_QTY_BY_BASE[raw]
  }
  // Strip known quote suffixes to extract the base ticker
  for (const quote of KNOWN_QUOTES) {
    if (raw.endsWith(quote)) {
      const base = raw.slice(0, raw.length - quote.length)
      if (base.length > 0 && VENUE_MIN_QTY_BY_BASE[base] !== undefined) {
        return VENUE_MIN_QTY_BY_BASE[base]
      }
    }
  }
  // Unknown symbol — return conservative default
  return 1
}
