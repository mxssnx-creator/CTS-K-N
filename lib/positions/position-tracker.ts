import { getRedisClient } from "@/lib/redis-db"
// shim: existing code uses redisDb.set/get/del/keys; map to InlineLocalRedis.
const redisDb = {
  get:  (key: string)            => getRedisClient().get(key),
  set:  (key: string, val: string, opts?: { ex?: number }) =>
    opts?.ex ? getRedisClient().setex(key, opts.ex, val) : getRedisClient().set(key, val),
  del:  (key: string)            => getRedisClient().del(key),
  keys: (pattern: string)        => getRedisClient().keys(pattern),
}

/**
 * PHASE 3: Live Position Tracking System
 * 
 * Tracks all open positions from exchange APIs in real-time
 * Persists position data in Redis with TTL for distributed access
 * Validates progression limits before allowing new entries
 */

export interface LivePosition {
  id: string
  connection_id: string
  symbol: string
  side: "long" | "short"
  entry_price: number
  current_price: number
  quantity: number
  leverage: number
  margin_type: "cross" | "isolated"
  unrealized_pnl: number
  unrealized_pnl_percent: number
  liquidation_price?: number
  timestamp: number
  last_update: number
}

export interface OrderRecord {
  id: string
  connection_id: string
  symbol: string
  side: "buy" | "sell"
  quantity: number
  price: number
  order_type: "limit" | "market"
  status: "pending" | "filled" | "partially_filled" | "cancelled"
  filled_quantity: number
  filled_price: number
  timestamp: number
  closed_at?: number
}

export class PositionTracker {
  private readonly POSITIONS_PREFIX = "positions:"
  private readonly ORDERS_PREFIX = "orders:"
  private readonly PROGRESSION_PREFIX = "progression:"
  private readonly TTL = 3600 // 1 hour

