// Centralized API Type and Contract Type Mapping
// Ensures correct endpoint routing and configuration per exchange

export interface ApiTypeMapping {
  exchange: string
  apiType: string
  contractType: string
  endpoint: string
  description: string
  requiresPassphrase: boolean
  rateLimit: { requests: number; intervalMs: number }
  defaultMarginType: "cross" | "isolated"
  defaultPositionMode: "hedge" | "one-way"
}

export interface ExchangeApiConfig {
  exchange: string
  baseUrl: string
  testnetUrl?: string
  supportedApiTypes: string[]
  supportedContractTypes: string[]
  defaultApiType: string
  requiresPassphrase: boolean
  rateLimit: { requests: number; intervalMs: number } // per minute typically
}

// Comprehensive mapping for all supported exchanges
export const EXCHANGE_API_CONFIGS: Record<string, ExchangeApiConfig> = {
  bybit: {
    exchange: "bybit",
    baseUrl: "https://api.bybit.com",
    supportedApiTypes: ["contract", "unified"],
    supportedContractTypes: ["perpetual", "linear", "inverse"],
    defaultApiType: "contract",
    requiresPassphrase: false,
    rateLimit: { requests: 600, intervalMs: 60000 }, // 600/min
  },
  bingx: {
    exchange: "bingx",
    baseUrl: "https://open-api.bingx.com",
    supportedApiTypes: ["perpetual_futures", "spot"],
    supportedContractTypes: ["usdt-perpetual", "coin-margined"],
    defaultApiType: "perpetual_futures",
    requiresPassphrase: false,
    rateLimit: { requests: 1000, intervalMs: 60000 }, // 1000/min
  },
  binance: {
    exchange: "binance",
    baseUrl: "https://fapi.binance.com",
    testnetUrl: "https://testnet.binancefuture.com",
    supportedApiTypes: ["spot", "perpetual_futures", "margin"],
    supportedContractTypes: ["usdt-perpetual", "coin-margined"],
    defaultApiType: "perpetual_futures",
    requiresPassphrase: false,
    rateLimit: { requests: 1200, intervalMs: 60000 }, // 1200/min
  },
  okx: {
    exchange: "okx",
    baseUrl: "https://www.okx.com",
    testnetUrl: "https://www.okx.com/awapi",
    supportedApiTypes: ["unified", "spot", "perpetual"],
    supportedContractTypes: ["usdt-perpetual", "coin-margined", "spot"],
    defaultApiType: "unified",
    requiresPassphrase: true, // OKX requires passphrase
    rateLimit: { requests: 3000, intervalMs: 60000 }, // 3000/min
  },
  gateio: {
    exchange: "gateio",
    baseUrl: "https://api.gateio.ws/api/v4",
    supportedApiTypes: ["perpetual", "spot", "margin"],
    supportedContractTypes: ["usdt-perpetual", "btc-perpetual"],
    defaultApiType: "perpetual",
    requiresPassphrase: false,
    rateLimit: { requests: 1000, intervalMs: 60000 }, // 1000/min
  },
  kucoin: {
    exchange: "kucoin",
    baseUrl: "https://api.kucoin.com",
    supportedApiTypes: ["spot", "margin", "perpetual"],
    supportedContractTypes: ["usdt-perpetual", "coin-margined"],
    defaultApiType: "perpetual",
    requiresPassphrase: true, // KuCoin requires passphrase
    rateLimit: { requests: 300, intervalMs: 3000 }, // 300/3s
  },
}

// Endpoint mapping for different contract types
export const API_TYPE_ENDPOINT_MAP: Record<string, Record<string, string>> = {
  bybit: {
    contract_perpetual: "/contract/v3/private",
    contract_linear: "/contract/v3/private",
    unified: "/unified/private",
  },
  bingx: {
    perpetual_futures: "/openApi/swap/v3",
    spot: "/openApi/spot/v1",
  },
  binance: {
    perpetual_futures: "/fapi/v1",
    spot: "/api/v3",
    margin: "/sapi/v1",
  },
  okx: {
    unified: "/api/v5/account",
    perpetual: "/api/v5/public",
  },
  gateio: {
    perpetual: "/api/v4/futures",
    spot: "/api/v4/spot",
  },
  kucoin: {
    perpetual: "/api/v1/contracts",
    spot: "/api/v1",
  },
}

// Get API config for exchange
export function getExchangeApiConfig(exchange: string): ExchangeApiConfig | undefined {
  return EXCHANGE_API_CONFIGS[exchange.toLowerCase()]
}

// Get endpoint for specific API type
export function getApiTypeEndpoint(exchange: string, apiType: string): string | undefined {
  const endpoints = API_TYPE_ENDPOINT_MAP[exchange.toLowerCase()]
  return endpoints ? endpoints[apiType] : undefined
}

// Validate API type for exchange
export function isValidApiType(exchange: string, apiType: string): boolean {
  const config = getExchangeApiConfig(exchange)
  return config ? config.supportedApiTypes.includes(apiType) : false
}

// Validate contract type for exchange
export function isValidContractType(exchange: string, contractType: string): boolean {
  const config = getExchangeApiConfig(exchange)
  return config ? config.supportedContractTypes.includes(contractType) : false
}

// Get rate limit for exchange
export function getExchangeRateLimit(
  exchange: string
): { requests: number; intervalMs: number } | undefined {
  const config = getExchangeApiConfig(exchange)
  return config ? config.rateLimit : undefined
}

// Check if exchange requires passphrase
export function requiresPassphrase(exchange: string): boolean {
  const config = getExchangeApiConfig(exchange)
  return config ? config.requiresPassphrase : false
}
