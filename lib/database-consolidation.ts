/**
 * Database Consolidation Service
 * PHASE 3 FIX: Consolidate scattered Redis keys into unified structures
 * 
 * Goals:
 * 1. Unified progression keys (single hash per connection)
 * 2. Efficient indexes for fast queries (O(1) instead of O(n))
 * 3. Clear separation of concerns (progression vs engine vs market data)
 * 4. Easy migration path for existing data
 */

import { getRedisClient, getConnection, getAllConnections } from "@/lib/redis-db"
import {
  rebuildConnectionSecondaryIndexes,
  syncConnectionSecondaryIndexes,
} from "@/lib/database-indexes"
import {
  createDatabaseMaintenanceFingerprint,
  DATABASE_MAINTENANCE_LOCK_KEY,
  DATABASE_MAINTENANCE_STATUS_KEY,
  ensureUnifiedProgressionKeysWithClient,
} from "@/lib/database-maintenance"
import { createRedisLockToken, releaseOwnedRedisLock } from "@/lib/redis-lock-utils"

/**
 * PHASE 3 FIX 3.1: Unified progression key structure
 * 
 * Maps old scattered keys to new consolidated structure:
 * progression:{connectionId} → hash with all progression data
 */
export async function ensureUnifiedProgressionKeys(connectionId: string): Promise<boolean> {
  const client = getRedisClient()
  return ensureUnifiedProgressionKeysWithClient(client, connectionId)
}

/**
 * PHASE 3 FIX 3.2: Create efficient connection indexes
 */
export async function updateConnectionIndex(connectionId: string) {
  const client = getRedisClient()

  try {
    const conn = await getConnection(connectionId)
    if (!conn) {
      console.warn(`[v0] [DB] Connection not found for indexing: ${connectionId}`)
      return
    }

    await syncConnectionSecondaryIndexes(client, conn)
  } catch (error) {
    console.error(`[v0] [DB] Error updating indexes for ${connectionId}:`, error)
  }
}

/**
 * Rebuild all indexes (useful after data import or recovery)
 */
export async function rebuildAllIndexes(connections?: any[]) {
  console.log(`[v0] [DB] Rebuilding all connection indexes...`)

  try {
    const client = getRedisClient()
    const allConnections = connections ?? await getAllConnections()
    const rebuilt = await rebuildConnectionSecondaryIndexes(client, allConnections)
    console.log(
      `[v0] [DB] ✓ Rebuilt ${rebuilt.indexKeys} connection indexes ` +
      `(${rebuilt.memberships} memberships, ${rebuilt.connections} connections)`,
    )
    return rebuilt
  } catch (error) {
    console.error(`[v0] [DB] Error rebuilding indexes:`, error)
    throw error
  }
}

/**
 * Query using indexes (O(1) complexity)
 */
export async function getMainEnabledConnectionIds(): Promise<string[]> {
  const client = getRedisClient()
  return client.smembers("connections:main:enabled")
}

export async function getBaseEnabledConnectionIds(): Promise<string[]> {
  const client = getRedisClient()
  return client.smembers("connections:base:enabled")
}

export async function getWorkingConnectionIds(): Promise<string[]> {
  const client = getRedisClient()
  return client.smembers("connections:working")
}

export async function getConnectionsByExchange(exchange: string): Promise<string[]> {
  const client = getRedisClient()
  return client.smembers(`connections:exchange:${exchange.toLowerCase()}`)
}

/**
 * PHASE 3 FIX 3.3: Unified engine state structure
 */
export async function setEngineState(connectionId: string, state: {
  is_running?: boolean | string
  status?: "running" | "stopped" | "error"
  started_at?: string
  stopped_at?: string
  error_message?: string
}) {
  const client = getRedisClient()

  const engineState = {
    is_running: state.is_running ? "1" : "0",
    status: state.status || "idle",
    started_at: state.started_at || "",
    stopped_at: state.stopped_at || "",
    error_message: state.error_message || "",
    updated_at: new Date().toISOString(),
  }

  await client.hset(`engine:${connectionId}`, engineState)
}

export async function getEngineState(connectionId: string) {
  const client = getRedisClient()
  return client.hgetall(`engine:${connectionId}`)
}

/**
 * PHASE 3 FIX 3.4: Unified market data tracking
 */
