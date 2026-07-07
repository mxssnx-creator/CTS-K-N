/**
 * Position Data Retrieval Helpers
 * Standardizes how different exchanges' positions are fetched and normalized
 */

import { validateApiType, validateContractType } from "@/lib/api-type-validator"
import type { ExchangePosition } from "@/lib/exchange-connectors/base-connector"

/**
 * Exchange-specific position fetch strategies
 * Each exchange returns data in different formats based on contract type
 */
export interface PositionFetchStrategy {
  // For spot trading: no positions returned
  canFetchPositions: boolean
  
  // API endpoint to use
  endpoint: string
  
  // Query parameters
  params: Record<string, string | number>
  
  // How to parse the response
  parseFunction: (data: any, exchange: string, contractType: string) => ExchangePosition[]
}

/**
 * Get the correct position fetch strategy for an exchange + contract type
 */
export function getPositionFetchStrategy(
  exchange: string,
  apiType: string,
  contractType: string
): PositionFetchStrategy {
  const exch = exchange.toLowerCase()
  const contract = contractType || "spot"

  // SPOT TRADING: No positions in spot (can only have open orders/balances)
  if (contract === "spot") {
    return {
      canFetchPositions: false,
      endpoint: "/api/na",
      params: {},
      parseFunction: () => [],
    }
  }

  // BYBIT PERPETUAL/FUTURES
  if (exch === "bybit") {
    return {
      canFetchPositions: true,
      endpoint: "/v5/position/list", // Bybit V5 unified endpoint
      params: {
        category: apiType === "inverse" ? "inverse" : "linear", // linear = USDT, inverse = USD
        settleCoin: apiType === "inverse" ? "USD" : "USDT",
      },
      parseFunction: parseBybitPositions,
    }
  }

  // BINGX PERPETUAL
  if (exch === "bingx") {
    return {
      canFetchPositions: true,
      endpoint: "/openApi/swap/v3/positions", // BingX perpetual endpoint
      params: {
        // BingX requires explicit symbol or returns all
      },
      parseFunction: parseBingXPositions,
    }
  }

  // BINANCE PERPETUAL
  if (exch === "binance") {
    return {
      canFetchPositions: true,
      endpoint: "/fapi/v2/positionRisk", // USD-M Futures
      params: {},
      parseFunction: parseBinancePositions,
    }
  }

  // OKX PERPETUAL
  if (exch === "okx") {
    return {
      canFetchPositions: true,
      endpoint: "/api/v5/account/positions", // OKX unified positions
      params: {
        instType: "SWAP", // Perpetual swap
      },
      parseFunction: parseOKXPositions,
    }
  }

  // PIONEX PERPETUAL
  if (exch === "pionex") {
    return {
      canFetchPositions: true,
      endpoint: "/perpetualapi/v1/positions",
      params: {},
      parseFunction: parsePionexPositions,
    }
  }

  // Default: no positions
  return {
    canFetchPositions: false,
    endpoint: "/api/na",
    params: {},
    parseFunction: () => [],
  }
}

/**
 * Normalize positions from different exchanges to unified format
 */

function parseBybitPositions(data: any, exchange: string, contractType: string): ExchangePosition[] {
  if (!data?.result?.list) return []

  return data.result.list
    .filter((pos: any) => pos.size > 0) // Only open positions
    .map((pos: any) => ({
      symbol: pos.symbol,
      side: pos.side === "Buy" ? "long" : "short",
      contracts: parseFloat(pos.size),
      contractSize: 1, // Bybit uses contracts
      currentPrice: parseFloat(pos.markPrice || "0"),
      markPrice: parseFloat(pos.markPrice || "0"),
      entryPrice: parseFloat(pos.avgPrice),
      leverage: parseFloat(pos.leverage),
      marginType: pos.isIsolated ? "isolated" : "cross",
      unrealizedPnl: parseFloat(pos.unrealizedPnl),
      realizedPnl: parseFloat(pos.cumRealisedPnl),
      liquidationPrice: parseFloat(pos.bustPrice || "0"),
      timestamp: Date.now(),
    }))
}

