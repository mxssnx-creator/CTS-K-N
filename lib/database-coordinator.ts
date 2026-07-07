import { getRedisClient, initRedis } from "@/lib/redis-db"

/**
 * Database Coordination Layer
 * Handles schema validation, data consistency, and coordinated operations
 * across Redis for position tracking, trades, and system state
 */

// Schema validators - validate data before storage
export const SchemaValidators = {
  position: (data: any) => {
    const required = ["id", "connectionId", "symbol", "size", "entryPrice", "currentPrice", "side", "status"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (!["long", "short", "both"].includes(data.side)) throw new Error(`Invalid side: ${data.side}`)
    if (!["open", "closing", "closed"].includes(data.status)) throw new Error(`Invalid status: ${data.status}`)
    if (typeof data.size !== "number" || data.size <= 0) throw new Error(`Invalid size: ${data.size}`)
    if (typeof data.leverage !== "number" || data.leverage < 1) throw new Error(`Invalid leverage: ${data.leverage}`)
    return true
  },

  order: (data: any) => {
    const required = ["id", "connectionId", "symbol", "side", "quantity", "status"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (!["buy", "sell"].includes(data.side)) throw new Error(`Invalid side: ${data.side}`)
    if (!["pending", "filled", "partially_filled", "cancelled"].includes(data.status))
      throw new Error(`Invalid status: ${data.status}`)
    if (typeof data.quantity !== "number" || data.quantity <= 0) throw new Error(`Invalid quantity: ${data.quantity}`)
    return true
  },

  trade: (data: any) => {
    // `entryPrice` is only present for opening trades; closing trades record
    // `exitPrice` instead. Require id/connectionId/symbol/side on every trade
    // and insist that at least one of entryPrice/exitPrice is present.
    const required = ["id", "connectionId", "symbol", "side"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (data.entryPrice === undefined && data.exitPrice === undefined) {
      throw new Error("Trade must have either entryPrice or exitPrice")
    }
    // Accept "close" as a pseudo-side used by the sell-signal flow when it
    // records the position-closing trade. It gets resolved back to long/short
    // downstream via the related position record.
    if (!["long", "short", "close"].includes(data.side)) {
      throw new Error(`Invalid side: ${data.side}`)
    }
    return true
  },
}

/**
 * Main Database Coordinator
 * Ensures consistency and validates all data operations
 */
export class DatabaseCoordinator {
  private static instance: DatabaseCoordinator
  private readonly log = (msg: string) => console.log(`[v0] [DB-Coordinator] ${msg}`)
  private readonly error = (msg: string) => console.error(`[v0] [DB-Coordinator] ERROR: ${msg}`)

  private constructor() {}

  static getInstance(): DatabaseCoordinator {
    if (!DatabaseCoordinator.instance) {
      DatabaseCoordinator.instance = new DatabaseCoordinator()
    }
    return DatabaseCoordinator.instance
  }

  /**
   * Store position with validation
   */
  async storePosition(connectionId: string, symbol: string, position: any): Promise<boolean> {
    try {
      this.log(`Storing position: ${connectionId}/${symbol}`)

      // Validate schema
      SchemaValidators.position(position)

      await initRedis()
      const client = getRedisClient()

      const key = `position:${connectionId}:${symbol}`
      const hashData: Record<string, string> = {}

      // Transform nested objects to JSON strings for storage
      for (const [k, v] of Object.entries(position)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      // TTL NOTE: the previous 1-hour TTL was dramatically shorter than any
      // real open-position lifetime and it diverged from the `positions:{id}`
      // index set (which had no TTL at all). That combination produced ghost
      // entries — the hash expired but the symbol stayed in the index, which
      // made `validateConsistency` always report orphans. Align both under a
      // 7-day window (same as trades) and refresh on every write so an actively
      // updated position never disappears mid-lifecycle.
      const POSITION_TTL_SECONDS = 7 * 24 * 60 * 60
      await (client as any).hset(key, hashData)
      await (client as any).expire(key, POSITION_TTL_SECONDS)

      // Track in positions set for quick lookup. Keep the set TTL in lock-step
      // with the hash TTL so cleanup falls through automatically on inactivity.
      const indexKey = `positions:${connectionId}`
      await (client as any).sadd(indexKey, symbol)
      await (client as any).expire(indexKey, POSITION_TTL_SECONDS)
      this.log(`✓ Position stored: ${key}`)

      return true
    } catch (error) {
      this.error(`Failed to store position ${connectionId}/${symbol}: ${error}`)
      return false
    }
  }

  /**
   * Fetch position with validation
   */
  async getPosition(connectionId: string, symbol: string): Promise<any | null> {
    try {
      await initRedis()
      const client = getRedisClient()

      const key = `position:${connectionId}:${symbol}`
      const data = await (client as any).hgetall(key)

      if (!data || Object.keys(data).length === 0) {
        return null
      }

      // Parse JSON strings back to objects
      const parsed: Record<string, any> = {}
      for (const [k, v] of Object.entries(data)) {
        try {
          parsed[k] = typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? JSON.parse(v as string) : v
        } catch {
          parsed[k] = v
        }
      }

      // Validate after retrieval
      SchemaValidators.position(parsed)
      return parsed
    } catch (error) {
      this.error(`Failed to get position ${connectionId}/${symbol}: ${error}`)
      return null
    }
  }

  /**
   * Fetch all positions for a connection
   */
  async getPositions(connectionId: string): Promise<Record<string, any>> {
    try {
      await initRedis()
      const client = getRedisClient()

      const symbols = await (client as any).smembers(`positions:${connectionId}`)
      const positions: Record<string, any> = {}

      for (const symbol of symbols) {
        const position = await this.getPosition(connectionId, symbol)
        if (position) {
          positions[symbol] = position
        }
      }

      this.log(`Fetched ${Object.keys(positions).length} positions for ${connectionId}`)
      return positions
    } catch (error) {
      this.error(`Failed to get all positions for ${connectionId}: ${error}`)
      return {}
    }
  }

  /**
   * Store order with validation
   */
  async storeOrder(connectionId: string, orderId: string, order: any): Promise<boolean> {
    try {
      this.log(`Storing order: ${connectionId}/${orderId}`)

      // Validate schema
      SchemaValidators.order(order)

      await initRedis()
      const client = getRedisClient()

      const key = `order:${connectionId}:${orderId}`
      const hashData: Record<string, string> = {}

      for (const [k, v] of Object.entries(order)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      await (client as any).hset(key, hashData)
      await (client as any).expire(key, 3600)

      // Track in orders set
      await (client as any).sadd(`orders:${connectionId}`, orderId)
      this.log(`✓ Order stored: ${key}`)

      return true
    } catch (error) {
      this.error(`Failed to store order ${connectionId}/${orderId}: ${error}`)
      return false
    }
  }

  /**
   * Get order with validation
   */
  async getOrder(connectionId: string, orderId: string): Promise<any | null> {
    try {
      await initRedis()
      const client = getRedisClient()

      const key = `order:${connectionId}:${orderId}`
      const data = await (client as any).hgetall(key)

      if (!data || Object.keys(data).length === 0) {
        return null
      }

      // Parse JSON strings back
      const parsed: Record<string, any> = {}
      for (const [k, v] of Object.entries(data)) {
        try {
          parsed[k] = typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? JSON.parse(v as string) : v
        } catch {
          parsed[k] = v
        }
      }

      SchemaValidators.order(parsed)
      return parsed
    } catch (error) {
      this.error(`Failed to get order ${connectionId}/${orderId}: ${error}`)
      return null
    }
  }

  /**
   * Record a completed trade
   */
  async recordTrade(connectionId: string, trade: any): Promise<boolean> {
    try {
      SchemaValidators.trade(trade)

      await initRedis()
      const client = getRedisClient()

      const tradeId = trade.id || `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const key = `trade:${connectionId}:${tradeId}`

      const hashData: Record<string, string> = {}
      for (const [k, v] of Object.entries(trade)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      await (client as any).hset(key, hashData)
      await (client as any).expire(key, 7 * 24 * 60 * 60) // 7 days

      // Track in trades set
      await (client as any).sadd(`trades:${connectionId}`, tradeId)

      this.log(`✓ Trade recorded: ${tradeId}`)
      return true
    } catch (error) {
      this.error(`Failed to record trade: ${error}`)
      return false
    }
  }

  /**
   * Get all trades for a connection.
   *
   * Fetches hashes in parallel and JSON-parses any nested fields that were
   * stringified at write time (via `storeTrade`/`recordTrade`). The previous
   * implementation awaited every `hgetall` sequentially and returned raw
   * string-hash data, so consumers that expected the original object shape
   * (e.g. nested `metadata`, `progression` arrays) received strings.
   */
  async getTrades(connectionId: string, limit: number = 100): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      const tradeIds: string[] =
        (await (client as any).smembers(`trades:${connectionId}`)) || []
      const slice = tradeIds.slice(0, limit)
      if (slice.length === 0) return []

      const hashes = await Promise.all(
        slice.map((tradeId) =>
          (client as any)
            .hgetall(`trade:${connectionId}:${tradeId}`)
            .catch(() => null as any),
        ),
      )

      const trades: any[] = []
      for (let i = 0; i < hashes.length; i++) {
        const data = hashes[i]
        if (!data || Object.keys(data).length === 0) {
          // Orphan index entry — drop it opportunistically so the set doesn't
          // grow unbounded with expired references.
          try {
            await (client as any).srem(`trades:${connectionId}`, slice[i])
          } catch { /* non-critical */ }
          continue
        }
        const parsed: Record<string, any> = {}
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
            try {
              parsed[k] = JSON.parse(v)
            } catch {
              parsed[k] = v
            }
          } else {
            parsed[k] = v
          }
        }
        trades.push(parsed)
      }

      return trades
    } catch (error) {
      this.error(`Failed to get trades for ${connectionId}: ${error}`)
      return []
    }
  }

  /**
   * Clean up closed positions.
   *
   * Hardened against missing/invalid `updated_at` fields (previously an
   * `undefined`/non-ISO value produced `Invalid Date`, making the cutoff
   * comparison always false so stale closed positions leaked forever) and
   * also removes the symbol from the `positions:{id}` set when the hash has
   * already expired (orphan entry).
   */
  async cleanupClosedPositions(connectionId: string, retentionHours: number = 24): Promise<number> {
    try {
      const cutoffMs = Date.now() - retentionHours * 60 * 60 * 1000
      let cleaned = 0

      await initRedis()
      const client = getRedisClient()

      // Work from the index set directly so we can also prune orphan
      // references (index entries whose hash has already expired).
      const symbols: string[] = (await (client as any).smembers(`positions:${connectionId}`)) || []

      for (const symbol of symbols) {
        const position = await this.getPosition(connectionId, symbol)
        if (!position) {
          // Orphan index entry — drop it so it stops polluting
          // `validateConsistency` reports.
          try {
            await (client as any).srem(`positions:${connectionId}`, symbol)
            cleaned++
          } catch { /* non-critical */ }
          continue
        }
        if (position.status !== "closed") continue

        // Robust updated_at parsing: accept ISO strings, numeric timestamps,
        // and fall back to created_at when updated_at is missing/invalid.
        const rawUpdated = position.updated_at ?? position.updatedAt ?? position.created_at
        const updatedMs = (() => {
          if (rawUpdated == null) return 0
          if (typeof rawUpdated === "number") return rawUpdated
          const parsed = Date.parse(String(rawUpdated))
          return Number.isFinite(parsed) ? parsed : 0
        })()

        if (updatedMs > 0 && updatedMs < cutoffMs) {
          const key = `position:${connectionId}:${symbol}`
          await (client as any).del(key)
          await (client as any).srem(`positions:${connectionId}`, symbol)
          cleaned++
        }
      }

      if (cleaned > 0) {
        this.log(`Cleaned up ${cleaned} closed/orphan positions`)
      }

      return cleaned
    } catch (error) {
      this.error(`Failed to cleanup positions: ${error}`)
      return 0
    }
  }

  /**
   * Validate data consistency across keys
   */
  async validateConsistency(connectionId: string): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const errors: string[] = []

      await initRedis()
      const client = getRedisClient()

      // Check positions
      const symbols = await (client as any).smembers(`positions:${connectionId}`)
      for (const symbol of symbols) {
        const position = await this.getPosition(connectionId, symbol)
        if (!position) {
          errors.push(`Position set references non-existent position: ${symbol}`)
        }
      }

      // Check orders
      const orderIds = await (client as any).smembers(`orders:${connectionId}`)
      for (const orderId of orderIds) {
        const order = await this.getOrder(connectionId, orderId)
        if (!order) {
          errors.push(`Order set references non-existent order: ${orderId}`)
        }
      }

      const valid = errors.length === 0
      if (!valid) {
        this.log(`Consistency check failed for ${connectionId}: ${errors.length} errors`)
        errors.forEach((e) => this.log(`  - ${e}`))
      }

      return { valid, errors }
    } catch (error) {
      this.error(`Consistency check failed: ${error}`)
      return { valid: false, errors: [String(error)] }
    }
  }
}

// Export singleton instance
export const dbCoordinator = DatabaseCoordinator.getInstance()
