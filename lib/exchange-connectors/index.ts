/**
 * Exchange Connector Factory v3.0
 * Creates appropriate connector based on exchange name
 * Handles API type normalization between perpetual/perpetual_futures variants
 */

import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"

// Perpetual-type equivalents - these all mean the same thing across exchanges
const PERP_TYPES = new Set(["perpetual", "perpetual_futures", "perp", "swap", "futures"])

/**
 * Convert API type to what the exchange actually accepts.
 * bingx needs "perpetual_futures", bybit needs "contract" or "unified",
 * pionex/orangex need "perpetual", etc.
 */
function convertApiType(apiType: string | undefined, exchangeSupported: string[] | undefined): string | undefined {
  if (!apiType || !exchangeSupported) return apiType
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
  credentials: ExchangeCredentials
): Promise<BaseExchangeConnector> {
  const rawExchange = String(exchange || "").toLowerCase()
  let normalizedExchange = rawExchange.replace(/[^a-z]/g, "")
  // Treat any BingX-labelled connection (e.g. "BingX X01", "bingx-main")
  // as the real BingX connector. Production operators often name their base
  // connection after the display label; falling through to the default branch
  // could otherwise create a simulated connector in non-prod or fail in prod.
  if (normalizedExchange.includes("bingx")) normalizedExchange = "bingx"
  const supported = EXCHANGE_API_TYPES[normalizedExchange]
  
  // Convert API type to what this exchange accepts
  const originalType = credentials.apiType
  credentials.apiType = convertApiType(credentials.apiType, supported)
  
  // Validate
  if (credentials.apiType && supported && !supported.includes(credentials.apiType)) {
    throw new Error(
      `Invalid API type '${credentials.apiType}' for ${exchange}. Supported: ${supported.join(", ")}`
    )
  }

  // DEV/TEST: prefer simulated connector when API key is a placeholder or FORCE_SIMULATED set.
  // Production must never silently swap a real exchange connector for simulation
  // when real credentials are configured; that is how QuickStart ended up
  // showing "sim" instead of placing live exchange orders.
  try {
    const forceSim = process.env.FORCE_SIMULATED === "1"
    const allowProdSim = process.env.ALLOW_PROD_SIMULATED === "1"
    const isProduction = process.env.NODE_ENV === "production"
    const keyStr = String(credentials.apiKey || "")
    const secretStr = String(credentials.apiSecret || "")
    const hasRealCredentials =
      keyStr.length >= 10 &&
      secretStr.length >= 10 &&
      !/PLACEHOLDER|00998877|^test/i.test(keyStr) &&
      !/PLACEHOLDER|00998877|^test/i.test(secretStr)
    const shouldUseSim = !hasRealCredentials || (forceSim && normalizedExchange !== "bingx")
    if (shouldUseSim && (!isProduction || allowProdSim)) {
      const { SimulatedConnector } = await import("./simulated-connector")
      return new SimulatedConnector(credentials, "simulated")
    }
  } catch (e) {
    // ignore and fall back to normal creation
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
      // Use official SDK client (bingx-api library) for instant order execution
      // SDK handles connection pooling, signing, and timestamp sync automatically
      // Falls back to manual REST if SDK initialization fails
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
      throw new Error(`Unsupported exchange: ${exchange}. Supported exchanges: bybit, bingx, pionex, orangex, binance, okx`)
  }
}

export type { ExchangeConnectorResult, ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"
