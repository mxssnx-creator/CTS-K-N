import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { createExchangeConnector } from "./index"
import { getConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import type { Connection } from "@/lib/db-types"

export { createExchangeConnector }
export type { ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"

export class ExchangeConnectorFactory {
  private static instance: ExchangeConnectorFactory
  private connectors: Map<string, BaseExchangeConnector> = new Map()
  private connectorFingerprints: Map<string, string> = new Map()
  
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
  
  private resolveExchangeName(connection: Connection): string {
    const raw = String(connection.exchange || "")
    const compact = raw.toLowerCase().replace(/[^a-z]/g, "")
    if (compact.includes("bingx") || String(connection.id || "").toLowerCase().startsWith("bingx")) {
      return "bingx"
    }
    return raw
  }

  private buildCredentials(connection: Connection): ExchangeCredentials {
    return {
      apiKey: connection.api_key || "",
      apiSecret: connection.api_secret || "",
      apiPassphrase: connection.api_passphrase,
      isTestnet: isTruthyFlag(connection.is_testnet),
      apiType: connection.api_type,
      contractType: connection.contract_type,
      marginType: connection.margin_type,
      positionMode: connection.position_mode,
      connectionMethod: connection.connection_method,
      connectionLibrary: connection.connection_library,
    }
  }

  private buildFingerprint(connection: Connection): string {
    return JSON.stringify({
      api_key: connection.api_key || "",
      api_secret: connection.api_secret || "",
      api_passphrase: connection.api_passphrase || "",
      is_testnet: isTruthyFlag(connection.is_testnet),
      api_type: connection.api_type || "",
      contract_type: connection.contract_type || "",
      margin_type: connection.margin_type || "",
      position_mode: connection.position_mode || "",
      connection_method: connection.connection_method || "",
      connection_library: connection.connection_library || "",
      exchange: this.resolveExchangeName(connection) || "",
    })
  }

  async createConnector(connection: Connection): Promise<BaseExchangeConnector | null> {
    try {
      const credentials = this.buildCredentials(connection)
      const fingerprint = this.buildFingerprint(connection)
      
      try {
        const connector = await createExchangeConnector(this.resolveExchangeName(connection), credentials)
        this.connectors.set(connection.id, connector)
        this.connectorFingerprints.set(connection.id, fingerprint)
        return connector
      } catch (err) {
        console.error(`[ExchangeConnectorFactory] createExchangeConnector failed for ${connection.id}:`, err)
        // Fallback for dev/test only: use simulated connector so the live pipeline
        // can be exercised locally. Production must fail closed instead of
        // silently turning a live exchange request into paper/sim mode.
        if (process.env.NODE_ENV !== "production" || process.env.ALLOW_PROD_SIMULATED === "1") {
          try {
            const { SimulatedConnector } = await import("./simulated-connector")
            const sim = new SimulatedConnector(credentials, "simulated")
            this.connectors.set(connection.id, sim)
            this.connectorFingerprints.set(connection.id, fingerprint)
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
  
  async getOrCreateConnector(connectionId: string): Promise<BaseExchangeConnector | null> {
    const connection = await getConnection(connectionId)
    if (!connection) {
      console.error(`[ExchangeConnectorFactory] Connection not found: ${connectionId}`)
      return null
    }

    const fingerprint = this.buildFingerprint(connection as Connection)
    const existing = this.connectors.get(connectionId)
    if (existing && this.connectorFingerprints.get(connectionId) === fingerprint) {
      return existing
    }

    if (existing) {
      this.removeConnector(connectionId)
    }
    
    return this.createConnector(connection as Connection)
  }
  
  removeConnector(connectionId: string): void {
    this.connectors.delete(connectionId)
    this.connectorFingerprints.delete(connectionId)
  }
  
  clearAll(): void {
    this.connectors.clear()
    this.connectorFingerprints.clear()
  }
  
  hasConnector(connectionId: string): boolean {
    return this.connectors.has(connectionId)
  }
  
  getAllConnectorIds(): string[] {
    return Array.from(this.connectors.keys())
  }
}

export const exchangeConnectorFactory = ExchangeConnectorFactory.getInstance()
