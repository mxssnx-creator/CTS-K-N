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

/**
 * PHASE 3 FIX 3.1: Unified progression key structure
 * 
 * Maps old scattered keys to new consolidated structure:
 * progression:{connectionId} → hash with all progression data
 */
export async function ensureUnifiedProgressionKeys(connectionId: string) {
  const client = getRedisClient()

  // Check if already using new format (try to read as hash)
  try {
    const existing = await client.hgetall(`progression:${connectionId}`)
    if (existing && Object.keys(existing).length > 0) {
      // Check if it has the new unified structure
      if (existing.phase_message) {
        console.log(`[v0] [DB] Progression key already unified for ${connectionId}`)
        return
      }
    }
  } catch {
    // Not a hash, continue with consolidation
  }

  console.log(`[v0] [DB] Consolidating progression keys for ${connectionId}`)

  // Read from old scattered keys
  const oldProgression = await client.hgetall(`progression:${connectionId}`)
  const oldCycles = await client.get(`progression:${connectionId}:cycles`)
  const oldIndications = await client.get(`progression:${connectionId}:indications`)
  const oldEngineState = await client.hgetall(`engine_state:${connectionId}`)
  const oldTradeEngineState = await client.hgetall(`trade_engine_state:${connectionId}`)

  // Build unified structure
  const unified = {
    cycles_completed: oldProgression?.cycles_completed || oldCycles || "0",
    successful_cycles: oldProgression?.successful_cycles || "0",
    failed_cycles: oldProgression?.failed_cycles || "0",
    phase: oldProgression?.phase || oldTradeEngineState?.phase || "idle",
    phase_progress: oldProgression?.progress || oldEngineState?.progress || "0",
    phase_message: oldProgression?.detail || oldEngineState?.detail || "",
    engine_started: oldEngineState?.started_at || oldTradeEngineState?.started_at || "",
    last_cycle: oldProgression?.last_cycle || "",
    last_indication_count: oldProgression?.indication_count || oldIndications || "0",
    last_strategy_count: oldProgression?.strategy_count || "0",
    symbols_count: oldTradeEngineState?.symbols_count || "0",
    updated_at: new Date().toISOString(),
  }

  // Write to new unified key
  await client.hset(`progression:${connectionId}`, unified)
  console.log(`[v0] [DB] ✓ Consolidated progression keys for ${connectionId}`)

  // Clean up old keys (keep for 24h backward compatibility)
  try {
    await client.expire(`progression:${connectionId}:cycles`, 86400)
    await client.expire(`progression:${connectionId}:indications`, 86400)
    await client.expire(`engine_state:${connectionId}`, 86400)
  } catch (e) {
    console.warn(`[v0] [DB] Could not expire old keys: ${e}`)
  }
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

    // Index 1: Main enabled connections (for quick queries)
    const isAssigned = conn.is_assigned === "1" || conn.is_assigned === true
    const isDashboardEnabled = conn.is_enabled_dashboard === "1" || conn.is_enabled_dashboard === true

    if (isAssigned && isDashboardEnabled) {
      await client.sadd("connections:main:enabled", connectionId)
      console.log(`[v0] [DB] Added ${connectionId} to main:enabled index`)
    } else {
      await client.srem("connections:main:enabled", connectionId)
    }

    // Index 2: Exchange-specific connections
    if (conn.exchange) {
      const exchange = conn.exchange.toLowerCase()
      await client.sadd(`connections:exchange:${exchange}`, connectionId)
      console.log(`[v0] [DB] Added ${connectionId} to exchange:${exchange} index`)
    }

    // Index 3: Base enabled connections (for settings)
    const isInserted = conn.is_inserted === "1" || conn.is_inserted === true
    const isBaseEnabled = conn.is_enabled === "1" || conn.is_enabled === true

    if (isInserted && isBaseEnabled) {
      await client.sadd("connections:base:enabled", connectionId)
    } else {
      await client.srem("connections:base:enabled", connectionId)
    }

    // Index 4: All connections by status
    if (conn.last_test_status === "success") {
      await client.sadd("connections:working", connectionId)
    } else {
      await client.srem("connections:working", connectionId)
    }
  } catch (error) {
    console.error(`[v0] [DB] Error updating indexes for ${connectionId}:`, error)
  }
}

/**
 * Rebuild all indexes (useful after data import or recovery)
 */
export async function rebuildAllIndexes() {
  console.log(`[v0] [DB] Rebuilding all connection indexes...`)

  try {
    const client = getRedisClient()

    // Clear old indexes
    await client.del(
      "connections:main:enabled",
      "connections:base:enabled",
      "connections:working"
    )

    // Get all connections
    const allConnections = await getAllConnections()

    // Rebuild each index
    for (const conn of allConnections) {
      await updateConnectionIndex(conn.id)
    }

    console.log(`[v0] [DB] ✓ Rebuilt ${allConnections.length} connection indexes`)
  } catch (error) {
    console.error(`[v0] [DB] Error rebuilding indexes:`, error)
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
export async function consolidateDatabase() {
  console.log(`[v0] [DB] Starting database consolidation...`)

  try {
    const allConnections = await getAllConnections()

    // Step 1: Consolidate all progression keys
    for (const conn of allConnections) {
      await ensureUnifiedProgressionKeys(conn.id)
    }
    console.log(`[v0] [DB] ✓ Consolidated ${allConnections.length} progression keys`)

    // Step 2: Rebuild all indexes
    await rebuildAllIndexes()

    console.log(`[v0] [DB] ✓ Database consolidation complete`)
  } catch (error) {
    console.error(`[v0] [DB] Database consolidation failed:`, error)
    throw error
  }
}