export async function setMarketDataState(connectionId: string, state: {
  last_update?: string
  symbols_count?: number
  real_data_count?: number
  synthetic_count?: number
}) {
  const client = getRedisClient()

  const marketState = {
    last_update: state.last_update || new Date().toISOString(),
    symbols_count: String(state.symbols_count || 0),
    real_data_count: String(state.real_data_count || 0),
    synthetic_count: String(state.synthetic_count || 0),
  }

  await client.hset(`market_data_state:${connectionId}`, marketState)
}

export async function getMarketDataState(connectionId: string) {
  const client = getRedisClient()
  return client.hgetall(`market_data_state:${connectionId}`)
}

/**
 * PHASE 3: Complete database consolidation
 */
export interface DatabaseConsolidationResult {
  status: "completed" | "skipped" | "busy"
  connections: number
  progressionKeysUpdated: number
  indexMemberships: number
  fingerprint: string
  durationMs: number
}

export async function consolidateDatabase(options: { force?: boolean } = {}): Promise<DatabaseConsolidationResult> {
  const startedAt = Date.now()
  const client = getRedisClient()
  const [schemaVersionRaw, allConnections] = await Promise.all([
    client.get("_schema_version"),
    getAllConnections(),
  ])
  const schemaVersion = Number(schemaVersionRaw || 0)
  const fingerprint = createDatabaseMaintenanceFingerprint(schemaVersion, allConnections)

  const alreadyComplete = async () => {
    const status = ((await client.hgetall(DATABASE_MAINTENANCE_STATUS_KEY).catch(() => ({}))) || {}) as Record<string, string>
    return status.status === "completed" && status.fingerprint === fingerprint
  }
  if (!options.force && await alreadyComplete()) {
    return {
      status: "skipped",
      connections: allConnections.length,
      progressionKeysUpdated: 0,
      indexMemberships: 0,
      fingerprint,
      durationMs: Date.now() - startedAt,
    }
  }

  const token = createRedisLockToken("database-maintenance")
  const acquired = await client.set(DATABASE_MAINTENANCE_LOCK_KEY, token, { NX: true, EX: 300 }).catch(() => null)
  if (acquired !== "OK") {
    return {
      status: "busy",
      connections: allConnections.length,
      progressionKeysUpdated: 0,
      indexMemberships: 0,
      fingerprint,
      durationMs: Date.now() - startedAt,
    }
  }

  try {
    if (!options.force && await alreadyComplete()) {
      return {
        status: "skipped",
        connections: allConnections.length,
        progressionKeysUpdated: 0,
        indexMemberships: 0,
        fingerprint,
        durationMs: Date.now() - startedAt,
      }
    }

    console.log(`[v0] [DB] Starting database consolidation...`)
    await client.hset(DATABASE_MAINTENANCE_STATUS_KEY, {
      status: "running",
      fingerprint,
      schema_version: String(schemaVersion),
      started_at: new Date().toISOString(),
    })

    let progressionKeysUpdated = 0
    const batchSize = 12
    for (let offset = 0; offset < allConnections.length; offset += batchSize) {
      const batch = allConnections.slice(offset, offset + batchSize)
      const updates = await Promise.all(
        batch.map((connection) => ensureUnifiedProgressionKeysWithClient(client, connection.id)),
      )
      progressionKeysUpdated += updates.filter(Boolean).length
    }
    const indexes = await rebuildConnectionSecondaryIndexes(client, allConnections)
    const completedAt = new Date().toISOString()
    await client.hset(DATABASE_MAINTENANCE_STATUS_KEY, {
      status: "completed",
      fingerprint,
      schema_version: String(schemaVersion),
      connection_count: String(allConnections.length),
      progression_keys_updated: String(progressionKeysUpdated),
      index_keys: String(indexes.indexKeys),
      index_memberships: String(indexes.memberships),
      completed_at: completedAt,
      last_error: "",
    })
    console.log(`[v0] [DB] ✓ Database consolidation complete`)
    return {
      status: "completed",
      connections: allConnections.length,
      progressionKeysUpdated,
      indexMemberships: indexes.memberships,
      fingerprint,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    await client.hset(DATABASE_MAINTENANCE_STATUS_KEY, {
      status: "failed",
      failed_at: new Date().toISOString(),
      last_error: error instanceof Error ? error.message : String(error),
    }).catch(() => 0)
    console.error(`[v0] [DB] Database consolidation failed:`, error)
    throw error
  } finally {
    await releaseOwnedRedisLock(client, DATABASE_MAINTENANCE_LOCK_KEY, token).catch(() => false)
  }
}