function parseBingXPositions(data: any, exchange: string, contractType: string): ExchangePosition[] {
  if (!Array.isArray(data)) return []

  return data
    .filter((pos: any) => parseFloat(pos.available) > 0 || parseFloat(pos.freezed) > 0)
    .map((pos: any) => ({
      symbol: pos.symbol,
      side: pos.positionSide === "LONG" ? "long" : "short",
      contracts: parseFloat(pos.available) + parseFloat(pos.freezed),
      contractSize: 1,
      currentPrice: parseFloat(pos.markPrice || "0"),
      markPrice: parseFloat(pos.markPrice || "0"),
      entryPrice: parseFloat(pos.openPrice),
      leverage: parseFloat(pos.leverage),
      marginType: pos.marginType === "isolated" ? "isolated" : "cross",
      unrealizedPnl: parseFloat(pos.unrealizedProfit || "0"),
      realizedPnl: parseFloat(pos.realizedProfit || "0"),
      liquidationPrice: parseFloat(pos.liquidatePrice || "0"),
      timestamp: Date.now(),
    }))
}

function parseBinancePositions(data: any, exchange: string, contractType: string): ExchangePosition[] {
  if (!Array.isArray(data)) return []

  return data
    .filter((pos: any) => parseFloat(pos.positionAmt) !== 0)
    .map((pos: any) => ({
      symbol: pos.symbol,
      side: parseFloat(pos.positionAmt) > 0 ? "long" : "short",
      contracts: Math.abs(parseFloat(pos.positionAmt)),
      contractSize: 1,
      currentPrice: parseFloat(pos.markPrice),
      markPrice: parseFloat(pos.markPrice),
      entryPrice: parseFloat(pos.entryPrice),
      leverage: parseFloat(pos.leverage),
      marginType: pos.marginType === "isolated" ? "isolated" : "cross",
      unrealizedPnl: parseFloat(pos.unRealizedProfit),
      realizedPnl: 0, // Binance doesn't include realized PnL in position response
      liquidationPrice: parseFloat(pos.liquidatePrice),
      timestamp: Date.now(),
    }))
}

function parseOKXPositions(data: any, exchange: string, contractType: string): ExchangePosition[] {
  if (!Array.isArray(data?.data)) return []

  return data.data
    .filter((pos: any) => parseFloat(pos.pos) !== 0)
    .map((pos: any) => ({
      symbol: pos.instId, // OKX uses instId (e.g., BTC-USDT-SWAP)
      side: pos.posSide === "long" ? "long" : "short",
      contracts: Math.abs(parseFloat(pos.pos)),
      contractSize: 1,
      currentPrice: parseFloat(pos.markPx || "0"),
      markPrice: parseFloat(pos.markPx || "0"),
      entryPrice: parseFloat(pos.avgPx),
      leverage: parseFloat(pos.lever),
      marginType: pos.mgnMode === "isolated" ? "isolated" : "cross",
      unrealizedPnl: parseFloat(pos.upl || "0"),
      realizedPnl: parseFloat(pos.realizedPnl || "0"),
      liquidationPrice: parseFloat(pos.liqPx || "0"),
      timestamp: Date.now(),
    }))
}

function parsePionexPositions(data: any, exchange: string, contractType: string): ExchangePosition[] {
  if (!Array.isArray(data)) return []

  return data
    .filter((pos: any) => parseFloat(pos.size) > 0)
    .map((pos: any) => ({
      symbol: pos.symbol,
      side: pos.direction === "LONG" ? "long" : "short",
      contracts: parseFloat(pos.size),
      contractSize: 1,
      currentPrice: parseFloat(pos.markPrice || "0"),
      markPrice: parseFloat(pos.markPrice || "0"),
      entryPrice: parseFloat(pos.entryPrice),
      leverage: parseFloat(pos.leverage),
      marginType: pos.marginType === "isolated" ? "isolated" : "cross",
      unrealizedPnl: parseFloat(pos.unrealizedPnL || "0"),
      realizedPnl: 0,
      liquidationPrice: parseFloat(pos.liquidatePrice || "0"),
      timestamp: Date.now(),
    }))
}
