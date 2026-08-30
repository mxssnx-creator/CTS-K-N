/**
 * Exchange Connector Factory v3.0
 * Creates appropriate connector based on exchange name
 * Handles API type normalization between perpetual/perpetual_futures variants
 */

import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"
import { hasUsableLiveCredentials, isForcedSimulation } from "@/lib/real-trade-gates"

export interface ExchangeConnectorCreationOptions {
  /** A caller that already enforced an exact connection allow-list may bypass
   * global paper mode only for authenticated BingX Prod-VST virtual funds. */
  allowForcedSimulationForAuthorizedVst?: boolean
}

// Perpetual-type equivalents - these all mean the same thing across exchanges
const PERP_TYPES = new Set(["perpetual", "perpetual_futures", "perp", "swap", "futures"])

const API_TYPE_ALIASES: Record<string, string> = {
  unified_trading: "unified",
  unifiedtrading: "unified",
  uta: "unified",
  derivatives: "contract",
}

/**
 * Convert API type to what the exchange actually accepts.
 * bingx needs "perpetual_futures", bybit needs "contract" or "unified",
 * pionex/orangex need "perpetual", etc.
 */
function convertApiType(apiType: string | undefined, exchangeSupported: string[] | undefined): string | undefined {
  if (!apiType || !exchangeSupported) return apiType
  apiType = API_TYPE_ALIASES[String(apiType).trim().toLowerCase()] || String(apiType).trim().toLowerCase()
  if (exchangeSupported.includes(apiType)) return apiType
  
  // If this is a perpetual-variant, find the one this exchange uses
  if (PERP_TYPES.has(apiType)) {
    if (exchangeSupported.includes("perpetual_futures")) return "perpetual_futures"
    if (exchangeSupported.includes("perpetual")) return "perpetual"
    if (exchangeSupported.includes("swap")) return "swap"
    if (exchangeSupported.includes("contract")) return "contract"  // Bybit V5 perpetuals
    if (exchangeSupported.includes("unified")) return "unified"      // Bybit V5 unified account
    if (exchangeSupported.includes("inverse")) return "inverse"      // Bybit inverse
  }
  
  return apiType
}

export async function createExchangeConnector(
  exchange: string,
  credentials: ExchangeCredentials,
  options: ExchangeConnectorCreationOptions = {},
): Promise<BaseExchangeConnector> {
  const rawExchange = String(exchange || "").toLowerCase()
  let normalizedExchange = rawExchange.replace(/[^a-z]/g, "")
  // Treat any BingX-labelled connection (e.g. "BingX X01", "bingx-main")
  // as the real BingX connector. Production operators often name their base
  // connection after the display label; falling through to the default branch
  // could otherwise create a simulated connector in non-prod or fail in prod.
  if (normalizedExchange.includes("bingx")) normalizedExchange = "bingx"
  else if (normalizedExchange.includes("bybit")) normalizedExchange = "bybit"
  else if (normalizedExchange.includes("instaforex") || normalizedExchange.includes("instafx")) normalizedExchange = "instaforex"
  const supported = EXCHANGE_API_TYPES[normalizedExchange]

  if (normalizedExchange === "instaforex") {
    credentials.apiType = credentials.apiType || "forex"
    credentials.contractType = credentials.contractType || "forex"
    credentials.marketType = "forex"
    credentials.isTestnet = false
  }
  
  // Convert API type to what this exchange accepts
  credentials.apiType = convertApiType(credentials.apiType, supported)
  
  // Validate
  if (credentials.apiType && supported && !supported.includes(credentials.apiType)) {
    throw new Error(
      `Invalid API type '${credentials.apiType}' for ${exchange}. Supported: ${supported.join(", ")}`
    )
  }

  // DEV/TEST: prefer simulated connector when API key is a placeholder or
  // FORCE_SIMULATED is explicitly set. The explicit safety override applies
  // uniformly to every exchange, including BingX.
  const authorizedVstOverride =
    options.allowForcedSimulationForAuthorizedVst === true
    && normalizedExchange === "bingx"
    && credentials.isTestnet === true
  const forceSim = isForcedSimulation() && !authorizedVstOverride
  const allowProdSim = process.env.ALLOW_PROD_SIMULATED === "1"
  const isProduction = process.env.NODE_ENV === "production"
  const hasRealCredentials = hasUsableLiveCredentials({
    api_key: credentials.apiKey,
    api_secret: credentials.apiSecret,
  })
  const isInstaForex = normalizedExchange === "instaforex"
  // InstaForex's supported HTTP surface is intentionally read-only. A
  // quote-only or account-read connector must not be replaced with a paper
  // connector merely because it has no crypto-style API secret.
  const shouldUseSim = forceSim || (!isInstaForex && !hasRealCredentials && (!isProduction || allowProdSim))
  if (shouldUseSim) {
    try {
      const { SimulatedConnector } = await import("./simulated-connector")
      return new SimulatedConnector(credentials, "simulated")
    } catch (error) {
      throw new Error(
        `Simulated exchange connector is unavailable while simulation is required: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  if (!hasRealCredentials && !isInstaForex) {
    throw new Error(
      `Valid ${exchange} credentials are required because production simulation is not enabled`,
    )
  }

  switch (normalizedExchange) {
    case "simulated": {
      const { SimulatedConnector } = await import("./simulated-connector")
      return new SimulatedConnector(credentials, "simulated")
    }
    case "bybit": {
      const { BybitConnector } = await import("./bybit-connector")
      return new BybitConnector(credentials, "bybit")
    }
    case "bingx": {
      // Prefer the installed `bingx-api` library for supported mainnet swap
      // calls and fall back to the built-in signed BingX REST implementation.
      // The npm package is community maintained; the REST contract remains the
      // official exchange interface and safety fallback.
      const { BingXConnector } = await import("./bingx-connector")
      return new BingXConnector(credentials, "bingx")
    }
    case "pionex": {
      const { PionexConnector } = await import("./pionex-connector")
      return new PionexConnector(credentials, "pionex")
    }
    case "orangex": {
      const { OrangeXConnector } = await import("./orangex-connector")
      return new OrangeXConnector(credentials, "orangex")
    }
    case "binance": {
      const { BinanceConnector } = await import("./binance-connector")
      return new BinanceConnector(credentials, "binance")
    }
    case "okx": {
      const { OKXConnector } = await import("./okx-connector")
      return new OKXConnector(credentials, "okx")
    }
    case "instaforex": {
      const { InstaForexConnector } = await import("./instaforex-connector")
      return new InstaForexConnector(credentials, "instaforex")
    }
    default:
      // Unknown exchange — fallback to SimulatedConnector only outside production.
      // In production, fail closed so operators see the unsupported exchange
      // instead of believing live exchange orders were placed.
      if (process.env.NODE_ENV !== "production" || process.env.ALLOW_PROD_SIMULATED === "1") {
        try {
          const { SimulatedConnector } = await import("./simulated-connector")
          return new SimulatedConnector(credentials, "simulated")
        } catch {
          // fall through to explicit unsupported error
        }
      }
      throw new Error(`Unsupported exchange: ${exchange}. Supported exchanges: bybit, bingx, pionex, orangex, binance, okx, instaforex`)
  }
}

export type { ExchangeConnectorResult, ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"
