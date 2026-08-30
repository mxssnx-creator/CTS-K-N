import { normalizeMarketSymbol } from "@/lib/market-types"

export const DEFAULT_FOREX_POSITIONS_AVERAGE = 24
export const DEFAULT_FOREX_SPREAD_BUFFER_PIPS = 0.5
export const DEFAULT_FOREX_SPREAD_MULTIPLIER = 1
// InstaForex's published calculator defines one lot as 10,000 base-currency
// units. Keep this explicit at the shared boundary so sizing, positions, and
// reporting cannot silently inherit the crypto/standard-100k convention.
export const DEFAULT_FOREX_LOT_SIZE = 10_000

/**
 * Official InstaForex HTTP endpoints are data/history surfaces.  Trading is
 * only enabled when an operator explicitly selects a separately hosted,
 * authenticated terminal bridge.  Keeping this union in the shared market
 * module prevents a UI alias from silently changing the execution policy.
 */
export type ForexExecutionMode = "read_only" | "mt5_bridge"

export function normalizeForexExecutionMode(value: unknown): ForexExecutionMode {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  return ["mt5_bridge", "mt5", "mt4", "bridge", "private_bridge", "private_mt5_bridge", "private_mt4_bridge"].includes(normalized)
    ? "mt5_bridge"
    : "read_only"
}

/**
 * Resolve the effective Forex transport from every persisted/UI alias.
 * Explicit mode fields win over method/library compatibility fields, so an
 * operator can deliberately switch a previously bridged connection back to
 * official read-only REST without a stale `connection_method=bridge` reviving
 * order execution.
 */
export function resolveForexExecutionMode(
  settings: Record<string, unknown> | null | undefined,
): ForexExecutionMode {
  if (!settings) return "read_only"
  return normalizeForexExecutionMode(
    settings.forex_execution_mode ??
      settings.forexExecutionMode ??
      settings.execution_mode ??
      settings.executionMode ??
      settings.connection_method ??
      settings.connectionMethod ??
      settings.connection_library ??
      settings.connectionLibrary,
  )
}

/** Accept only an explicit HTTP(S) bridge URL without embedded credentials. */
export function isValidForexBridgeUrl(value: unknown): boolean {
  const raw = String(value ?? "").trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
  } catch {
    return false
  }
}

