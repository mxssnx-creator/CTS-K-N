/**
 * Comprehensive API Types Reference Document
 * Defines all supported contract types and their API endpoints for each exchange
 * 
 * CONTRACT TYPES:
 * - spot: Buy/sell cryptocurrencies directly (no leverage)
 * - perpetual_futures: Perpetual swap contracts (unlimited duration, daily funding)
 * - futures: Time-limited futures contracts (monthly, quarterly, etc.)
 * - unified: Unified account (all contract types in one account)
 * - inverse: Inverse perpetual (BTC denominated contracts, Bybit V4 API)
 * - margin: Margin trading with leverage
 */

export const EXCHANGE_API_SPECIFICATIONS = {
  bybit: {
    name: "Bybit",
    baseUrl: "https://api.bybit.com",
    testnetUrl: "https://api-testnet.bybit.com",
    apiVersion: "V5 Unified",
    supportedTypes: {
      unified: {
        description: "Unified Trading Account - all contracts in one wallet",
        endpoint: "/v5/account/wallet-balance",
        accountType: "UNIFIED",
        features: ["spot", "perpetual_futures", "inverse", "options"],
        maxLeverage: 125,
        documentation: "https://bybit-exchange.github.io/docs/v5/account/wallet-balance",
      },
      contract: {
        description: "Contract Trading Account - derivatives/futures only",
        endpoint: "/v5/account/wallet-balance",
        accountType: "CONTRACT",
        features: ["perpetual_futures", "inverse"],
        maxLeverage: 125,
        documentation: "https://bybit-exchange.github.io/docs/v5/account/wallet-balance",
      },
      spot: {
        description: "Spot Trading Account - spot trading only",
        endpoint: "/v5/account/wallet-balance",
        accountType: "SPOT",
        features: ["spot"],
        maxLeverage: 1,
        documentation: "https://bybit-exchange.github.io/docs/v5/account/wallet-balance",
      },
      perpetual_futures: {
        description: "Maps to CONTRACT account type for perpetual futures",
        endpoint: "/v5/account/wallet-balance",
        accountType: "CONTRACT",
        features: ["perpetual_futures"],
        maxLeverage: 125,
        documentation: "https://bybit-exchange.github.io/docs/v5/account/wallet-balance",
      },
    },
    balanceFields: {
      total: "walletBalance",
      free: "availableToWithdraw",
      locked: "locked",
    },
    errors: [
      { code: 1000, message: "Invalid request" },
      { code: 10001, message: "API key not found" },
      { code: 10002, message: "API key expired" },
      { code: 10003, message: "API key has been revoked" },
      { code: 10004, message: "Timestamp error" },
      { code: 10005, message: "Sign error" },
    ],
  },
  bingx: {
    name: "BingX",
    baseUrl: "https://open-api.bingx.com",
    testnetUrl: "https://testnet-open-api.bingx.com",
    apiVersion: "V2/V3",
    supportedTypes: {
      spot: {
        description: "Spot trading",
        endpoint: "/openApi/spot/v1/account/balance",
        features: ["spot"],
        maxLeverage: 1,
        documentation: "https://bingx-api.github.io/docs/#/en-us/spot/account-api",
        balanceFields: {
          total: "balance",
          free: "free",
          locked: "locked",
        },
      },
      perpetual_futures: {
        description: "Perpetual futures contracts (USDT margin)",
        endpoint: "/openApi/swap/v3/user/balance",
        features: ["perpetual_futures"],
        maxLeverage: 150,
        documentation: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
        balanceFields: {
          total: "balance",
          free: "availableMargin",
          locked: "frozenMargin",
        },
      },
      standard: {
        description: "Standard futures (treated as perpetual)",
        endpoint: "/openApi/swap/v3/user/balance",
        features: ["perpetual_futures"],
        maxLeverage: 150,
        documentation: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
        balanceFields: {
          total: "balance",
          free: "availableMargin",
          locked: "frozenMargin",
        },
      },
    },
    errors: [
      { code: -1, message: "Invalid request" },
      { code: -1000, message: "Invalid character in parameter" },
      { code: -1013, message: "Invalid quantity" },
      { code: -2000, message: "Invalid order type" },
      { code: 401100, message: "API key does not exist" },
      { code: 401101, message: "Invalid API key" },
      { code: 401102, message: "API request signature verification failed" },
    ],
  },
  binance: {
    name: "Binance",
    baseUrl: "https://api.binance.com",
    testnetUrl: "https://testnet.binance.vision",
    apiVersion: "REST V3",
    supportedTypes: {
      spot: {
        description: "Spot trading",
        endpoint: "/api/v3/account",
        features: ["spot"],
        maxLeverage: 1,
        documentation: "https://binance-docs.github.io/apidocs/spot/en/#account-endpoints-user",
        balanceFields: {
          total: "balance",
          free: "free",
          locked: "locked",
        },
      },
      perpetual_futures: {
        description: "USD-M Perpetual Futures",
        endpoint: "/fapi/v2/balance",
        features: ["perpetual_futures"],
        maxLeverage: 125,
        documentation: "https://binance-docs.github.io/apidocs/futures/en/#account-endpoints",
        balanceFields: {
          total: "balance",
          free: "availableBalance",
          locked: "crossUnPnl",
        },
      },
      futures: {
        description: "USD-M Futures (time-limited)",
        endpoint: "/fapi/v2/balance",
        features: ["futures"],
        maxLeverage: 125,
        documentation: "https://binance-docs.github.io/apidocs/futures/en/#account-endpoints",
        balanceFields: {
          total: "balance",
          free: "availableBalance",
          locked: "crossUnPnl",
        },
      },
    },
    errors: [
      { code: -1000, message: "Invalid request weight" },
      { code: -1001, message: "Disconnected" },
      { code: -1002, message: "Unauthorized" },
      { code: -2013, message: "Order does not exist" },
      { code: -2015, message: "Invalid API key" },
    ],
  },
  okx: {
    name: "OKX",
    baseUrl: "https://www.okx.com",
    apiVersion: "REST V5",
    supportedTypes: {
      unified: {
        description: "Unified Account - all trading in one account",
        endpoint: "/api/v5/account/balance",
        features: ["spot", "perpetual_futures", "futures", "margin", "options"],
        maxLeverage: 125,
        documentation: "https://www.okx.com/docs-v5/en/#rest-api-account-get-balance",
        balanceFields: {
          total: "eq",
          free: "availBal",
          locked: "frozenBal",
        },
      },
      spot: {
        description: "Spot trading only",
        endpoint: "/api/v5/account/balance",
        features: ["spot"],
        maxLeverage: 1,
        documentation: "https://www.okx.com/docs-v5/en/#rest-api-account-get-balance",
        balanceFields: {
          total: "eq",
          free: "availBal",
          locked: "frozenBal",
        },
      },
      perpetual_futures: {
        description: "Perpetual swap contracts",
        endpoint: "/api/v5/account/balance",
        features: ["perpetual_futures"],
        maxLeverage: 125,
        documentation: "https://www.okx.com/docs-v5/en/#rest-api-account-get-balance",
        balanceFields: {
          total: "eq",
          free: "availBal",
          locked: "frozenBal",
        },
      },
    },
    errors: [
      { code: 0, message: "Request successful" },
      { code: 1, message: "Params error" },
      { code: 50000, message: "API Invalid" },
      { code: 50001, message: "API key does not exist" },
      { code: 50002, message: "API key invalid" },
    ],
  },
  pionex: {
    name: "Pionex",
    baseUrl: "https://api.pionex.com",
    apiVersion: "REST V1",
    supportedTypes: {
      spot: {
        description: "Spot trading",
        endpoint: "/api/v1/account",
        features: ["spot"],
        maxLeverage: 1,
        documentation: "https://pionex-doc.gitbook.io/apidocs/spot-trading-api/account",
        balanceFields: {
          total: "balance",
          free: "free",
          locked: "locked",
        },
      },
      perpetual: {
        description: "Perpetual futures",
        endpoint: "/fapi/v1/account",
        features: ["perpetual_futures"],
        maxLeverage: 100,
        documentation: "https://pionex-doc.gitbook.io/apidocs/perpetual-futures/account",
        balanceFields: {
          total: "totalWalletBalance",
          free: "availableBalance",
          locked: "totalPositionInitialMargin",
        },
      },
    },
    errors: [
      { code: 400, message: "Bad Request" },
      { code: 401, message: "Unauthorized" },
      { code: 403, message: "Forbidden" },
      { code: 429, message: "Too Many Requests" },
      { code: 500, message: "Internal Server Error" },
    ],
  },
}