  /**
   * Store or update a live position from exchange API
   */
  async recordPosition(position: LivePosition): Promise<void> {
    try {
      const key = `${this.POSITIONS_PREFIX}${position.connection_id}:${position.symbol}`
      const data = JSON.stringify(position)
      
      await redisDb.set(key, data, { ex: this.TTL })
      console.log(`[v0] [PositionTracker] Position recorded: ${key}`)
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to record position:`, error)
      throw error
    }
  }

  /**
   * Get all open positions for a connection
   */
  async getPositions(connectionId: string): Promise<LivePosition[]> {
    try {
      const pattern = `${this.POSITIONS_PREFIX}${connectionId}:*`
      const keys = await redisDb.keys(pattern)
      
      const positions: LivePosition[] = []
      for (const key of keys) {
        const data = await redisDb.get(key)
        if (data) {
          positions.push(JSON.parse(data))
        }
      }
      
      console.log(`[v0] [PositionTracker] Retrieved ${positions.length} positions for connection ${connectionId}`)
      return positions
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to get positions:`, error)
      return []
    }
  }

  /**
   * Get specific position
   */
  async getPosition(connectionId: string, symbol: string): Promise<LivePosition | null> {
    try {
      const key = `${this.POSITIONS_PREFIX}${connectionId}:${symbol}`
      const data = await redisDb.get(key)
      
      if (!data) {
        return null
      }
      
      return JSON.parse(data)
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to get position:`, error)
      return null
    }
  }

  /**
   * Remove closed position
   */
  async removePosition(connectionId: string, symbol: string): Promise<void> {
    try {
      const key = `${this.POSITIONS_PREFIX}${connectionId}:${symbol}`
      await redisDb.del(key)
      console.log(`[v0] [PositionTracker] Position removed: ${key}`)
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to remove position:`, error)
    }
  }

  /**
   * Record an order
   */
  async recordOrder(order: OrderRecord): Promise<void> {
    try {
      const key = `${this.ORDERS_PREFIX}${order.connection_id}:${order.id}`
      const data = JSON.stringify(order)
      
      await redisDb.set(key, data, { ex: this.TTL })
      console.log(`[v0] [PositionTracker] Order recorded: ${key}`)
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to record order:`, error)
      throw error
    }
  }

  /**
   * Get open orders for a connection
   */
  async getOpenOrders(connectionId: string): Promise<OrderRecord[]> {
    try {
      const pattern = `${this.ORDERS_PREFIX}${connectionId}:*`
      const keys = await redisDb.keys(pattern)
      
      const orders: OrderRecord[] = []
      for (const key of keys) {
        const data = await redisDb.get(key)
        if (data) {
          const order = JSON.parse(data)
          if (order.status === "pending" || order.status === "partially_filled") {
            orders.push(order)
          }
        }
      }
      
      console.log(`[v0] [PositionTracker] Retrieved ${orders.length} open orders for connection ${connectionId}`)
      return orders
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to get open orders:`, error)
      return []
    }
  }

  /**
   * Update order status
   */
  async updateOrderStatus(
    connectionId: string,
    orderId: string,
    status: "filled" | "partially_filled" | "cancelled",
    filledQuantity?: number,
    filledPrice?: number
  ): Promise<void> {
    try {
      const key = `${this.ORDERS_PREFIX}${connectionId}:${orderId}`
      const data = await redisDb.get(key)
      
      if (!data) {
        console.warn(`[v0] [PositionTracker] Order not found: ${key}`)
        return
      }
      
      const order: OrderRecord = JSON.parse(data)
      order.status = status
      if (filledQuantity !== undefined) order.filled_quantity = filledQuantity
      if (filledPrice !== undefined) order.filled_price = filledPrice
      if (status === "filled" || status === "cancelled") {
        order.closed_at = Date.now()
      }
      
      await redisDb.set(key, JSON.stringify(order), { ex: this.TTL })
      console.log(`[v0] [PositionTracker] Order updated: ${key} -> ${status}`)
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to update order:`, error)
    }
  }

  /**
   * Calculate total exposure for risk checks
   */
  async calculateExposure(connectionId: string): Promise<{
    totalNotional: number
    longNotional: number
    shortNotional: number
    avgLeverage: number
    riskExposure: number
  }> {
    try {
      const positions = await this.getPositions(connectionId)
      
      let totalNotional = 0
      let longNotional = 0
      let shortNotional = 0
      let totalLeverage = 0
      
      for (const pos of positions) {
        const notional = pos.quantity * pos.current_price
        totalNotional += notional
        totalLeverage += pos.leverage
        
        if (pos.side === "long") {
          longNotional += notional
        } else {
          shortNotional += notional
        }
      }
      
      const avgLeverage = positions.length > 0 ? totalLeverage / positions.length : 1
      const riskExposure = totalNotional * avgLeverage / 100 // As percentage of capital
      
      console.log(`[v0] [PositionTracker] Exposure: total=${totalNotional}, long=${longNotional}, short=${shortNotional}, risk=${riskExposure}%`)
      
      return { totalNotional, longNotional, shortNotional, avgLeverage, riskExposure }
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to calculate exposure:`, error)
      return { totalNotional: 0, longNotional: 0, shortNotional: 0, avgLeverage: 1, riskExposure: 0 }
    }
  }

  /**
   * Validate progression limits before opening new position
   */
  async validateProgressionLimits(
    connectionId: string,
    symbol: string,
    side: "long" | "short",
    limits: {
      maxLevels: number
      maxSize: number
      maxLeverage: number
      priceStep: number
    }
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const positions = await this.getPositions(connectionId)
      const sidePositions = positions.filter((p) => p.symbol === symbol && p.side === side)
      
      // Check max levels
      if (sidePositions.length >= limits.maxLevels) {
        return { valid: false, reason: `Max levels (${limits.maxLevels}) reached for ${side}` }
      }
      
      // Check total size
      const totalSize = sidePositions.reduce((sum, p) => sum + p.quantity, 0)
      if (totalSize >= limits.maxSize) {
        return { valid: false, reason: `Max size (${limits.maxSize}) reached for ${side}` }
      }
      
      // Check leverage
      if (limits.maxLeverage && sidePositions.some((p) => p.leverage > limits.maxLeverage)) {
        return { valid: false, reason: `Leverage exceeds limit (${limits.maxLeverage}x)` }
      }
      
      // Check price step between entries (if there are existing positions)
      if (sidePositions.length > 0 && limits.priceStep > 0) {
        const lastPosition = sidePositions[sidePositions.length - 1]
        const priceDiff = Math.abs(lastPosition.entry_price - lastPosition.current_price)
        
        if (priceDiff < limits.priceStep) {
          return { valid: false, reason: `Price movement (${priceDiff}) below step (${limits.priceStep})` }
        }
      }
      
      return { valid: true }
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to validate progression limits:`, error)
      return { valid: false, reason: "Validation error" }
    }
  }

  /**
   * Clear all positions for a connection (emergency close)
   */
  async clearPositions(connectionId: string): Promise<number> {
    try {
      const positions = await this.getPositions(connectionId)
      
      for (const pos of positions) {
        await this.removePosition(connectionId, pos.symbol)
      }
      
      console.log(`[v0] [PositionTracker] Cleared ${positions.length} positions for connection ${connectionId}`)
      return positions.length
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to clear positions:`, error)
      return 0
    }
  }

  /**
   * Get portfolio statistics
   */
  async getPortfolioStats(connectionId: string): Promise<{
    totalPnl: number
    totalPnlPercent: number
    winningPositions: number
    losingPositions: number
    averagePnl: number
    maxDrawdown: number
  }> {
    try {
      const positions = await this.getPositions(connectionId)
      
      const stats = {
        totalPnl: 0,
        totalPnlPercent: 0,
        winningPositions: 0,
        losingPositions: 0,
        averagePnl: 0,
        maxDrawdown: 0,
      }
      
      if (positions.length === 0) return stats
      
      for (const pos of positions) {
        stats.totalPnl += pos.unrealized_pnl
        stats.totalPnlPercent += pos.unrealized_pnl_percent
        
        if (pos.unrealized_pnl > 0) {
          stats.winningPositions++
        } else if (pos.unrealized_pnl < 0) {
          stats.losingPositions++
          stats.maxDrawdown = Math.min(stats.maxDrawdown, pos.unrealized_pnl_percent)
        }
      }
      
      stats.averagePnl = stats.totalPnl / positions.length
      
      console.log(`[v0] [PositionTracker] Portfolio stats: pnl=${stats.totalPnl}, winners=${stats.winningPositions}, losers=${stats.losingPositions}`)
      
      return stats
    } catch (error) {
      console.error(`[v0] [PositionTracker] Failed to get portfolio stats:`, error)
      return { totalPnl: 0, totalPnlPercent: 0, winningPositions: 0, losingPositions: 0, averagePnl: 0, maxDrawdown: 0 }
    }
  }
}

// Export singleton instance
export const positionTracker = new PositionTracker()