/** Whether settings explicitly selected the private terminal transport. */
export function isForexBridgeSelected(settings: Record<string, unknown> | null | undefined): boolean {
  if (!settings) return false
  const explicitMode = settings.forex_execution_mode ?? settings.forexExecutionMode
  if (explicitMode !== undefined && explicitMode !== null && String(explicitMode).trim() !== "") {
    return normalizeForexExecutionMode(explicitMode) === "mt5_bridge"
  }
  const explicitExecutionMode = settings.execution_mode ?? settings.executionMode
  if (explicitExecutionMode !== undefined && explicitExecutionMode !== null && String(explicitExecutionMode).trim() !== "") {
    return normalizeForexExecutionMode(explicitExecutionMode) === "mt5_bridge"
  }
  const method = String(settings.connection_method ?? settings.connectionMethod ?? "").trim().toLowerCase()
  const library = String(settings.connection_library ?? settings.connectionLibrary ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  return method === "bridge" ||
    ["mt5_bridge", "mt5", "mt4", "private_bridge", "private_mt5_bridge", "private_mt4_bridge"].includes(library)
}

const CURRENCY_CODES = new Set([
  "AED", "AUD", "CAD", "CHF", "CNH", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "ILS", "JPY", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "THB",
  "TRY", "USD", "XAG", "XAU", "ZAR",
])

export function normalizeForexSymbol(value: unknown): string {
  const normalized = normalizeMarketSymbol(value, "forex")
  // InstaForex exposes pair suffixes such as EURUSD.fx and EURUSD.m. Keep
  // the canonical six-character instrument key at the application boundary.
  return normalized.replace(/(?:FX|M|I)$/i, "")
}

export function isForexSymbol(value: unknown): boolean {
  const symbol = normalizeForexSymbol(value)
  return symbol.length === 6 && CURRENCY_CODES.has(symbol.slice(0, 3)) && CURRENCY_CODES.has(symbol.slice(3, 6))
}

export function forexPipSize(value: unknown): number {
  const symbol = normalizeForexSymbol(value)
  return symbol.endsWith("JPY") || symbol.startsWith("XAU") || symbol.startsWith("XAG") ? 0.01 : 0.0001
}

export function forexPriceDigits(value: unknown): number {
  const symbol = normalizeForexSymbol(value)
  if (symbol.startsWith("XAU") || symbol.startsWith("XAG")) return 2
  return forexPipSize(symbol) === 0.01 ? 3 : 5
}

/** One InstaForex lot is 10,000 base-currency units. */
export function forexUnitsFromLots(lots: number, lotSize = DEFAULT_FOREX_LOT_SIZE): number {
  const value = Number(lots) * Number(lotSize)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function forexLotsFromUnits(units: number, lotSize = DEFAULT_FOREX_LOT_SIZE): number {
  const value = Number(units) / Number(lotSize)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export interface ForexInstrumentSpec {
  symbol: string
  base: string
  quote: string
  pipSize: number
  digits: number
  standardLot: number
  minLot: number
  volumeKind: "lots"
}

export function getForexInstrumentSpec(value: unknown): ForexInstrumentSpec {
  const symbol = normalizeForexSymbol(value)
  return {
    symbol,
    base: symbol.slice(0, 3),
    quote: symbol.slice(3, 6),
    pipSize: forexPipSize(symbol),
    digits: forexPriceDigits(symbol),
    standardLot: DEFAULT_FOREX_LOT_SIZE,
    minLot: 0.01,
    volumeKind: "lots",
  }
}

export interface ForexPairCurrencies {
  symbol: string
  base: string
  quote: string
}

export function forexPairCurrencies(value: unknown): ForexPairCurrencies | null {
  const symbol = normalizeForexSymbol(value)
  if (!isForexSymbol(symbol)) return null
  return {
    symbol,
    base: symbol.slice(0, 3),
    quote: symbol.slice(3, 6),
  }
}

/**
 * Return the quote-currency → USD conversion rate required by USD reports.
 *
 * A quote with USD as its quote currency is already USD. For USD/XXX pairs,
 * the pair price is XXX per USD, so one XXX is 1 / price USD. Cross pairs
 * require an independently observed quote (for example GBPUSD for EURGBP);
 * callers must pass that rate instead of silently treating quote currency as
 * USD.
 */
export function forexQuoteToUsdRate(
  symbolValue: unknown,
  price: number,
  providedRate?: number,
): number | undefined {
  const pair = forexPairCurrencies(symbolValue)
  if (!pair) return undefined
  if (pair.quote === "USD") return 1
  const supplied = Number(providedRate)
  if (Number.isFinite(supplied) && supplied > 0) return supplied
  const pairPrice = Number(price)
  if (pair.base === "USD" && pairPrice > 0) return 1 / pairPrice
  return undefined
}

/** USD notional of a Forex lot quantity at a pair price. */
export function forexNotionalUsd(
  lots: number,
  price: number,
  symbolValue?: unknown,
  lotSize = DEFAULT_FOREX_LOT_SIZE,
  providedQuoteToUsdRate?: number,
): number {
  const quantity = forexUnitsFromLots(lots, lotSize)
  const pair = forexPairCurrencies(symbolValue)
  const pairPrice = Number(price)
  if (!(quantity > 0) || !(pairPrice > 0) || !pair) return 0
  const quoteToUsd = forexQuoteToUsdRate(pair.symbol, pairPrice, providedQuoteToUsdRate)
  return quoteToUsd && quoteToUsd > 0 ? quantity * pairPrice * quoteToUsd : 0
}

/**
 * Convert price movement into USD PnL using executable entry/exit prices.
 * The result is zero when a cross-pair quote-currency conversion is missing;
 * this is intentional so a report cannot label quote-currency PnL as USD.
 */
export function forexPriceMovePnlUsd(
  direction: "long" | "short",
  lots: number,
  entryPrice: number,
  exitPrice: number,
  symbolValue: unknown,
  lotSize = DEFAULT_FOREX_LOT_SIZE,
  providedQuoteToUsdRate?: number,
): number {
  const quantity = forexUnitsFromLots(lots, lotSize)
  const entry = Number(entryPrice)
  const exit = Number(exitPrice)
  if (!(quantity > 0) || !(entry > 0) || !(exit > 0)) return 0
  const quotePnl = (direction === "long" ? exit - entry : entry - exit) * quantity
  const quoteToUsd = forexQuoteToUsdRate(symbolValue, exit, providedQuoteToUsdRate)
  return quoteToUsd && quoteToUsd > 0 ? quotePnl * quoteToUsd : 0
}
