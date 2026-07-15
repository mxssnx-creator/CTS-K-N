import { MIN_VOLUME_FACTOR } from "@/lib/constants"
/**
 * ConnectionManager v2 - Modern Connection Management with Redis Storage
 * Handles all connection CRUD operations, validation, and lifecycle management via Redis
 */

import { initRedis, getAllConnections, getConnection, updateConnection, createConnection, deleteConnection } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

// Modern Connection Types with v2 Schema (matches Redis storage)
export interface ConnectionV2 {
  id: string
  name: string
  exchange: string
  api_type: "spot" | "perpetual_futures" | "inverse_futures"
  connection_method: "rest" | "websocket" | "hybrid"
  connection_library: "rest" | "ws" | "library"
  authentication_type: "api_key_secret" | "oauth2" | "webhook"
  api_key: string
  api_secret: string
  api_passphrase?: string
  margin_type: "isolated" | "cross"
  position_mode: "one_way" | "hedge"
  is_testnet: boolean
  is_enabled: boolean | string
  is_enabled_dashboard: string
  is_live_trade: boolean | string
  is_preset_trade: boolean | string
  is_predefined: boolean
  volume_factor: number
  last_test_status?: "success" | "failed" | "warning"
  last_test_balance?: number
  last_test_log?: string[]
  last_test_at?: string
  api_capabilities?: string
  created_at: string
  updated_at: string
  is_active?: boolean
}

export interface ConnectionCreateInput {
  name: string
  exchange: string
  api_type: "spot" | "perpetual_futures" | "inverse_futures"
  connection_method: "rest" | "websocket" | "hybrid"
  api_key: string
  api_secret: string
  api_passphrase?: string
  margin_type: "isolated" | "cross"
  position_mode: "one_way" | "hedge"
  is_testnet: boolean
  volume_factor?: number
}

export interface ConnectionUpdateInput {
  name?: string
  api_key?: string
  api_secret?: string
  api_passphrase?: string
  margin_type?: "isolated" | "cross"
  position_mode?: "one_way" | "hedge"
  is_testnet?: boolean
  is_enabled?: boolean
  is_live_trade?: boolean
  is_preset_trade?: boolean
  volume_factor?: number
}

/**
 * ConnectionManagerV2 - Singleton for managing exchange connections with Redis
 */
export class ConnectionManagerV2 {
  private static instance: ConnectionManagerV2
  private initialized = false

  private constructor() {}

  static getInstance(): ConnectionManagerV2 {
    if (!ConnectionManagerV2.instance) {
      ConnectionManagerV2.instance = new ConnectionManagerV2()
    }
    return ConnectionManagerV2.instance
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    try {
      await initRedis()
      this.initialized = true
      console.log("[v0] ConnectionManagerV2 initialized with Redis storage")
    } catch (error) {
      console.error("[v0] Failed to initialize ConnectionManagerV2:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "initialize" })
    }
  }

  /**
   * Get all connections
   */
  async getAllConnections(): Promise<ConnectionV2[]> {
    try {
      await this.initialize()
      return (await getAllConnections()) as ConnectionV2[]
    } catch (error) {
      console.error("[v0] Failed to get all connections:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "getAllConnections" })
      return []
    }
  }

  /**
   * Get a specific connection
   */
  async getConnection(id: string): Promise<ConnectionV2 | null> {
    try {
      await this.initialize()
      const conn = await getConnection(id)
      return conn as ConnectionV2 | null
    } catch (error) {
      console.error("[v0] Failed to get connection:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "getConnection", id })
      return null
    }
  }

  /**
   * Create a new connection
   */
  async createConnection(input: ConnectionCreateInput): Promise<ConnectionV2 | null> {
    try {
      await this.initialize()

      const now = new Date().toISOString()
      const conn: ConnectionV2 = {
        id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: input.name,
        exchange: input.exchange,
        api_type: input.api_type,
        connection_method: input.connection_method,
        connection_library: "rest",
        authentication_type: "api_key_secret",
        api_key: input.api_key,
        api_secret: input.api_secret,
        api_passphrase: input.api_passphrase,
        margin_type: input.margin_type,
        position_mode: input.position_mode,
        is_testnet: input.is_testnet,
        is_enabled: "0",
        is_enabled_dashboard: "0",
        is_live_trade: "0",
        is_preset_trade: "0",
        is_predefined: false,
        volume_factor: input.volume_factor ?? MIN_VOLUME_FACTOR,
        created_at: now,
        updated_at: now,
      }

      await createConnection(conn)
      console.log("[v0] Connection created:", conn.id)
      return conn
    } catch (error) {
      console.error("[v0] Failed to create connection:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "createConnection" })
      return null
    }
  }

  /**
   * Update a connection
   */
  async updateConnection(id: string, input: ConnectionUpdateInput): Promise<ConnectionV2 | null> {
    try {
      await this.initialize()
      const conn = await getConnection(id)

      if (!conn) {
        throw new Error(`Connection not found: ${id}`)
      }

      const updated = {
        ...conn,
        ...input,
        updated_at: new Date().toISOString(),
      }

      const persisted = await updateConnection(id, { ...input, updated_at: updated.updated_at })
      console.log("[v0] Connection updated:", id)
      return (persisted || updated) as ConnectionV2
    } catch (error) {
      console.error("[v0] Failed to update connection:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "updateConnection", id })
      return null
    }
  }

  /**
   * Delete a connection
   */
  async deleteConnection(id: string): Promise<boolean> {
    try {
      await this.initialize()
      await deleteConnection(id)
      console.log("[v0] Connection deleted:", id)
      return true
    } catch (error) {
      console.error("[v0] Failed to delete connection:", error)
      await SystemLogger.logError("connection-manager-v2", error, { action: "deleteConnection", id })
      return false
    }
  }

  /**
   * Get connections by exchange
   */
  async getConnectionsByExchange(exchange: string): Promise<ConnectionV2[]> {
    try {
      await this.initialize()
      const all = await getAllConnections()
      return all.filter(c => c.exchange === exchange) as ConnectionV2[]
    } catch (error) {
      console.error("[v0] Failed to get connections by exchange:", error)
      return []
    }
  }

  /**
   * Get enabled connections only
   */
  async getEnabledConnections(): Promise<ConnectionV2[]> {
    try {
      await this.initialize()
      const all = await getAllConnections()
      return all.filter(c => c.is_enabled === "1" || c.is_enabled === true) as ConnectionV2[]
    } catch (error) {
      console.error("[v0] Failed to get enabled connections:", error)
      return []
    }
  }

  /**
   * Get active dashboard connections
   */
  async getActiveConnections(): Promise<ConnectionV2[]> {
    try {
      await this.initialize()
      const all = await getAllConnections()
      return all.filter(c => c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true) as ConnectionV2[]
    } catch (error) {
      console.error("[v0] Failed to get active connections:", error)
      return []
    }
  }
}

export interface ConnectionValidationResult {
  isValid: boolean
  errors: string[]
  warnings?: string[]
}

export const connectionManager = ConnectionManagerV2.getInstance()
export default ConnectionManagerV2
