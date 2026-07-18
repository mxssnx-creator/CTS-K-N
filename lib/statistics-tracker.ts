import { getRedisClient, initRedis } from "@/lib/redis-db"

const HOUR_MS = 60 * 60 * 1000
const STATISTICS_ROLLUP_MAX_HOURS = 7 * 24
const STATISTICS_ROLLUP_RETENTION_SECONDS = 8 * 24 * 60 * 60

type RollupKind = "indications" | "strategies"

function safeMetric(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function metricType(value: string): string {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "unknown"
}

function rollupKey(kind: RollupKind, connectionId: string, timestamp = Date.now()): string {
  return `statistics:hourly:${kind}:${connectionId}:${Math.floor(timestamp / HOUR_MS)}`
}

function rollupKeys(kind: RollupKind, connectionId: string, hoursBack: number, timestamp = Date.now()): string[] {
  const count = Math.max(1, Math.min(STATISTICS_ROLLUP_MAX_HOURS, Math.ceil(safeMetric(hoursBack) || 24)))
  const current = Math.floor(timestamp / HOUR_MS)
  return Array.from({ length: count }, (_, offset) => `statistics:hourly:${kind}:${connectionId}:${current - offset}`)
}

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
    await initRedis()
    const client = getRedisClient()
    const type = metricType(indicationType)
    const hourlyKey = rollupKey("indications", connectionId)

    // One expiring hash per connection/hour replaces the former SQL-shim
    // INSERT-per-result path. At 15 symbols and hundreds of cycles the old
    // path created tens of thousands of permanent hashes in two minutes.
    // The hourly form stays bounded to 168 hashes per connection while still
    // preserving 24h/7d aggregate statistics.
    const writes: Promise<any>[] = [
      client.hincrby(hourlyKey, `${type}:count`, 1),
      client.hincrbyfloat(hourlyKey, `${type}:value_sum`, safeMetric(value)),
      client.hincrbyfloat(hourlyKey, `${type}:confidence_sum`, safeMetric(confidence)),
      client.hset(hourlyKey, `${type}:latest`, JSON.stringify({ symbol, value, confidence, timestamp: Date.now() })),
      client.expire(hourlyKey, STATISTICS_ROLLUP_RETENTION_SECONDS),
    ]

    // Track in Redis using counters (not unbounded sets) for dashboard counts.
    // Fan out all writes concurrently so we don't pay sequential round-trips
    // for every indication result.
  //
    // NOTE: Do NOT increment progression hash counters here. Processors already
    // own those aggregates; tracking each result would double-count them.
    // Development keeps only the bounded hourly rollup and skips legacy flat
    // counters so high-volume HMR tests remain lightweight.
    if (process.env.NODE_ENV === "development") {
      await Promise.all(writes)
      return
    }

    const typeCountKey = `indications:${connectionId}:${type}:count`
    const totalCountKey = `indications:${connectionId}:count`
    const latestKey = `indications:${connectionId}:${type}:latest`

    writes.push(
      client.incr(typeCountKey),
      client.expire(typeCountKey, 86400),
      client.incr(totalCountKey),
      client.expire(totalCountKey, 86400),
      client.set(latestKey, JSON.stringify({ symbol, value, confidence, timestamp: Date.now() })),
      client.expire(latestKey, 3600),
    )
    await Promise.all(writes)
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
    await initRedis()
    const client = getRedisClient()
    const type = metricType(strategyType)
    const hourlyKey = rollupKey("strategies", connectionId)
    const writes: Promise<any>[] = [
      client.hincrby(hourlyKey, `${type}:count`, 1),
      client.hincrbyfloat(hourlyKey, `${type}:created_sum`, safeMetric(totalCreated)),
      client.hincrbyfloat(hourlyKey, `${type}:passed_sum`, safeMetric(passedCount)),
      client.hincrbyfloat(hourlyKey, `${type}:pf_sum`, safeMetric(profitFactor)),
      client.hincrbyfloat(hourlyKey, `${type}:ddt_sum`, safeMetric(drawdownTimeMinutes)),
      client.hset(hourlyKey, `${type}:latest`, JSON.stringify({
        symbol,
        totalCreated,
        passedCount,
        profitFactor,
        drawdownTimeMinutes,
        timestamp: Date.now(),
      })),
      client.expire(hourlyKey, STATISTICS_ROLLUP_RETENTION_SECONDS),
    ]

    // Development keeps the bounded hourly rollup but skips the compatibility
    // flat counters. Production retains both because existing dashboards still
    // consume the flat 24h/latest fields.
    if (process.env.NODE_ENV === "development") {
      await Promise.all(writes)
      return
    }

    const typeCountKey = `strategies:${connectionId}:${type}:count`
    const totalCountKey = `strategies:${connectionId}:count`
    const evalKey = `strategies:${connectionId}:${type}:evaluated`
    const passedKey = `strategies:${connectionId}:${type}:passed`
    const latestKey = `strategies:${connectionId}:${type}:latest`

    writes.push(
      client.incrby(typeCountKey, 1),
      client.expire(typeCountKey, 86400),
      client.incrby(totalCountKey, 1),
      client.expire(totalCountKey, 86400),
      client.set(
        latestKey,
        JSON.stringify({ symbol, totalCreated, passedCount, profitFactor, drawdownTimeMinutes, timestamp: Date.now() }),
      ),
      client.expire(latestKey, 3600),
    )
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
    // while the hourly rollup above owns historical analytics.
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track strategy in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Get recent indication statistics for dashboard
 */
export async function getIndicationStats(connectionId: string, hoursBack: number = 24): Promise<any> {
  try {
    await initRedis()
    const client = getRedisClient()
    const rows = await Promise.all(rollupKeys("indications", connectionId, hoursBack).map((key) => client.hgetall(key).catch(() => ({}))))
    const totals = new Map<string, { count: number; value: number; confidence: number }>()
    for (const row of rows) {
      for (const [field, raw] of Object.entries(row || {})) {
        const match = field.match(/^(.+):(count|value_sum|confidence_sum)$/)
        if (!match) continue
        const current = totals.get(match[1]) || { count: 0, value: 0, confidence: 0 }
        if (match[2] === "count") current.count += safeMetric(raw)
        if (match[2] === "value_sum") current.value += safeMetric(raw)
        if (match[2] === "confidence_sum") current.confidence += safeMetric(raw)
        totals.set(match[1], current)
      }
    }
    return Array.from(totals.entries()).map(([type, total]) => ({
      type,
      count: total.count,
      avg_value: total.count > 0 ? total.value / total.count : 0,
      avg_confidence: total.count > 0 ? total.confidence / total.count : 0,
    }))
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
    await initRedis()
    const client = getRedisClient()
    const rows = await Promise.all(rollupKeys("strategies", connectionId, hoursBack).map((key) => client.hgetall(key).catch(() => ({}))))
    const totals = new Map<string, { count: number; created: number; passed: number; pf: number; ddt: number }>()
    for (const row of rows) {
      for (const [field, raw] of Object.entries(row || {})) {
        const match = field.match(/^(.+):(count|created_sum|passed_sum|pf_sum|ddt_sum)$/)
        if (!match) continue
        const current = totals.get(match[1]) || { count: 0, created: 0, passed: 0, pf: 0, ddt: 0 }
        if (match[2] === "count") current.count += safeMetric(raw)
        if (match[2] === "created_sum") current.created += safeMetric(raw)
        if (match[2] === "passed_sum") current.passed += safeMetric(raw)
        if (match[2] === "pf_sum") current.pf += safeMetric(raw)
        if (match[2] === "ddt_sum") current.ddt += safeMetric(raw)
        totals.set(match[1], current)
      }
    }
    return Array.from(totals.entries()).map(([type, total]) => ({
      type,
      count: total.count,
      total_created: total.created,
      total_passed: total.passed,
      avg_profit_factor: total.count > 0 ? total.pf / total.count : 0,
      avg_drawdown_time: total.count > 0 ? total.ddt / total.count : 0,
    }))
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
