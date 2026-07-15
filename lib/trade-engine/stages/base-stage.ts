// Stage 2: Base Positions Generator
// Creates ALL possible pseudo positions from valid indication signals
// Generates 1 LONG + 1 SHORT position per indication (respecting max limits per direction)

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { ExchangeConnection } from "@/lib/types"
import type { IndicationSignal } from "./indication-stage"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"

const LOG_PREFIX = "[v0] [BasePositionStage]"

export interface BasePosition {
  id: string
  connectionId: string
  connectionName: string
  symbol: string
  timeframe: string
  direction: "long" | "short"
  entryPrice: number
  entryTime: number
  indicationSignal: "buy" | "sell" | "neutral"
  indicationStrength: number
  status: "open" | "closed"
  sourceIndicationTimestamp: number
  createdAt: number
  updatedAt: number
}

/**
 * Generate base positions from valid indication signals
 * Creates 1 LONG and 1 SHORT pseudo position per indication
 * Respects max position limits per direction (configurable, default 1)
 */
export async function generateBasePositions(
  connection: ExchangeConnection,
  indications: IndicationSignal[],
  config: { maxLongPositions?: number; maxShortPositions?: number } = {}
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()
  const maxLong = config.maxLongPositions || 1
  const maxShort = config.maxShortPositions || 1
  const basePositions: BasePosition[] = []

  console.log(
    `${LOG_PREFIX} Generating base positions for ${connection.name} (max long: ${maxLong}, max short: ${maxShort})`
  )

  try {
    const connectionId = connection.id || connection.name

    // Position limits are per symbol+direction. Parallelising every indication
    // independently made all same-symbol tasks observe the same old count and
    // over-create beyond the ceiling. Group by symbol, lease that admission
    // slot, and process independent symbols concurrently instead.
    const bySymbol = new Map<string, IndicationSignal[]>()
    for (const indication of indications) {
      const group = bySymbol.get(indication.symbol)
      if (group) group.push(indication)
      else bySymbol.set(indication.symbol, [indication])
    }

    const symbolGroups = [...bySymbol.entries()]
    const groupedResults = await mapWithConcurrency(
      symbolGroups,
      concurrencyFromEnv(["BASE_POSITION_SYMBOL_CONCURRENCY", "ENGINE_SYMBOL_CONCURRENCY"], 4, 8, symbolGroups.length),
      async ([symbol, symbolIndications]) => withBaseAdmissionLock(client, connectionId, symbol, async () => {
        const [existingLong, existingShort] = await Promise.all([
          countExistingPositions(client, connectionId, symbol, "long", maxLong),
          countExistingPositions(client, connectionId, symbol, "short", maxShort),
        ])
        let longSlots = Math.max(0, maxLong - existingLong)
        let shortSlots = Math.max(0, maxShort - existingShort)
        const created: BasePosition[] = []
        const writes: Promise<unknown>[] = []

        for (let indicationIndex = 0; indicationIndex < symbolIndications.length; indicationIndex++) {
          const indication = symbolIndications[indicationIndex]
          const now = Date.now()
          if (longSlots > 0) {
            const longPosition: BasePosition = {
              id: `base:${connectionId}:${indication.symbol}:${indication.timestamp}:${indicationIndex}:long`,
              connectionId,
              connectionName: connection.name,
              symbol: indication.symbol,
              timeframe: indication.timeframe,
              direction: "long",
              entryPrice: indication.price,
              entryTime: now,
              indicationSignal: indication.signal,
              indicationStrength: indication.strength,
              status: "open",
              sourceIndicationTimestamp: indication.timestamp,
              createdAt: now,
              updatedAt: now,
            }
            created.push(longPosition)
            writes.push(storeBasePosition(client, longPosition))
            longSlots--
          }
          if (shortSlots > 0) {
            const shortPosition: BasePosition = {
              id: `base:${connectionId}:${indication.symbol}:${indication.timestamp}:${indicationIndex}:short`,
              connectionId,
              connectionName: connection.name,
              symbol: indication.symbol,
              timeframe: indication.timeframe,
              direction: "short",
              entryPrice: indication.price,
              entryTime: now,
              indicationSignal: indication.signal,
              indicationStrength: indication.strength,
              status: "open",
              sourceIndicationTimestamp: indication.timestamp,
              createdAt: now,
              updatedAt: now,
            }
            created.push(shortPosition)
            writes.push(storeBasePosition(client, shortPosition))
            shortSlots--
          }
          if (longSlots === 0 && shortSlots === 0) break
        }
        if (writes.length > 0) await Promise.all(writes)
        return created
      }),
    )
    for (const created of groupedResults) basePositions.push(...created)

    console.log(`${LOG_PREFIX} Generated ${basePositions.length} base positions`)
    return basePositions
  } catch (err) {
    console.error(`${LOG_PREFIX} Error generating base positions: ${err}`)
    throw err
  }
}

