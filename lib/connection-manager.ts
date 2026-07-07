/**
 * ConnectionManager v2
 * Modern connection management with Redis storage, proper state validation, error handling, and UI updates
 */

import { initRedis, getAllConnections, getConnection, updateConnection } from "@/lib/redis-db"
import type { Connection } from "@/lib/db-types"
import { SystemLogger } from "@/lib/system-logger"

export type ConnectionStatus = "active" | "inactive" | "error" | "testing"

export interface ConnectionState {
  id: string
  name: string
  exchange: string
  status: ConnectionStatus
  enabled: boolean
  testPassed: boolean
  lastTestTime?: Date
  lastError?: string
  credentialsConfigured: boolean
}

/**
 * ConnectionManager - Singleton pattern for managing exchange connections using Redis
 * Provides state validation, error handling, and coordinated updates
 */
export class ConnectionManager {
  private static instance: ConnectionManager
  private connections: Map<string, ConnectionState> = new Map()
  private listeners: Set<(connections: ConnectionState[]) => void> = new Set()
  private initialized = false

  private constructor() {}

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager()
    }
    return ConnectionManager.instance
  }

  /**
   * Initialize and load connections from Redis
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      await initRedis()
      const connections = await getAllConnections()

      this.connections.clear()

      for (const conn of connections) {
        this.connections.set(conn.id, {
          id: conn.id,
          name: conn.name,
          exchange: conn.exchange,
          status: (conn.is_enabled === "1" || conn.is_enabled === true) ? "active" : "inactive",
          enabled: conn.is_enabled === "1" || conn.is_enabled === true,
          testPassed: conn.last_test_status === "success",
          lastTestTime: conn.last_test_at ? new Date(conn.last_test_at) : undefined,
          lastError: undefined,
          credentialsConfigured: !!(conn.api_key && conn.api_secret),
        })
      }

      this.initialized = true
      this.notifyListeners()
    } catch (error) {
      console.error("[v0] Failed to initialize ConnectionManager:", error)
      await SystemLogger.logError(error, "connection-manager", "initialize")
    }
  }

  /**
   * Get all connections as ConnectionState array
   */
  getConnections(): ConnectionState[] {
    return Array.from(this.connections.values())
  }

  /**
   * Get a specific connection
   */
  getConnection(id: string): ConnectionState | undefined {
    return this.connections.get(id)
  }

  /**
   * Update a connection state in both memory and Redis
   */
  async updateConnection(id: string, updates: Partial<ConnectionState>): Promise<void> {
    try {
      await initRedis()
      const connection = await getConnection(id)

      if (!connection) {
        throw new Error(`Connection not found: ${id}`)
      }

      // Update Redis - only change is_enabled if explicitly provided
      const updatedConnection: any = {
        ...connection,
        ...(updates.enabled !== undefined ? { is_enabled: updates.enabled ? "1" : "0" } : {}),
        updated_at: new Date().toISOString(),
      }

      await updateConnection(id, updatedConnection)

      // Update memory
      const state = this.connections.get(id)
      if (state) {
        Object.assign(state, updates)
        this.notifyListeners()
      }

      console.log("[v0] Connection updated:", id)
    } catch (error) {
      console.error("[v0] Failed to update connection:", error)
      await SystemLogger.logError(error, "connection-manager", `updateConnection(${id})`)
    }
  }

  /**
   * Subscribe to connection changes
   */
  subscribe(listener: (connections: ConnectionState[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Notify all listeners of state changes
   */
  private notifyListeners(): void {
    const connections = this.getConnections()
    for (const listener of this.listeners) {
      listener(connections)
    }
  }
}

export const getConnectionManager = () => ConnectionManager.getInstance()
