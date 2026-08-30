import { MIN_VOLUME_FACTOR } from "@/lib/constants"
/**
 * ConnectionManager v2 - Modern Connection Management with Redis Storage
 * Handles all connection CRUD operations, validation, and lifecycle management via Redis
 */

import { initRedis, getAllConnections, getConnection, updateConnection, createConnection, deleteConnection } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import type { MarketType } from "@/lib/market-types"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  resolveForexExecutionMode,
} from "@/lib/forex-market"

// Modern Connection Types with v2 Schema (matches Redis storage)
export interface ConnectionV2 {
  id: string
  name: string
  exchange: string
  api_type: "spot" | "perpetual_futures" | "inverse_futures" | "forex" | string
  connection_method: "rest" | "websocket" | "hybrid" | "bridge"
  connection_library: string
  authentication_type: "api_key_secret" | "oauth2" | "webhook"
  api_key: string
  api_secret: string
  api_passphrase?: string
  account_id?: string
  account_password?: string
  bridge_token?: string
  bridge_url?: string
  terminal_path?: string
  market_type?: MarketType
  asset_class?: MarketType
  api_base_url?: string
  quotes_base_url?: string
  charts_url?: string
  account_server?: string
  quantity_unit?: "base_units" | "lots" | "contracts" | string
  lot_size?: number | string
  position_cost_percent?: number | string
  spread_buffer_pips?: number | string
  spread_multiplier?: number | string
  positions_average?: number | string
  average_count?: number | string
  max_spread_pips?: number | string
  spread_mode?: string
  execution_mode?: string
  forex_execution_mode?: "read_only" | "mt5_bridge" | string
  read_only?: boolean
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
  api_type: "spot" | "perpetual_futures" | "inverse_futures" | "forex" | string
  connection_method: "rest" | "websocket" | "hybrid" | "bridge"
  api_key: string
  api_secret: string
  api_passphrase?: string
  account_id?: string
  account_password?: string
  bridge_token?: string
  bridge_url?: string
  terminal_path?: string
  market_type?: MarketType
  asset_class?: MarketType
  api_base_url?: string
  quotes_base_url?: string
  charts_url?: string
  account_server?: string
  quantity_unit?: "base_units" | "lots" | "contracts" | string
  lot_size?: number | string
  position_cost_percent?: number | string
  spread_buffer_pips?: number | string
  spread_multiplier?: number | string
  positions_average?: number | string
  average_count?: number | string
  max_spread_pips?: number | string
  spread_mode?: string
  execution_mode?: string
  forex_execution_mode?: "read_only" | "mt5_bridge" | string
  connection_library?: string
  read_only?: boolean
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
  account_id?: string
  account_password?: string
  bridge_token?: string
  bridge_url?: string
  terminal_path?: string
  market_type?: MarketType
  asset_class?: MarketType
  api_base_url?: string
  quotes_base_url?: string
  charts_url?: string
  account_server?: string
  quantity_unit?: "base_units" | "lots" | "contracts" | string
  lot_size?: number | string
  position_cost_percent?: number | string
  spread_buffer_pips?: number | string
  spread_multiplier?: number | string
  positions_average?: number | string
  average_count?: number | string
  max_spread_pips?: number | string
  spread_mode?: string
  execution_mode?: string
  forex_execution_mode?: "read_only" | "mt5_bridge" | string
  connection_method?: "rest" | "websocket" | "hybrid" | "bridge"
  connection_library?: string
  read_only?: boolean
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
      const exchangeName = String(input.exchange || "").trim().toLowerCase().replace(/[^a-z]/g, "")
      const isInstaForex = exchangeName === "instaforex" || exchangeName === "instafx" || input.market_type === "forex" || input.asset_class === "forex"
      const forexExecutionMode = isInstaForex
        ? resolveForexExecutionMode(input as any)
        : undefined
      const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
        ...input,
        forex_execution_mode: forexExecutionMode,
      })
      const conn: ConnectionV2 = {
        id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: input.name,
        exchange: input.exchange,
        api_type: input.api_type,
        connection_method: isInstaForex ? (bridgeSelected ? "bridge" : "rest") : input.connection_method,
        connection_library: isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (input.connection_library || "rest"),
        authentication_type: "api_key_secret",
        api_key: isInstaForex ? (input.account_id || input.api_key) : input.api_key,
        api_secret: isInstaForex ? "" : input.api_secret,
        api_passphrase: input.api_passphrase,
        account_id: input.account_id,
        account_password: isInstaForex && bridgeSelected ? input.account_password : undefined,
        bridge_token: isInstaForex && bridgeSelected ? input.bridge_token : undefined,
        bridge_url: isInstaForex && bridgeSelected && isValidForexBridgeUrl(input.bridge_url) ? input.bridge_url : undefined,
        terminal_path: isInstaForex && bridgeSelected ? input.terminal_path : undefined,
        market_type: isInstaForex ? "forex" : input.market_type,
        asset_class: isInstaForex ? "forex" : (input.asset_class || input.market_type),
        api_base_url: input.api_base_url,
        quotes_base_url: input.quotes_base_url,
        charts_url: input.charts_url,
        account_server: input.account_server,
        quantity_unit: isInstaForex ? "lots" : input.quantity_unit,
        lot_size: isInstaForex ? (input.lot_size ?? DEFAULT_FOREX_LOT_SIZE) : input.lot_size,
        position_cost_percent: isInstaForex ? (input.position_cost_percent ?? 0.1) : input.position_cost_percent,
        spread_buffer_pips: isInstaForex ? (input.spread_buffer_pips ?? DEFAULT_FOREX_SPREAD_BUFFER_PIPS) : input.spread_buffer_pips,
        spread_multiplier: isInstaForex ? (input.spread_multiplier ?? DEFAULT_FOREX_SPREAD_MULTIPLIER) : input.spread_multiplier,
        positions_average: isInstaForex ? (input.positions_average ?? input.average_count ?? DEFAULT_FOREX_POSITIONS_AVERAGE) : input.positions_average,
        average_count: isInstaForex ? (input.average_count ?? input.positions_average ?? DEFAULT_FOREX_POSITIONS_AVERAGE) : input.average_count,
        max_spread_pips: isInstaForex ? (input.max_spread_pips ?? 3) : input.max_spread_pips,
        spread_mode: isInstaForex ? (input.spread_mode ?? "exchange") : input.spread_mode,
        execution_mode: isInstaForex ? forexExecutionMode : input.execution_mode,
        forex_execution_mode: isInstaForex ? forexExecutionMode : undefined,
        read_only: isInstaForex ? !bridgeSelected : input.read_only,
        margin_type: input.margin_type,
        position_mode: input.position_mode,
        is_testnet: isInstaForex ? false : input.is_testnet,
        is_enabled: "0",
        is_enabled_dashboard: "0",
        is_live_trade: "0",
        is_preset_trade: "0",
        is_predefined: false,
        volume_factor: MIN_VOLUME_FACTOR,
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

      const exchangeName = String(conn.exchange || "").trim().toLowerCase().replace(/[^a-z]/g, "")
      const isInstaForex = exchangeName === "instaforex" || exchangeName === "instafx" || input.market_type === "forex" || input.asset_class === "forex"
      const forexExecutionMode = isInstaForex
        ? resolveForexExecutionMode({ ...(conn as any), ...(input as any) })
        : undefined
      const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
        ...(conn as any),
        ...input,
        forex_execution_mode: forexExecutionMode,
      })
      const normalizedInput = {
        ...input,
        ...(isInstaForex ? {
          api_key: input.account_id || input.api_key || (conn as any).account_id || (conn as any).api_key,
          api_secret: "",
          market_type: "forex",
          asset_class: "forex",
          connection_method: bridgeSelected ? "bridge" : "rest",
          connection_library: bridgeSelected ? "mt5-bridge" : "native-http",
          execution_mode: forexExecutionMode,
          forex_execution_mode: forexExecutionMode,
          account_password: bridgeSelected ? (input.account_password ?? (conn as any).account_password) : "",
          bridge_token: bridgeSelected ? (input.bridge_token ?? (conn as any).bridge_token) : "",
          bridge_url: bridgeSelected
            ? (isValidForexBridgeUrl(input.bridge_url ?? (conn as any).bridge_url) ? (input.bridge_url ?? (conn as any).bridge_url) : undefined)
            : "",
          terminal_path: bridgeSelected ? (input.terminal_path ?? (conn as any).terminal_path) : "",
          quantity_unit: "lots",
          lot_size: input.lot_size ?? (conn as any).lot_size ?? DEFAULT_FOREX_LOT_SIZE,
          position_cost_percent: input.position_cost_percent ?? (conn as any).position_cost_percent ?? 0.1,
          spread_buffer_pips: input.spread_buffer_pips ?? (conn as any).spread_buffer_pips ?? DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
          spread_multiplier: input.spread_multiplier ?? (conn as any).spread_multiplier ?? DEFAULT_FOREX_SPREAD_MULTIPLIER,
          positions_average: input.positions_average ?? input.average_count ?? (conn as any).positions_average ?? (conn as any).average_count ?? DEFAULT_FOREX_POSITIONS_AVERAGE,
          average_count: input.average_count ?? input.positions_average ?? (conn as any).average_count ?? (conn as any).positions_average ?? DEFAULT_FOREX_POSITIONS_AVERAGE,
          max_spread_pips: input.max_spread_pips ?? (conn as any).max_spread_pips ?? 3,
          spread_mode: input.spread_mode ?? (conn as any).spread_mode ?? "exchange",
          read_only: !bridgeSelected,
          is_testnet: false,
        } : {}),
        ...(input.volume_factor !== undefined ? { volume_factor: MIN_VOLUME_FACTOR } : {}),
      }
      const updated = {
        ...conn,
        ...normalizedInput,
        updated_at: new Date().toISOString(),
      }

      const persisted = await updateConnection(id, { ...normalizedInput, updated_at: updated.updated_at })
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
