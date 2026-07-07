/**
 * CCXT Integration Helper
 * Provides utilities for CCXT library integration and exchange support
 */

export interface CCXTExchangeInfo {
  id: string
  name: string
  countries: string[]
  urls: Record<string, any>
  hasFuturesTrading: boolean
  hasMarginTrading: boolean
  hasSpotTrading: boolean
  maxLeverage: number
}

export const CCXT_SUPPORTED_EXCHANGES = [
  {
    id: "binance",
    name: "Binance",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 125,
    description: "World's largest cryptocurrency exchange",
  },
  {
    id: "bybit",
    name: "Bybit",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 100,
    description: "Fast and reliable derivatives trading",
  },
  {
    id: "okx",
    name: "OKX",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 100,
    description: "Leading global crypto trading platform",
  },
  {
    id: "gateio",
    name: "Gate.io",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 100,
    description: "Safe and professional trading platform",
  },
  {
    id: "mexc",
    name: "MEXC",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 125,
    description: "Global crypto trading with low fees",
  },
  {
    id: "kucoin",
    name: "KuCoin",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 100,
    description: "Community-driven exchange with diverse assets",
  },
  {
    id: "huobi",
    name: "Huobi Global",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 100,
    description: "Established exchange with strong community",
  },
  {
    id: "bingx",
    name: "BingX",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 150,
    description: "Advanced trading features and low latency",
  },
  {
    id: "kraken",
    name: "Kraken",
    hasFuturesTrading: true,
    hasMarginTrading: true,
    hasSpotTrading: true,
    maxLeverage: 50,
    description: "Regulated and secure trading platform",
  },
  {
    id: "coinbase",
    name: "Coinbase",
    hasFuturesTrading: true,
    hasMarginTrading: false,
    hasSpotTrading: true,
    maxLeverage: 0,
    description: "Beginner-friendly US-based exchange",
  },
]

export function getExchangeInfoByCCXT(exchangeId: string): (typeof CCXT_SUPPORTED_EXCHANGES)[0] | undefined {
  return CCXT_SUPPORTED_EXCHANGES.find((ex) => ex.id === exchangeId.toLowerCase())
}

export function isCCXTSupported(exchangeId: string): boolean {
  return CCXT_SUPPORTED_EXCHANGES.some((ex) => ex.id === exchangeId.toLowerCase())
}

export function getCCXTInstallCommand(): Record<string, string> {
  return {
    npm: "npm install ccxt",
    pip: "pip install ccxt",
    yarn: "yarn add ccxt",
    pnpm: "pnpm add ccxt",
  }
}

export interface CCXTConnectionConfig {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
  sandbox?: boolean
  timeout?: number
  enableRateLimit?: boolean
}

export function validateCCXTCredentials(config: CCXTConnectionConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    errors.push("API Key is required")
  }

  if (!config.apiSecret || config.apiSecret.trim().length === 0) {
    errors.push("API Secret is required")
  }

  // Note: Don't validate credential length — valid credentials vary by exchange.
  // Removed checks for apiKey.length < 10 and apiSecret.length < 10.

  return {
    valid: errors.length === 0,
    errors,
  }
}

export const CCXT_LIBRARY_DESCRIPTIONS = {
  native: {
    name: "Native SDK",
    description: "Official exchange-specific SDK",
    pros: ["Fastest", "Most features", "Official support", "Best performance"],
    cons: ["Exchange-specific", "Requires individual setup"],
    examples: ["bybit-api", "binance/node", "okx-sdk"],
  },
  ccxt: {
    name: "CCXT",
    description: "Universal cryptocurrency trading library",
    pros: ["100+ exchanges", "Unified interface", "Easy switching", "Well-maintained"],
    cons: ["Slightly slower", "Subset of features"],
    examples: ["Support for 100+ exchanges globally"],
    documentation: "https://docs.ccxt.com",
  },
  library: {
    name: "Built-in Library",
    description: "Optimized in-app connector",
    pros: ["Lightweight", "No dependencies", "Tested integration"],
    cons: ["Limited exchanges", "May lack features"],
    examples: ["Direct API implementation"],
  },
}

export function getLibraryInfo(libraryType: "native" | "ccxt" | "library") {
  return CCXT_LIBRARY_DESCRIPTIONS[libraryType]
}
