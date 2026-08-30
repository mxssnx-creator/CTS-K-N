import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import {
  createExchangeConnector,
  type ExchangeConnectorCreationOptions,
} from "./index"
import { getConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import type { Connection } from "@/lib/db-types"
import { normalizeMarketType } from "@/lib/market-types"
import { createHash } from "node:crypto"
import {
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  resolveForexExecutionMode,
} from "@/lib/forex-market"

export { createExchangeConnector }
export type { ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"

// A production worker can call getOrCreateConnector from several high-rate
// loops (market-data, live-position recovery, and order-history refresh).
// Retrying an impossible connector construction on every tick allocates SDK
// state and floods stderr, which in turn makes the Linux process appear to
// leak memory/CPU. Keep the failure local and short-lived; a credential or
// mode update changes the fingerprint and bypasses this backoff immediately.
const FAILED_CONNECTOR_BACKOFF_MS = Math.max(
  5_000,
  Math.min(300_000, Number(process.env.CTS_CONNECTOR_FAILURE_BACKOFF_MS || 30_000)),
)

export class ExchangeConnectorFactory {
  private static instance: ExchangeConnectorFactory
  private connectors: Map<string, BaseExchangeConnector> = new Map()
  private connectorFingerprints: Map<string, string> = new Map()
  private unavailableConnectorFingerprints: Map<string, { fingerprint: string; retryAt: number }> = new Map()
  
  private constructor() {}
  
  static getInstance(): ExchangeConnectorFactory {
    if (!ExchangeConnectorFactory.instance) {
      ExchangeConnectorFactory.instance = new ExchangeConnectorFactory()
    }
    return ExchangeConnectorFactory.instance
  }
  
  static getConnector(connectionId: string): BaseExchangeConnector | null {
    return ExchangeConnectorFactory.getInstance().connectors.get(connectionId) || null
  }

  private connectorCacheKey(
    connectionId: string,
    options: ExchangeConnectorCreationOptions = {},
  ): string {
    return options.allowForcedSimulationForAuthorizedVst === true
      ? `${connectionId}::authorized-vst-live`
      : connectionId
  }
  
  private resolveExchangeName(connection: Connection): string {
    const raw = String(connection.exchange || "")
    const compact = raw.toLowerCase().replace(/[^a-z]/g, "")
    if (compact.includes("bingx") || String(connection.id || "").toLowerCase().startsWith("bingx")) {
      return "bingx"
    }
    if (compact.includes("bybit") || String(connection.id || "").toLowerCase().startsWith("bybit")) {
      return "bybit"
    }
    if (compact.includes("instaforex") || compact.includes("instafx") || String(connection.id || "").toLowerCase().startsWith("instaforex")) {
      return "instaforex"
    }
    return raw
  }

  private buildCredentials(connection: Connection): ExchangeCredentials {
    const exchange = this.resolveExchangeName(connection)
    const isInstaForex = exchange === "instaforex"
    const marketType = normalizeMarketType(connection.market_type || connection.asset_class, exchange)
    const accountId = String(connection.account_id || (isInstaForex ? connection.api_key || "" : "")).trim()
    const forexExecutionMode = isInstaForex ? resolveForexExecutionMode(connection as any) : undefined
    const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected(connection)
    const finiteOptional = (value: unknown): number | undefined => {
      if (value === null || value === undefined || value === "") return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return {
      // InstaForex identifies the account by its numeric login. Official REST
      // remains read-only; mutations are possible only through the explicit,
      // separately hosted terminal bridge.
      apiKey: isInstaForex ? accountId : connection.api_key || "",
      apiSecret: isInstaForex ? "" : connection.api_secret || "",
      // For InstaForex the optional passphrase is the Client Cabinet API
      // passkey. It is never used by the private terminal bridge.
      apiPassphrase: isInstaForex ? String(connection.api_passphrase ?? connection.passphrase ?? "") || undefined : connection.api_passphrase,
      accountId: accountId || undefined,
      accountPassword: isInstaForex ? String(connection.account_password ?? connection.trader_password ?? connection.mt5_password ?? "") : undefined,
      accountServer: isInstaForex ? String(connection.account_server ?? "") || undefined : undefined,
      bridgeUrl: bridgeSelected && isValidForexBridgeUrl(connection.bridge_url) ? String(connection.bridge_url).trim() : undefined,
      bridgeToken: bridgeSelected ? String(connection.bridge_token ?? "") || undefined : undefined,
      terminalPath: bridgeSelected ? String(connection.terminal_path ?? "") || undefined : undefined,
      forexExecutionMode,
      apiBaseUrl: connection.api_base_url,
      quotesBaseUrl: connection.quotes_base_url,
      chartsUrl: connection.charts_url,
      positionsAverage: finiteOptional(connection.positions_average ?? connection.average_count),
      executionMode: isInstaForex ? forexExecutionMode : connection.execution_mode,
      readOnly: isInstaForex ? !bridgeSelected : isTruthyFlag(connection.read_only),
      symbolSuffix: connection.symbol_suffix,
      lotSize: finiteOptional(connection.lot_size),
      quantityUnit: connection.quantity_unit === "base_units" || connection.quantity_unit === "contracts" || connection.quantity_unit === "lots"
        ? connection.quantity_unit
        : undefined,
      positionCostPercent: finiteOptional(connection.position_cost_percent),
      spreadBufferPips: finiteOptional(connection.spread_buffer_pips),
      spreadMultiplier: finiteOptional(connection.spread_multiplier),
      marketType,
      isTestnet: isInstaForex ? false : isTruthyFlag(connection.is_testnet),
      apiType: connection.api_type || (isInstaForex ? "forex" : undefined),
      contractType: connection.contract_type || (isInstaForex ? "forex" : undefined),
      marginType: connection.margin_type,
      positionMode: isInstaForex ? "one_way" : connection.position_mode,
      connectionMethod: exchange === "bingx" ? "library" : (isInstaForex ? (bridgeSelected ? "bridge" : "rest") : (connection.connection_method || undefined)),
      connectionLibrary: this.resolveExchangeName(connection) === "bingx" ? "sdk" : (isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (connection.connection_library || undefined)),
    }
  }

  private buildFingerprint(connection: Connection): string {
    const finiteOrBlank = (value: unknown): number | string => {
      if (value === null || value === undefined || value === "") return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }
    const exchange = this.resolveExchangeName(connection)
    const isInstaForex = exchange === "instaforex"
    const forexExecutionMode = isInstaForex ? resolveForexExecutionMode(connection as any) : undefined
    const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected(connection)
    const secretFingerprint = (value: unknown): string => {
      const raw = String(value ?? "")
      return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : ""
    }
    return JSON.stringify({
      api_key: isInstaForex ? connection.api_key || "" : connection.api_key || "",
      api_secret: isInstaForex ? "" : connection.api_secret || "",
      api_passphrase: isInstaForex
        ? secretFingerprint(connection.api_passphrase ?? connection.passphrase)
        : connection.api_passphrase || "",
      account_id: connection.account_id || (this.resolveExchangeName(connection) === "instaforex" ? connection.api_key || "" : ""),
      market_type: normalizeMarketType(connection.market_type || connection.asset_class, this.resolveExchangeName(connection)),
      api_base_url: connection.api_base_url || "",
      quotes_base_url: connection.quotes_base_url || "",
      charts_url: connection.charts_url || "",
      account_server: connection.account_server || "",
      account_password: isInstaForex ? secretFingerprint(connection.account_password ?? connection.trader_password ?? connection.mt5_password) : "",
      bridge_url: isInstaForex ? connection.bridge_url || "" : "",
      bridge_token: isInstaForex ? secretFingerprint(connection.bridge_token) : "",
      terminal_path: isInstaForex ? connection.terminal_path || "" : "",
      positions_average: finiteOrBlank(connection.positions_average ?? connection.average_count),
      lot_size: finiteOrBlank(connection.lot_size),
      position_cost_percent: finiteOrBlank(connection.position_cost_percent),
      spread_buffer_pips: finiteOrBlank(connection.spread_buffer_pips),
      spread_multiplier: finiteOrBlank(connection.spread_multiplier),
      forex_execution_mode: forexExecutionMode || "",
      execution_mode: isInstaForex ? (forexExecutionMode || "read_only") : (connection.execution_mode || ""),
      read_only: isInstaForex ? !bridgeSelected : connection.read_only || "",
      is_testnet: isTruthyFlag(connection.is_testnet),
      api_type: connection.api_type || "",
      contract_type: connection.contract_type || "",
      margin_type: connection.margin_type || "",
      position_mode: isInstaForex ? "one_way" : (connection.position_mode || ""),
      connection_method: exchange === "bingx" ? "library" : (isInstaForex ? (bridgeSelected ? "bridge" : "rest") : (connection.connection_method || "")),
      connection_library: exchange === "bingx" ? "sdk" : (isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (connection.connection_library || "")),
      exchange: exchange || "",
    })
  }

  async createConnector(
    connection: Connection,
    options: ExchangeConnectorCreationOptions = {},
  ): Promise<BaseExchangeConnector | null> {
    const cacheKey = this.connectorCacheKey(connection.id, options)
    try {
      const credentials = this.buildCredentials(connection)
      const fingerprint = this.buildFingerprint(connection)
      
      try {
        const connector = options.allowForcedSimulationForAuthorizedVst === true
          ? await createExchangeConnector(
              this.resolveExchangeName(connection),
              credentials,
              options,
            )
          : await createExchangeConnector(this.resolveExchangeName(connection), credentials)
        await (connector as any).warmUpFastPath?.().catch((error: unknown) => {
          console.warn(
            `[ExchangeConnectorFactory] Fast-path SDK warmup failed for ${connection.id}:`,
            error instanceof Error ? error.message : String(error),
          )
        })
        this.connectors.set(cacheKey, connector)
        this.connectorFingerprints.set(cacheKey, fingerprint)
        this.unavailableConnectorFingerprints.delete(cacheKey)
        return connector
      } catch (err) {
        const priorFailure = this.unavailableConnectorFingerprints.get(cacheKey)
        const retryAt = Date.now() + FAILED_CONNECTOR_BACKOFF_MS
        this.unavailableConnectorFingerprints.set(cacheKey, { fingerprint, retryAt })
        if (!priorFailure || priorFailure.fingerprint !== fingerprint || priorFailure.retryAt <= Date.now()) {
          console.warn(
            `[ExchangeConnectorFactory] createExchangeConnector unavailable for ${connection.id}; ` +
            `backing off retries for ${FAILED_CONNECTOR_BACKOFF_MS}ms:`,
            err instanceof Error ? err.message : String(err),
          )
        }
        // Fallback for dev/test only: use simulated connector so the live pipeline
        // can be exercised locally. Production must fail closed instead of
        // silently turning a live exchange request into paper/sim mode.
        if (process.env.NODE_ENV !== "production" || process.env.ALLOW_PROD_SIMULATED === "1") {
          try {
            const { SimulatedConnector } = await import("./simulated-connector")
            const sim = new SimulatedConnector(credentials, "simulated")
            this.connectors.set(cacheKey, sim)
            this.connectorFingerprints.set(cacheKey, fingerprint)
            this.unavailableConnectorFingerprints.delete(cacheKey)
            console.log(`[ExchangeConnectorFactory] Fallback to SimulatedConnector for ${connection.id}`)
            return sim
          } catch (err2) {
            console.error(`[ExchangeConnectorFactory] Failed to create SimulatedConnector for ${connection.id}:`, err2)
            return null
          }
        }
        return null
      }
    } catch (err) {
      console.error(`[ExchangeConnectorFactory] Failed to create connector for ${connection.id}:`, err)
      return null
    }
  }
  
  getConnector(connectionId: string): BaseExchangeConnector | null {
    return this.connectors.get(connectionId) || null
  }
  
  async getOrCreateConnector(
    connectionId: string,
    options: ExchangeConnectorCreationOptions = {},
  ): Promise<BaseExchangeConnector | null> {
    const connection = await getConnection(connectionId)
    if (!connection) {
      console.error(`[ExchangeConnectorFactory] Connection not found: ${connectionId}`)
      return null
    }

    const fingerprint = this.buildFingerprint(connection as Connection)
    const cacheKey = this.connectorCacheKey(connectionId, options)
    const existing = this.connectors.get(cacheKey)
    if (existing && this.connectorFingerprints.get(cacheKey) === fingerprint) {
      return existing
    }

    const unavailable = this.unavailableConnectorFingerprints.get(cacheKey)
    if (unavailable && unavailable.fingerprint === fingerprint && unavailable.retryAt > Date.now()) {
      return null
    }
    if (unavailable) this.unavailableConnectorFingerprints.delete(cacheKey)

    if (existing) {
      this.removeConnector(connectionId)
    }
    
    return this.createConnector(connection as Connection, options)
  }
  
  removeConnector(connectionId: string): void {
    for (const key of new Set([
      ...this.connectors.keys(),
      ...this.connectorFingerprints.keys(),
      ...this.unavailableConnectorFingerprints.keys(),
    ])) {
      if (key !== connectionId && !key.startsWith(`${connectionId}::`)) continue
      this.connectors.delete(key)
      this.connectorFingerprints.delete(key)
      this.unavailableConnectorFingerprints.delete(key)
    }
  }
  
  clearAll(): void {
    this.connectors.clear()
    this.connectorFingerprints.clear()
    this.unavailableConnectorFingerprints.clear()
  }
  
  hasConnector(connectionId: string): boolean {
    return [...this.connectors.keys()].some((key) => (
      key === connectionId || key.startsWith(`${connectionId}::`)
    ))
  }
  
  getAllConnectorIds(): string[] {
    return [...new Set(Array.from(this.connectors.keys(), (key) => key.split("::", 1)[0]))]
  }
}

export const exchangeConnectorFactory = ExchangeConnectorFactory.getInstance()
