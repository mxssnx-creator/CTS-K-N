/**
 * Canonical asset-class helpers shared by connectors, engines and settings.
 * An exchange name is not an asset class: a venue can expose more than one
 * market. Keeping this distinction explicit prevents Forex from inheriting
 * crypto symbol, precision and volume assumptions.
 */
export const MARKET_TYPES = {
  CRYPTO: "crypto",
  FOREX: "forex",
} as const

export type MarketType = (typeof MARKET_TYPES)[keyof typeof MARKET_TYPES]

export const DEFAULT_FOREX_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "EURGBP",
] as const

const FOREX_EXCHANGE_NAMES = new Set(["instaforex", "instafx", "forex"])

export function normalizeExchangeId(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function isForexExchange(value: unknown): boolean {
  const normalized = normalizeExchangeId(value)
  return FOREX_EXCHANGE_NAMES.has(normalized) || normalized.includes("instaforex")
}

/** Explicit market values win; legacy venues continue to default to crypto. */
export function normalizeMarketType(value: unknown, exchange?: unknown): MarketType {
  const explicit = String(value || "").trim().toLowerCase()
  if (["forex", "fx", "foreign_exchange", "foreign-exchange"].includes(explicit)) return MARKET_TYPES.FOREX
  if (["crypto", "cryptocurrency", "digital_asset", "digital-asset"].includes(explicit)) return MARKET_TYPES.CRYPTO
  return isForexExchange(exchange) ? MARKET_TYPES.FOREX : MARKET_TYPES.CRYPTO
}

export function normalizeMarketSymbol(value: unknown, marketType: MarketType = MARKET_TYPES.CRYPTO): string {
  const raw = String(value || "").trim().toUpperCase()
  if (marketType === MARKET_TYPES.FOREX) {
    return raw.replace(/^FX:/, "").replace(/[\s/_\-.]/g, "").replace(/^#/, "").replace(/M$/i, "")
  }
  return raw.replace(/[\s/_-]/g, "")
}

export function getDefaultSymbolsForMarket(marketType: MarketType): string[] {
  return marketType === MARKET_TYPES.FOREX ? [...DEFAULT_FOREX_SYMBOLS] : []
}

export function marketTypeLabel(value: unknown): string {
  return normalizeMarketType(value) === MARKET_TYPES.FOREX ? "Forex" : "Crypto"
}