async function withBaseAdmissionLock<T>(
  client: any,
  connectionId: string,
  symbol: string,
  work: () => Promise<T>,
): Promise<T | []> {
  const key = `base:positions:admission_lock:${connectionId}:${symbol}`
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const acquired = await client.set(key, token, { NX: true, PX: 30_000 }).catch(() => null)
  if (acquired !== "OK") return []
  try {
    return await work()
  } finally {
    try {
      if (typeof client.eval === "function") {
        await client.eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
          { keys: [key], arguments: [token] },
        )
      } else if ((await client.get(key)) === token) {
        // InlineLocalRedis is single-process and does not expose EVAL. Its
        // 30-second lease comfortably exceeds this bounded write section.
        await client.del(key)
      }
    } catch { /* lease expires automatically */ }
  }
}

/**
 * Store base position in Redis
 */
async function storeBasePosition(client: any, position: BasePosition): Promise<void> {
  const key = `base:position:${position.id}`
  const listKey = `base:positions:${position.connectionId}:${position.symbol}`

  try {
    // Store individual position
    await client.setex(key, 604800, JSON.stringify(position)) // 7 days

    // Add to list for quick access
    await client.lpush(listKey, JSON.stringify(position))
    await client.ltrim(listKey, 0, 999) // Keep max 1000 per symbol

    // Maintain an explicit per-connection index so runtime readers never use Redis KEYS.
    await client.sadd(`base:positions:index:${position.connectionId}`, position.id)
    await client.expire(`base:positions:index:${position.connectionId}`, 604800)

    // Index by direction for counting
    const directionKey = `base:positions:${position.connectionId}:${position.symbol}:${position.direction}`
    await client.lpush(directionKey, position.id)
    await client.ltrim(directionKey, 0, 999)
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error storing base position: ${err}`)
  }
}

/**
 * Count OPEN (not closed) base positions in a direction.
 *
 * The direction index list (`base:positions:{connId}:{symbol}:{dir}`) is
 * append-only and grows forever — using `llen` on it counted ALL-TIME entries,
 * not just currently-open ones. After the first position was created the limit
 * check `existingX >= maxX` was always true, permanently blocking new positions
 * for that symbol+direction.
 *
 * Fix: scan the most-recent position IDs, fetch each record, and count only
 * those whose `status` is "open". We cap the scan at `maxPosLimit + 1` entries
 * so we never do more reads than necessary — if the first N positions are all
 * open we already know the limit is reached without scanning further.
 */
async function countExistingPositions(
  client: any,
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  maxPosLimit: number = 10,
): Promise<number> {
  try {
    const indexKey = `base:positions:${connectionId}:${symbol}:${direction}`
    // Fetch at most (maxPosLimit + 1) most-recent IDs from the list (newest first).
    const ids: string[] = ((await client.lrange(indexKey, 0, maxPosLimit).catch(() => [])) || []) as string[]
    if (ids.length === 0) return 0

    // Batch-fetch all position records in one pipeline round-trip.
    const pipeline = client.multi()
    for (const id of ids) pipeline.get(`base:position:${id}`)
    const results = await pipeline.exec().catch(() => null)
    if (!results) return 0

    let openCount = 0
    for (const r of results) {
      const raw = Array.isArray(r) ? r[1] : r
      if (!raw) continue
      try {
        const pos = JSON.parse(raw as string)
        if (pos?.status === "open") openCount++
      } catch { /* skip unparseable */ }
    }
    return openCount
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error counting positions: ${err}`)
    return 0
  }
}

