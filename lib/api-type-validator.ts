/**
 * API Type and Contract Type Validation
 * Ensures all connections are configured with valid, supported contract types per exchange
 */

import { EXCHANGE_API_TYPES, EXCHANGE_SUBTYPES, EXCHANGE_CONNECTION_METHODS } from "@/lib/connection-predefinitions"

export interface ApiTypeValidation {
  isValid: boolean
  error?: string
  normalizedApiType?: string
  normalizedSubtype?: string
  supportedTypes?: string[]
  supportedSubtypes?: string[]
}

/**
 * Validate and normalize API type for an exchange
 * Different exchanges use different terminology:
 * - Bybit: unified, contract, spot, inverse
 * - BingX: perpetual_futures, spot, standard
 * - Binance: spot, perpetual_futures, futures, margin, portfolio
 * - OKX: unified, spot, perpetual, futures, swap
 * - Pionex: spot, perpetual
 * etc.
 */
export function validateApiType(exchange: string, apiType: string): ApiTypeValidation {
  const exchangeLower = exchange.toLowerCase()
  const apiTypeLower = (apiType || "").toLowerCase().trim()

  // Handle undefined/empty
  if (!apiTypeLower) {
    return {
      isValid: false,
      error: `API type is required for ${exchange}`,
      supportedTypes: EXCHANGE_API_TYPES[exchangeLower] || [],
    }
  }

  // Check if this exchange is supported
  const supportedTypes = EXCHANGE_API_TYPES[exchangeLower]
  if (!supportedTypes) {
    return {
      isValid: false,
      error: `Exchange '${exchange}' is not recognized. Supported exchanges: ${Object.keys(EXCHANGE_API_TYPES).join(", ")}`,
    }
  }

  // Normalize common aliases for contract types
  const normalizedType = normalizeApiType(exchangeLower, apiTypeLower)

  // Check if normalized type is supported
  if (!supportedTypes.includes(normalizedType)) {
    return {
      isValid: false,
      error: `API type '${apiType}' is not supported for ${exchange}. Supported types: ${supportedTypes.join(", ")}`,
      supportedTypes,
    }
  }

  return {
    isValid: true,
    normalizedApiType: normalizedType,
    supportedTypes,
  }
}

/**
 * Validate contract/trading subtype for an exchange
 * Subtypes: spot, perpetual, futures, margin, derivatives
 */
export function validateContractType(exchange: string, subtype: string): ApiTypeValidation {
  const exchangeLower = exchange.toLowerCase()
  const subtypeLower = (subtype || "").toLowerCase().trim()

  // Handle undefined/empty (default to spot)
  if (!subtypeLower) {
    return {
      isValid: true,
      normalizedSubtype: "spot",
      supportedSubtypes: EXCHANGE_SUBTYPES[exchangeLower] || [],
    }
  }

  const supportedSubtypes = EXCHANGE_SUBTYPES[exchangeLower]
  if (!supportedSubtypes) {
    return {
      isValid: false,
      error: `Exchange '${exchange}' contract types not defined`,
    }
  }

  // Normalize common aliases
  const normalizedSubtype = normalizeContractType(exchangeLower, subtypeLower)

  if (!supportedSubtypes.includes(normalizedSubtype)) {
    return {
      isValid: false,
      error: `Contract type '${subtype}' not supported for ${exchange}. Supported: ${supportedSubtypes.join(", ")}`,
      supportedSubtypes,
    }
  }

  return {
    isValid: true,
    normalizedSubtype,
    supportedSubtypes,
  }
}

/**
 * Normalize API type aliases across different exchanges
 * Bybit: "contract" -> "contract", "unified_trading" -> "unified"
 * BingX: "swap" -> "perpetual_futures", "standard_futures" -> "perpetual_futures"
 * Binance: "futures" -> "perpetual_futures", "um" -> "perpetual_futures", "cm" -> "futures"
 * OKX: "swap" -> "perpetual", "linear" -> "perpetual", "inverse" -> "futures"
 */
