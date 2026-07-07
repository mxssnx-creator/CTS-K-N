/**
 * Redis Service Layer - High-level business logic using Redis operations
 * Only calls methods that actually exist on the Redis operation modules
 */

import {
  RedisConnections,
  RedisTrades,
  RedisPositions,
  RedisMonitoring,
  RedisCache,
  RedisSettings,
  RedisBackup,
} from "./redis-operations"

export class RedisService {
  // Connection Management
  static async registerConnection(connection: {
    id: string
    exchange: string
    name: string
    api_key?: string
    api_secret?: string
    api_passphrase?: string
    is_enabled?: boolean
    is_active?: boolean
  }) {
    await RedisConnections.createConnection({
      ...connection,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    await RedisMonitoring.recordEvent("connection_created", {
      connectionId: connection.id,
      exchange: connection.exchange,
    })
  }

  static async getConnectionDetails(connId: string) {
    return await RedisConnections.getConnection(connId)
  }

  static async listAllConnections() {
    return await RedisConnections.getAllConnections()
  }

  static async updateConnectionSettings(connId: string, updates: any) {
    await RedisConnections.updateConnection(connId, updates)
  }

  static async removeConnection(connId: string) {
    await RedisConnections.deleteConnection(connId)
    await RedisMonitoring.recordEvent("connection_removed", { connectionId: connId })
  }

  // Trade Management
  static async executeTrade(
    connId: string,
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price: number
  ) {
    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await RedisTrades.createTrade(connId, {
      id: tradeId,
      connectionId: connId,
      symbol,
      side,
      quantity: String(quantity),
      price: String(price),
      total_value: String(quantity * price),
      status: "executed",
      timestamp: new Date().toISOString(),
    })
    await RedisMonitoring.recordEvent("trade_executed", {
      tradeId,
      connectionId: connId,
      symbol,
      side,
      quantity: String(quantity),
      price: String(price),
    })
    return tradeId
  }

  static async getTradeHistory(connId: string) {
    return await RedisTrades.getTradesByConnection(connId)
  }

  // Position Management
  static async openPosition(
    connId: string,
    symbol: string,
    side: "long" | "short",
    quantity: number,
    entryPrice: number
  ) {
    const posId = `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await RedisPositions.createPosition(connId, {
      id: posId,
      connectionId: connId,
      symbol,
      side,
      quantity: String(quantity),
      entry_price: String(entryPrice),
      status: "open",
      opened_at: new Date().toISOString(),
    })
    await RedisMonitoring.recordEvent("position_opened", {
      positionId: posId,
      connectionId: connId,
      symbol,
      side,
      quantity: String(quantity),
    })
    return posId
  }

  static async closePosition(posId: string, exitPrice: number) {
    const position = await RedisPositions.getPosition(posId)
    if (!position) throw new Error(`Position ${posId} not found`)

    const entryPrice = parseFloat(String(position.entry_price || 0))
    const quantity = parseFloat(String(position.quantity || 0))
    const pnl = (exitPrice - entryPrice) * quantity
    const pnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0

    await RedisPositions.updatePosition(posId, {
      status: "closed",
      exit_price: String(exitPrice),
      closed_at: new Date().toISOString(),
      realized_pnl: String(pnl.toFixed(2)),
      pnl_percent: String(pnlPercent.toFixed(2)),
    })
    await RedisMonitoring.recordEvent("position_closed", {
      positionId: posId,
      pnl: String(pnl.toFixed(2)),
    })
  }

  // System Monitoring
  static async getSystemHealth() {
    const stats = await RedisMonitoring.getStatistics()
    return {
      timestamp: Date.now(),
      connections: stats.connections,
      positions: stats.positions,
      trades: stats.trades,
    }
  }

  static async getSystemStatistics() {
    const stats = await RedisMonitoring.getStatistics()
    const backups = await RedisBackup.listSnapshots()
    return {
      ...stats,
      backups: backups.length,
      timestamp: Date.now(),
    }
  }

  // Data Management
  static async createBackup(name: string) {
    await RedisBackup.createSnapshot(name)
  }

  // Cache Management
  static async cacheData(key: string, value: any, ttlSeconds: number = 300) {
    await RedisCache.set(key, value, ttlSeconds)
  }

  static async getCachedData(key: string) {
    return await RedisCache.get(key)
  }

  // Settings Management
  static async setSetting(key: string, value: any) {
    await RedisSettings.set(key, value)
  }

  static async getSetting(key: string) {
    return await RedisSettings.get(key)
  }

  static async getAllSettings() {
    return await RedisSettings.getAll()
  }
}
