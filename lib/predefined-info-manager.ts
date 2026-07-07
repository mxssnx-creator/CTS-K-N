// Predefined Connection Information Manager
// Displays exchange templates as informational references only (not active connections)

export interface PredefinedExchangeInfo {
  id: string
  name: string
  displayName: string
  description: string
  exchange: string
  features: string[]
  maxLeverage: number
  supportedApiTypes: string[]
  documentationUrl: string
  icon?: string
  apiKeyHelpUrl: string
  secretKeyHelpUrl: string
}

export const PREDEFINED_EXCHANGES: Record<string, PredefinedExchangeInfo> = {
  bybit: {
    id: "bybit",
    name: "Bybit",
    displayName: "Bybit X03 (USDT Perpetual Futures)",
    description:
      "Bybit USDT Perpetual Futures with up to 100x leverage. Professional trading with advanced order types.",
    exchange: "bybit",
    features: ["Perpetual Futures", "Up to 100x leverage", "USDT margin", "24/7 trading"],
    maxLeverage: 100,
    supportedApiTypes: ["contract", "unified"],
    documentationUrl: "https://bybit-exchange.github.io/docs/v5/intro",
    apiKeyHelpUrl: "https://www.bybit.com/en/user-service/my-api",
    secretKeyHelpUrl: "https://www.bybit.com/en/user-service/my-api",
  },
  bingx: {
    id: "bingx",
    name: "BingX",
    displayName: "BingX X01 (USDT Perpetual Futures)",
    description: "BingX USDT Perpetual Futures with up to 150x leverage. High liquidity trading.",
    exchange: "bingx",
    features: ["Perpetual Futures", "Up to 150x leverage", "USDT margin", "Copy trading"],
    maxLeverage: 150,
    supportedApiTypes: ["perpetual_futures"],
    documentationUrl: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
    apiKeyHelpUrl: "https://bingx.com/en/account/api",
    secretKeyHelpUrl: "https://bingx.com/en/account/api",
  },
  binance: {
    id: "binance",
    name: "Binance",
    displayName: "Binance X01 (USD-M Perpetual)",
    description: "Binance USD-M Perpetual with up to 125x leverage. Largest trading volume.",
    exchange: "binance",
    features: ["USD-M Perpetual", "Up to 125x leverage", "Spot trading", "Margin trading"],
    maxLeverage: 125,
    supportedApiTypes: ["spot", "perpetual_futures"],
    documentationUrl: "https://developers.binance.com/docs/binance-futures-api/quickstart",
    apiKeyHelpUrl: "https://www.binance.com/en/my/settings/api-management",
    secretKeyHelpUrl: "https://www.binance.com/en/my/settings/api-management",
  },
  okx: {
    id: "okx",
    name: "OKX",
    displayName: "OKX X01 (USDT Perpetual Swap)",
    description: "OKX USDT Perpetual Swaps with up to 125x leverage. Global exchange.",
    exchange: "okx",
    features: ["Perpetual Swaps", "Up to 125x leverage", "Spot trading", "Options"],
    maxLeverage: 125,
    supportedApiTypes: ["unified", "perpetual"],
    documentationUrl: "https://www.okx.com/docs-v5/en/",
    apiKeyHelpUrl: "https://www.okx.com/account/my-api",
    secretKeyHelpUrl: "https://www.okx.com/account/my-api",
  },
}

// Get all predefined exchanges as information
export function getAllPredefinedExchangeInfo(): PredefinedExchangeInfo[] {
  return Object.values(PREDEFINED_EXCHANGES)
}

// Get specific exchange info
export function getPredefinedExchangeInfo(exchange: string): PredefinedExchangeInfo | undefined {
  return PREDEFINED_EXCHANGES[exchange.toLowerCase()]
}

// Format exchange info for UI display
export function formatPredefinedExchangeDisplay(info: PredefinedExchangeInfo) {
  return {
    ...info,
    displayText: `${info.displayName} • Max ${info.maxLeverage}x`,
    subtitle: `Leverage: ${info.maxLeverage}x • API: ${info.supportedApiTypes.join(", ")}`,
  }
}
