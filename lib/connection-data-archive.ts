import { getRedisClient } from "@/lib/redis-db"

/**
 * Archive connection-related data (trades, positions, etc.) 
 * so it persists when connection is removed and re-added
 */

export const ConnectionDataArchive = {
  /**
   * Archive all data associated with a connection before removal
   */
  async archiveConnectionData(connectionId: string) {
    const client = getRedisClient()
    const archiveKey = `archive:connection:${connectionId}:${Date.now()}`
    
    // Get all data related to this connection
    const tradesKey = `trades:connection:${connectionId}:*`
    const positionsKey = `positions:connection:${connectionId}:*`
    const ordersKey = `orders:connection:${connectionId}:*`
    
    const trades = await client.keys(tradesKey)
    const positions = await client.keys(positionsKey)
    const orders = await client.keys(ordersKey)
    
    const archiveData: any = {
      connectionId,
      timestamp: Date.now(),
      trades: [],
      positions: [],
      orders: [],
      archivedAt: new Date().toISOString(),
    }
    
    // Archive trades
    for (const key of trades) {
      const tradeData = await client.hgetall(key)
      if (tradeData && Object.keys(tradeData).length > 0) {
        archiveData.trades.push(tradeData)
      }
    }
    
    // Archive positions
    for (const key of positions) {
      const posData = await client.hgetall(key)
      if (posData && Object.keys(posData).length > 0) {
        archiveData.positions.push(posData)
      }
    }
    
    // Archive orders
    for (const key of orders) {
      const orderData = await client.hgetall(key)
      if (orderData && Object.keys(orderData).length > 0) {
        archiveData.orders.push(orderData)
      }
    }
    
    // Store archive with 30-day expiry
    await client.set(archiveKey, JSON.stringify(archiveData), { EX: 30 * 24 * 60 * 60 })
    console.log(`[v0] Archived connection data for ${connectionId}:`, archiveData)
    
    return archiveKey
  },

  /**
   * Restore archived data when connection is re-added with same API key
   */
  async restoreConnectionData(connectionId: string, apiKey: string) {
    const client = getRedisClient()
    
    // Find the most recent archive for this connection
    const archivePattern = `archive:connection:${connectionId}:*`
    const archives = await client.keys(archivePattern)
    
    if (archives.length === 0) {
      console.log(`[v0] No archives found for connection ${connectionId}`)
      return null
    }
    
    // Get the latest archive
    const latestArchive = archives.sort().pop()!
    const archiveDataStr = await client.get(latestArchive)
    
    if (!archiveDataStr) {
      console.log(`[v0] Archive data not found for ${latestArchive}`)
      return null
    }
    
    const archiveData = JSON.parse(archiveDataStr)
    console.log(`[v0] Restoring archived data for connection ${connectionId}`, archiveData)
    
    // Restore trades
    for (const trade of archiveData.trades) {
      const tradeId = trade.id || `trade_${Date.now()}`
      const tradeKey = `trades:connection:${connectionId}:${tradeId}`
      await client.hset(tradeKey, trade)
    }
    
    // Restore positions
    for (const position of archiveData.positions) {
      const posId = position.id || `pos_${Date.now()}`
      const posKey = `positions:connection:${connectionId}:${posId}`
      await client.hset(posKey, position)
    }
    
    // Restore orders
    for (const order of archiveData.orders) {
      const orderId = order.id || `order_${Date.now()}`
      const orderKey = `orders:connection:${connectionId}:${orderId}`
      await client.hset(orderKey, order)
    }
    
    return archiveData
  },

  /**
   * Link old connection ID data to new connection ID
   * (in case API key-based ID generation changed)
   */
  async migrateConnectionData(oldConnectionId: string, newConnectionId: string) {
    const client = getRedisClient()
    
    // Migrate all trades
    const trades = await client.keys(`trades:connection:${oldConnectionId}:*`)
    for (const oldKey of trades) {
      const newKey = oldKey.replace(`connection:${oldConnectionId}`, `connection:${newConnectionId}`)
      const data = await client.hgetall(oldKey)
      if (data && Object.keys(data).length > 0) await client.hset(newKey, data)
    }
    
    // Migrate all positions
    const positions = await client.keys(`positions:connection:${oldConnectionId}:*`)
    for (const oldKey of positions) {
      const newKey = oldKey.replace(`connection:${oldConnectionId}`, `connection:${newConnectionId}`)
      const data = await client.hgetall(oldKey)
      if (data && Object.keys(data).length > 0) await client.hset(newKey, data)
    }
    
    // Migrate all orders
    const orders = await client.keys(`orders:connection:${oldConnectionId}:*`)
    for (const oldKey of orders) {
      const newKey = oldKey.replace(`connection:${oldConnectionId}`, `connection:${newConnectionId}`)
      const data = await client.hgetall(oldKey)
      if (data && Object.keys(data).length > 0) await client.hset(newKey, data)
    }
    
    console.log(`[v0] Migrated data from ${oldConnectionId} to ${newConnectionId}`)
  },

  /**
   * Clean up old archives
   */
  async cleanupOldArchives(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const client = getRedisClient()
    const archives = await client.keys("archive:connection:*")
    
    const now = Date.now()
    let cleaned = 0
    
    for (const archive of archives) {
      // Extract timestamp from key format: archive:connection:ID:TIMESTAMP
      const parts = archive.split(":")
      const timestamp = parseInt(parts[parts.length - 1], 10)
      
      if (now - timestamp > maxAgeMs) {
        await client.del(archive)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      console.log(`[v0] Cleaned up ${cleaned} old connection archives`)
    }
    
    return cleaned
  },
}