/**
 * Get all base positions for connection
 */
export async function getBasePositions(connectionId: string): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const ids = ((await client.smembers(`base:positions:index:${connectionId}`).catch(() => [])) || []) as string[]
    if (ids.length === 0) return []

    // Batch GETs from the explicit index. Avoid Redis KEYS here: this accessor
    // runs as part of the trade-engine hot path and may be polled frequently.
    const rawValues = await Promise.all(
      ids.map((id: string) => client.get(`base:position:${id}`).catch(() => null)),
    )
    const positions: BasePosition[] = []
    for (const data of rawValues) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions: ${err}`)
    return []
  }
}

/**
 * Get base positions by symbol
 */
export async function getBasePositionsBySymbol(
  connectionId: string,
  symbol: string
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const listKey = `base:positions:${connectionId}:${symbol}`
    const positionStrs = await client.lrange(listKey, 0, -1)

    return positionStrs
      .map((p: string) => {
        try {
          return JSON.parse(p)
        } catch {
          return null
        }
      })
      .filter((p: any) => p !== null)
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions by symbol: ${err}`)
    return []
  }
}

/**
 * Get base positions by direction
 */
export async function getBasePositionsByDirection(
  connectionId: string,
  symbol: string,
  direction: "long" | "short"
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const directionKey = `base:positions:${connectionId}:${symbol}:${direction}`
    const positionIds = await client.lrange(directionKey, 0, -1)
    const positions: BasePosition[] = []

    for (const positionId of positionIds) {
      const key = `base:position:${positionId}`
      const data = await client.get(key)
      if (data) {
        positions.push(JSON.parse(data))
      }
    }

    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions by direction: ${err}`)
    return []
  }
}

/**
 * Update base position status
 */
export async function updateBasePositionStatus(
  positionId: string,
  status: "open" | "closed"
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `base:position:${positionId}`
    const data = await client.get(key)

    if (data) {
      const position: BasePosition = JSON.parse(data)
      position.status = status
      position.updatedAt = Date.now()

      await client.setex(key, 604800, JSON.stringify(position))
      await client.sadd(`base:positions:index:${position.connectionId}`, position.id)
      await client.expire(`base:positions:index:${position.connectionId}`, 604800)
      console.log(`${LOG_PREFIX} Updated position ${positionId} status to ${status}`)
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error updating position status: ${err}`)
  }
}

/**
 * Clean up old base positions (older than 24 hours with closed status)
 */
export async function cleanupOldBasePositions(connectionId: string): Promise<number> {
  await initRedis()
  const client = getRedisClient()
  let cleaned = 0

  try {
    const ids = ((await client.smembers(`base:positions:index:${connectionId}`).catch(() => [])) || []) as string[]
    if (ids.length === 0) return 0

    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours

    // Phase 1: batch-fetch every row from the explicit index.
    const keys = ids.map((id) => `base:position:${id}`)
    const rawValues = await Promise.all(
      keys.map((k: string) => client.get(k).catch(() => null)),
    )

    // Phase 2: collect the deletable keys, then DEL them in parallel.
    const deletable: string[] = []
    for (let i = 0; i < keys.length; i++) {
      const data = rawValues[i]
      if (!data) continue
      try {
        const position: BasePosition = JSON.parse(data as string)
        if (position.status === "closed" && now - position.updatedAt > maxAge) {
          deletable.push(keys[i])
        }
      } catch { /* skip malformed rows */ }
    }
    if (deletable.length > 0) {
      await Promise.all(deletable.map((k) => client.del(k).catch(() => 0)))
      const deletedIds = deletable.map((k) => k.replace(/^base:position:/, ""))
      if (deletedIds.length > 0) await client.srem(`base:positions:index:${connectionId}`, ...deletedIds).catch(() => 0)
      cleaned = deletable.length
    }

    console.log(`${LOG_PREFIX} Cleaned up ${cleaned} old base positions`)
    return cleaned
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error cleaning up positions: ${err}`)
    return 0
  }
}