function normalizeApiType(exchange: string, apiType: string): string {
  const normalized = apiType.toLowerCase()

  // Universal aliases
  if (normalized === "unified" || normalized === "unified_trading" || normalized === "portfolio") {
    return "unified"
  }
  if (normalized === "perpetual" || normalized === "perpetual_swap" || normalized === "linear_swap" || normalized === "um") {
    return exchange === "bingx" ? "perpetual_futures" : "perpetual"
  }
  if (normalized === "futures" || normalized === "delivery" || normalized === "cm" || normalized === "coin") {
    return "futures"
  }
  if (normalized === "contract" || normalized === "contracts") {
    return "contract"
  }
  if (normalized === "inverse" || normalized === "inverse_swap") {
    return "inverse"
  }
  if (normalized === "spot" || normalized === "spotapi") {
    return "spot"
  }
  if (normalized === "margin" || normalized === "marginapi") {
    return "margin"
  }
  if (normalized === "standard" || normalized === "standard_futures") {
    return "standard"
  }
  if (normalized === "portfolio" || normalized === "portfolio_margin") {
    return "portfolio"
  }
  if (normalized === "swap" || normalized === "perpetual_futures") {
    return exchange === "okx" ? "swap" : "perpetual_futures"
  }

  // Exchange-specific normalizations
  if (exchange === "bingx") {
    if (normalized === "perpetual") return "perpetual_futures"
    if (normalized === "contracts") return "perpetual_futures"
  }

  // Return as-is if no normalization found (will be validated upstream)
  return normalized
}

/**
 * Normalize contract type aliases
 */
function normalizeContractType(exchange: string, contractType: string): string {
  const normalized = contractType.toLowerCase()

  if (normalized === "spot" || normalized === "spotapi" || normalized === "cash") {
    return "spot"
  }
  // "perpetual_futures" is the internal api_type value used across all connections.
  // The EXCHANGE_SUBTYPES map uses "perpetual" as the canonical subtype name.
  // Map perpetual_futures -> perpetual so validation passes correctly.
  if (
    normalized === "perpetual" ||
    normalized === "perpetual_futures" ||
    normalized === "perpetual_swap" ||
    normalized === "linear_swap" ||
    normalized === "swap" ||
    normalized === "contracts"
  ) {
    return "perpetual"
  }
  if (normalized === "futures" || normalized === "delivery" || normalized === "delivery_futures" || normalized === "coin_m") {
    return "futures"
  }
  if (normalized === "margin" || normalized === "marginapi" || normalized === "cross_margin") {
    return "margin"
  }
  if (normalized === "derivatives" || normalized === "derivative") {
    return "derivatives"
  }

  return normalized
}

/**
 * Get API request path for a specific exchange + contract type
 * Used by connectors to construct correct API endpoints
 */
export function getApiPath(exchange: string, apiType: string): string {
  const exch = exchange.toLowerCase()

  // Bybit
  if (exch === "bybit") {
    if (apiType === "unified" || apiType === "contract") return "/v5/order"
    if (apiType === "spot") return "/v5/order"
    if (apiType === "inverse") return "/v5/order"
  }

  // BingX
  if (exch === "bingx") {
    if (apiType === "perpetual_futures") return "/openApi/swap/v3"
    if (apiType === "spot") return "/openApi/spot/v1"
    if (apiType === "standard") return "/openApi/spot/v1"
  }

  // Binance
  if (exch === "binance") {
    if (apiType === "spot") return "/api/v3"
    if (apiType === "perpetual_futures") return "/fapi/v1"
    if (apiType === "futures") return "/dapi/v1"
    if (apiType === "margin") return "/sapi/v1"
    if (apiType === "portfolio") return "/papi/v1"
  }

  // OKX
  if (exch === "okx") {
    // OKX uses unified endpoints for all types
    return "/api/v5/trade"
  }

  // Pionex
  if (exch === "pionex") {
    if (apiType === "spot") return "/api/v1"
    if (apiType === "perpetual") return "/perpetualapi/v1"
  }

  // Default
  return "/api/v1"
}

/**
 * Validate complete connection configuration
 */
export function validateConnectionConfig(exchange: string, apiType: string, contractType: string) {
  const apiValidation = validateApiType(exchange, apiType)
  const contractValidation = validateContractType(exchange, contractType)

  return {
    isValid: apiValidation.isValid && contractValidation.isValid,
    apiType: apiValidation,
    contractType: contractValidation,
    apiPath: apiValidation.isValid ? getApiPath(exchange, apiValidation.normalizedApiType || "") : undefined,
  }
}