/**
 * Validates that an API type is supported for a given exchange
 * @param exchange - Exchange name (e.g., "bybit", "bingx")
 * @param apiType - API type to validate (e.g., "spot", "perpetual_futures")
 * @returns true if valid, false otherwise
 */
export function isValidApiType(exchange: string, apiType?: string): boolean {
  if (!apiType) return true // undefined means use default

  const spec = EXCHANGE_API_SPECIFICATIONS[exchange.toLowerCase() as keyof typeof EXCHANGE_API_SPECIFICATIONS]
  if (!spec) return false

  return apiType in spec.supportedTypes
}

/**
 * Get the API specification for a given exchange and API type
 * @param exchange - Exchange name
 * @param apiType - API type
 * @returns API specification or undefined if not found
 */
export function getApiSpecification(exchange: string, apiType: string) {
  const spec = EXCHANGE_API_SPECIFICATIONS[exchange.toLowerCase() as keyof typeof EXCHANGE_API_SPECIFICATIONS]
  if (!spec) return undefined

  return spec.supportedTypes[apiType as keyof typeof spec.supportedTypes]
}

/**
 * Get all supported API types for an exchange
 * @param exchange - Exchange name
 * @returns Array of supported API types
 */
export function getSupportedApiTypes(exchange: string): string[] {
  const spec = EXCHANGE_API_SPECIFICATIONS[exchange.toLowerCase() as keyof typeof EXCHANGE_API_SPECIFICATIONS]
  if (!spec) return []

  return Object.keys(spec.supportedTypes)
}
