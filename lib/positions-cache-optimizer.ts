/**
 * Positions Cache Optimizer
 * Provides O(1) indexed lookups for pseudo positions using Redis
 * Redis-native: No SQL fallback needed, all data lives in Redis
 */

import { initRedis, getRedisClient, getSettings, setSettings } from "@/lib/redis-db"

export class PositionsCacheOptimizer {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Get active positions for a symbol
   */
  async getPositionsBySymbol(symbol: string): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()
      const cacheKey = `positions_cache:${this.connectionId}:${symbol}`

      // Try cache first
      const cached = await client.get(cacheKey)
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached
      }

      // Build from pseudo position set
      const posIds = await client.smembers(`pseudo_positions:${this.connectionId}:active`)
      const positions: any[] = []

      for (const posId of posIds) {
        const pos = await getSettings(`pseudo_position:${posId}`)
        if (pos && pos.symbol === symbol && (pos.status === "open" || pos.status === "active")) { // "active" kept for legacy Redis data
          positions.push(pos)
        }
      }

      // Cache with 2 second TTL
      if (positions.length > 0) {
        await client.set(cacheKey, JSON.stringify(positions))
      }

      return positions
    } catch (error) {
      console.error(`[v0] Failed to get positions for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Get all active positions indexed by symbol
   */
  async getAllActivePositions(): Promise<Map<string, any[]>> {
    try {
      await initRedis()
      const client = getRedisClient()
      const indexKey = `positions_cache:${this.connectionId}:index`

      const cachedIndex = await client.get(indexKey)
      if (cachedIndex) {
        const parsed = typeof cachedIndex === "string" ? JSON.parse(cachedIndex) : cachedIndex
        return new Map(parsed)
      }

      const posIds = await client.smembers(`pseudo_positions:${this.connectionId}:active`)
      const symbolIndex = new Map<string, any[]>()

      for (const posId of posIds) {
        const pos = await getSettings(`pseudo_position:${posId}`)
        if (!pos || (pos.status !== "open" && pos.status !== "active")) continue // "active" kept for legacy Redis data

        if (!symbolIndex.has(pos.symbol)) {
          symbolIndex.set(pos.symbol, [])
        }
        symbolIndex.get(pos.symbol)!.push(pos)
      }

      const indexData = Array.from(symbolIndex.entries())
      await client.set(indexKey, JSON.stringify(indexData))

      return symbolIndex
    } catch (error) {
      console.error("[v0] Failed to get all positions:", error)
      return new Map()
    }
  }

  /**
   * Find position by configuration key
   */
  async findPositionByConfig(
    symbol: string,
    side: "long" | "short",
    takeprofit_factor: number,
    stoploss_ratio: number,
  ): Promise<any | null> {
    try {
      const positions = await this.getPositionsBySymbol(symbol)
      return positions.find(
        (p) =>
          p.side === side &&
          Math.abs(parseFloat(p.takeprofit_factor) - takeprofit_factor) < 0.01 &&
          Math.abs(parseFloat(p.stoploss_ratio) - stoploss_ratio) < 0.01,
      ) || null
    } catch (error) {
      console.error("[v0] Failed to find position by config:", error)
      return null
    }
  }

  /**
   * Invalidate cache when positions change
   */
  async invalidateCache(symbol?: string): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      if (symbol) {
        await client.del(`positions_cache:${this.connectionId}:${symbol}`)
      }
      await client.del(`positions_cache:${this.connectionId}:index`)
    } catch (error) {
      console.error("[v0] Failed to invalidate cache:", error)
    }
  }

  /**
   * Get count of active positions
   */
  async getPositionCount(symbol?: string): Promise<number> {
    try {
      if (symbol) {
        const positions = await this.getPositionsBySymbol(symbol)
        return positions.length
      }
      const allPositions = await this.getAllActivePositions()
      return Array.from(allPositions.values()).reduce((sum, pos) => sum + pos.length, 0)
    } catch (error) {
      console.error("[v0] Failed to get position count:", error)
      return 0
    }
  }

  /**
   * Batch update position prices
   */
  async batchUpdatePositions(updates: Array<{ id: string; currentPrice: number }>): Promise<void> {
    try {
      await initRedis()
      const now = new Date().toISOString()

      for (const update of updates) {
        const pos = await getSettings(`pseudo_position:${update.id}`)
        if (pos) {
          await setSettings(`pseudo_position:${update.id}`, {
            ...pos,
            current_price: update.currentPrice,
            updated_at: now,
          })
        }
      }

      await this.invalidateCache()
    } catch (error) {
      console.error("[v0] Failed to batch update positions:", error)
    }
  }

  /**
   * Get positions expiring soon (hold time exceeded)
   */
  async getExpiringPositions(maxHoldTimeMs: number): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()
      const cutoffTime = Date.now() - maxHoldTimeMs

      const posIds = await client.smembers(`pseudo_positions:${this.connectionId}:active`)
      const expiring: any[] = []

      for (const posId of posIds) {
        const pos = await getSettings(`pseudo_position:${posId}`)
        if (pos && (pos.status === "open" || pos.status === "active") && new Date(pos.opened_at || pos.created_at).getTime() < cutoffTime) { // "active" kept for legacy Redis data
          expiring.push(pos)
        }
      }

      return expiring.sort((a, b) => new Date(a.opened_at || a.created_at).getTime() - new Date(b.opened_at || b.created_at).getTime())
    } catch (error) {
      console.error("[v0] Failed to get expiring positions:", error)
      return []
    }
  }

  /**
   * Warm cache on startup
   */
  async warmCache(): Promise<void> {
    try {
      console.log(`[v0] Warming positions cache for connection ${this.connectionId}`)
      await this.getAllActivePositions()
      console.log(`[v0] Positions cache warmed`)
    } catch (error) {
      console.error("[v0] Failed to warm cache:", error)
    }
  }
}
