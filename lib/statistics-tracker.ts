import { query } from "@/lib/db"
import { getRedisClient, initRedis } from "@/lib/redis-db"

/**
 * Track indication statistics - called after each indication processing cycle
 * Records indication type, value, and confidence to database for statistics
 * ALSO updates Redis counters for dashboard display
 */
export async function trackIndicationStats(
  connectionId: string,
  symbol: string,
  indicationType: string,
  value: number,
  confidence: number
): Promise<void> {
  try {
    await query(
      `INSERT INTO indications (connection_id, symbol, type, value, confidence, calculated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [connectionId, symbol, indicationType, value, confidence]
    )
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to track indication in DB:`, e instanceof Error ? e.message : String(e))
  }

  // Track in Redis using counters (not unbounded sets) for dashboard counts.
  // Fan out all writes concurrently so we don't pay 9 sequential Redis
  // round-trips for every indication result.
  //
  // NOTE: Do NOT increment progression hash counters here.
  // Processors (engine-manager, config-set-processor) already write aggregate
  // counts to progression:{connectionId}:indications_count on their cycle completion.
  // Tracking per-indication here would double-count (statement-level vs. aggregate-level).
  //
  // DEV-MODE BYPASS — must be before any client calls (Promise construction fires
  // the write synchronously in InlineLocalRedis). 20 symbols × 4 types × 3 keys
  // = 240 keys/cycle; skip entirely in dev (reads are non-critical for engine).
  if (process.env.NODE_ENV === "development") return
  try {
    await initRedis()
    const client = getRedisClient()

    const typeCountKey = `indications:${connectionId}:${indicationType}:count`
    const totalCountKey = `indications:${connectionId}:count`
    const latestKey = `indications:${connectionId}:${indicationType}:latest`

    await Promise.all([
      client.incr(typeCountKey),
      client.expire(typeCountKey, 86400),
      client.incr(totalCountKey),
      client.expire(totalCountKey, 86400),
      client.set(latestKey, JSON.stringify({ symbol, value, confidence, timestamp: Date.now() })),
      client.expire(latestKey, 3600),
    ])
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track indication in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Track strategy statistics - called after strategy evaluation
 * Records strategy type, counts, and metrics to database for statistics
 */
export async function trackStrategyStats(
  connectionId: string,
  symbol: string,
  strategyType: string,
  totalCreated: number,
  passedCount: number,
  profitFactor: number,
  drawdownTimeMinutes: number
): Promise<void> {
  try {
    await query(
      `INSERT INTO strategies_real (connection_id, symbol, type, count, passed_count, avg_profit_factor, avg_drawdown_time, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [connectionId, symbol, strategyType, totalCreated, passedCount, profitFactor, Math.round(drawdownTimeMinutes)]
    )
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to track strategy:`, e instanceof Error ? e.message : String(e))
  }

  // DEV-MODE BYPASS: These per-strategy-type Redis writes (count, eval, passed,
  // latest) are written per symbol × per strategy type × per cycle. At 20 symbols
  // × 10 types × 5 keys each = 1000 new keys/cycle in the InlineLocalRedis Map.
  // This is the primary source of the 58-key/20.1MB strategies:bingx-x01 family.
  // IMPORTANT: the bypass must be BEFORE any client.incrby/set calls — Promise
  // construction fires the write immediately in InlineLocalRedis (no lazy eval).
  if (process.env.NODE_ENV === "development") return
  try {
    await initRedis()
    const client = getRedisClient()

    const typeCountKey = `strategies:${connectionId}:${strategyType}:count`
    const totalCountKey = `strategies:${connectionId}:count`
    const evalKey = `strategies:${connectionId}:${strategyType}:evaluated`
    const passedKey = `strategies:${connectionId}:${strategyType}:passed`
    const latestKey = `strategies:${connectionId}:${strategyType}:latest`

    const writes: Promise<any>[] = [
      client.incrby(typeCountKey, 1),
      client.expire(typeCountKey, 86400),
      client.incrby(totalCountKey, 1),
      client.expire(totalCountKey, 86400),
      client.set(
        latestKey,
        JSON.stringify({ symbol, totalCreated, passedCount, profitFactor, drawdownTimeMinutes, timestamp: Date.now() }),
      ),
      client.expire(latestKey, 3600),
    ]
    if (totalCreated > 0) {
      writes.push(client.incrby(evalKey, totalCreated), client.expire(evalKey, 86400))
    }
    if (passedCount > 0) {
      writes.push(client.incrby(passedKey, passedCount), client.expire(passedKey, 86400))
    }
    await Promise.all(writes)
    // NOTE: Per-stage progression hash fields (strategies_base_total, strategies_main_total,
    // strategies_real_total, strategy_evaluated_*) are written exclusively by StrategyCoordinator
    // to avoid double-counting. trackStrategyStats only writes to the flat counter keys above
    // and to the SQL strategies_real table for historical analytics.
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track strategy in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Get recent indication statistics for dashboard
 */
export async function getIndicationStats(connectionId: string, hoursBack: number = 24): Promise<any> {
  try {
    const stats = await query(
      `SELECT type, COUNT(*) as count, AVG(value) as avg_value, AVG(confidence) as avg_confidence
       FROM indications
       WHERE connection_id = ? AND calculated_at > datetime('now', ?)
       GROUP BY type`,
      [connectionId, `-${hoursBack} hours`]
    )
    return stats || []
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to get indication stats:`, e instanceof Error ? e.message : String(e))
    return []
  }
}

/**
 * Get recent strategy statistics for dashboard
 */
export async function getStrategyStats(connectionId: string, hoursBack: number = 24): Promise<any> {
  try {
    const stats = await query(
      `SELECT type, COUNT(*) as count, SUM(passed_count) as total_passed, 
              AVG(avg_profit_factor) as avg_profit_factor, AVG(avg_drawdown_time) as avg_drawdown_time
       FROM strategies_real
       WHERE connection_id = ? AND evaluated_at > datetime('now', ?)
       GROUP BY type`,
      [connectionId, `-${hoursBack} hours`]
    )
    return stats || []
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to get strategy stats:`, e instanceof Error ? e.message : String(e))
    return []
  }
}

/**
 * Track trailing stop metrics - called when trailing stops are created/ratcheted/closed
 * Records operation type, symbol, ratchet distance, and price movement
 */
export async function trackTrailingStopMetrics(
  connectionId: string,
  symbol: string,
  operation: "created" | "ratcheted" | "closed",
  ratchetDistance?: number,
  priceMovement?: number,
  stopPrice?: number
): Promise<void> {
  // DEV-MODE BYPASS — trailing metrics are non-critical for engine operation
  if (process.env.NODE_ENV === "development") return
  
  try {
    await initRedis()
    const client = getRedisClient()

    const operationCountKey = `trailing:${connectionId}:${operation}:count`
    const totalCountKey = `trailing:${connectionId}:count`
    const latestKey = `trailing:${connectionId}:${symbol}:latest`

    const writes: Promise<any>[] = [
      client.incr(operationCountKey),
      client.expire(operationCountKey, 86400),
      client.incr(totalCountKey),
      client.expire(totalCountKey, 86400),
      client.set(
        latestKey,
        JSON.stringify({ 
          symbol, 
          operation, 
          ratchetDistance, 
          priceMovement, 
          stopPrice,
          timestamp: Date.now() 
        })
      ),
      client.expire(latestKey, 3600),
    ]
    
    // Track per-symbol ratchet distance average (store as string for compatibility)
    if (operation === "ratcheted" && ratchetDistance !== undefined) {
      const ratchetKey = `trailing:${connectionId}:${symbol}:ratchet_distance_sum`
      const ratchetCountKey = `trailing:${connectionId}:${symbol}:ratchet_count`
      const currentSum = await client.get(ratchetKey).catch(() => "0")
      const newSum = (parseFloat(String(currentSum || "0")) || 0) + ratchetDistance
      writes.push(
        client.set(ratchetKey, String(newSum)),
        client.expire(ratchetKey, 86400),
        client.incr(ratchetCountKey),
        client.expire(ratchetCountKey, 86400)
      )
    }
    
    await Promise.all(writes)
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track trailing stop metrics in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Track block strategy metrics - called when blocks are created/filled/stacked
 * Records block type, stack depth, size multiplier, and position count
 */
export async function trackBlockStrategyMetrics(
  connectionId: string,
  symbol: string,
  operation: "created" | "filled" | "stacked" | "closed",
  blockStackDepth?: number,
  sizeMultiplier?: number,
  isIndependent?: boolean,
  positionCount?: number
): Promise<void> {
  // DEV-MODE BYPASS — block metrics are non-critical for engine operation
  if (process.env.NODE_ENV === "development") return
  
  try {
    await initRedis()
    const client = getRedisClient()

    const operationCountKey = `block:${connectionId}:${operation}:count`
    const totalCountKey = `block:${connectionId}:count`
    const independentKey = isIndependent 
      ? `block:${connectionId}:independent:count` 
      : `block:${connectionId}:addon:count`
    const latestKey = `block:${connectionId}:${symbol}:latest`

    const writes: Promise<any>[] = [
      client.incr(operationCountKey),
      client.expire(operationCountKey, 86400),
      client.incr(totalCountKey),
      client.expire(totalCountKey, 86400),
      client.incr(independentKey),
      client.expire(independentKey, 86400),
      client.set(
        latestKey,
        JSON.stringify({ 
          symbol, 
          operation, 
          blockStackDepth,
          sizeMultiplier,
          isIndependent,
          positionCount,
          timestamp: Date.now() 
        })
      ),
      client.expire(latestKey, 3600),
    ]
    
    // Track per-symbol stack depth max
    if (operation === "stacked" && blockStackDepth !== undefined) {
      const stackKey = `block:${connectionId}:${symbol}:max_stack_depth`
      const current = parseInt(String(await client.get(stackKey).catch(() => "0")) || "0")
      if (blockStackDepth > current) {
        writes.push(
          client.set(stackKey, String(blockStackDepth)),
          client.expire(stackKey, 86400)
        )
      }
    }
    
    // Track size multiplier average (store as string for compatibility)
    if (sizeMultiplier !== undefined) {
      const sizeKey = `block:${connectionId}:${symbol}:size_multiplier_sum`
      const sizeCountKey = `block:${connectionId}:${symbol}:size_count`
      const currentSum = await client.get(sizeKey).catch(() => "0")
      const newSum = (parseFloat(String(currentSum || "0")) || 0) + sizeMultiplier
      writes.push(
        client.set(sizeKey, String(newSum)),
        client.expire(sizeKey, 86400),
        client.incr(sizeCountKey),
        client.expire(sizeCountKey, 86400)
      )
    }
    
    await Promise.all(writes)
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track block strategy metrics in Redis:`, e instanceof Error ? e.message : String(e))
  }
}
