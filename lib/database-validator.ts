/**
 * Database Validation and Repair Utility
 * Checks Redis database completeness and repairs missing data structures
 */

import { initRedis, getRedisClient, getAllConnections, setSettings, getSettings } from "@/lib/redis-db"
import { getMigrationStatus, runMigrations } from "@/lib/redis-migrations"
import { countRedisKeys } from "@/lib/redis-scan"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  repairs: string[]
  stats: {
    connections: number
    trades: number
    positions: number
    marketData: number
    settings: number
  }
}

export interface DatabaseValidationOptions {
  migrationStatus?: any
}

async function countIndexedRecords(client: any, indexKey: string, fallbackPattern: string): Promise<number> {
  if (typeof client?.exists === "function" && typeof client?.scard === "function") {
    const exists = await client.exists(indexKey).catch(() => 0)
    if (exists) return Number(await client.scard(indexKey).catch(() => 0)) || 0
  }
  return countRedisKeys(client, fallbackPattern)
}

export async function validateDatabase(options: DatabaseValidationOptions = {}): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    repairs: [],
    stats: {
      connections: 0,
      trades: 0,
      positions: 0,
      marketData: 0,
      settings: 0,
    },
  }

  try {
    await initRedis()
    const client = getRedisClient()
    const [connections, connectionIds, settings, globalState, marketDataCount, tradeCount, positionCount] = await Promise.all([
      getAllConnections(),
      client.smembers("connections").catch(() => [] as string[]),
      getSettings("system"),
      client.hgetall("trade_engine:global").catch(() => ({})),
      countRedisKeys(client, "market_data:*"),
      countIndexedRecords(client, "idx:trades", "trade:*"),
      countIndexedRecords(client, "idx:positions", "position:*"),
    ])

    // Check 1: Connections exist
    result.stats.connections = connections.length

    if (connections.length === 0) {
      result.errors.push("No connections found in database")
      result.valid = false
    }

    // Check 2: Each connection has required fields
    for (const conn of connections) {
      const required = ['id', 'name', 'exchange']
      for (const field of required) {
        if (!conn[field]) {
          result.errors.push(`Connection ${conn.id || 'unknown'} missing field: ${field}`)
          result.valid = false
        }
      }
    }

    // Check 3: Connections set exists
    if (connectionIds.length === 0) {
      result.repairs.push("Rebuilding connections set...")
      const ids = connections.map((connection) => String(connection.id || "")).filter(Boolean)
      if (ids.length > 0) await client.sadd("connections", ...ids)
    }

    // Check 4: Settings exist
    result.stats.settings = settings ? Object.keys(settings).length : 0

    // Check 5: Canonical migration status. `_schema_version` plus the database
    // health hash are the durable contract used by the migration runner; the
    // legacy `migrations:status` key is neither written nor authoritative.
    let migrationStatus = options.migrationStatus ?? await getMigrationStatus()
    if (!migrationStatus.isMigrated) {
      result.repairs.push(
        `Running migrations (v${migrationStatus.currentVersion} -> v${migrationStatus.latestVersion})...`,
      )
      await runMigrations()
      migrationStatus = await getMigrationStatus()
      if (!migrationStatus.isMigrated) {
        result.errors.push(
          `Migration readiness failed (v${migrationStatus.currentVersion}/${migrationStatus.latestVersion})`,
        )
        result.valid = false
      }
    }

    // Check 6: Trade engine global state
    if (!globalState || Object.keys(globalState).length === 0) {
      result.repairs.push("Initializing trade engine global state...")
      await client.hset('trade_engine:global', {
        status: 'stopped',
        initialized_at: new Date().toISOString(),
      })
    }

    // Check 7: Market data exists
    result.stats.marketData = marketDataCount

    if (marketDataCount === 0) {
      result.errors.push("No market data found")
    }

    // Check 8: Maintained O(1) indexes, with SCAN only for legacy recovery.
    result.stats.trades = tradeCount
    result.stats.positions = positionCount

    console.log('[v0] [DB Validate] Database validation complete:', result)
    return result
  } catch (error) {
    result.valid = false
    result.errors.push(`Validation error: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
}

export async function repairDatabase(): Promise<ValidationResult> {
  console.log('[v0] [DB Repair] Starting database repair...')
  
  const result = await validateDatabase()
  
  if (result.valid && result.errors.length === 0) {
    console.log('[v0] [DB Repair] Database is valid, no repairs needed')
    return result
  }

  try {
    await initRedis()
    const client = getRedisClient()

    // validateDatabase() already crossed the canonical init/migration barrier.
    result.repairs.push('Migrations verified')

    // Repair 2: Rebuild the canonical set and all maintained secondary indexes.
    const connections = await getAllConnections()
    const ids = connections.map((connection) => String(connection.id || "")).filter(Boolean)
    if (ids.length > 0) await client.sadd("connections", ...ids)
    for (const conn of connections) {
      if (!conn.updated_at) await setSettings(`connection:${conn.id}`, { ...conn, updated_at: new Date().toISOString() })
    }
    const { rebuildAllIndexes } = await import("@/lib/database-consolidation")
    await rebuildAllIndexes(connections)
    result.repairs.push(`Rebuilt canonical and secondary indexes for ${connections.length} connections`)

    // Repair 3: Initialize default settings if missing
    const defaultSettings = await getSettings('system')
    if (!defaultSettings) {
      await setSettings('system', {
        initialized: true,
        initialized_at: new Date().toISOString(),
        version: '1.0.0',
      })
      result.repairs.push('Initialized default settings')
    }

    console.log('[v0] [DB Repair] Database repair complete')
    
    // Re-validate after repairs
    return await validateDatabase()
  } catch (error) {
    result.errors.push(`Repair error: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
}

export async function logDatabaseStatus(): Promise<void> {
  const result = await validateDatabase()
  
  console.log('\n╔════════════════════════════════════════════════════════════╗')
  console.log('║              DATABASE STATUS REPORT                        ║')
  console.log('╠════════════════════════════════════════════════════════════╣')
  console.log(`║ Valid: ${result.valid ? '✓ YES' : '✗ NO'}                                        ║`)
  console.log('╠════════════════════════════════════════════════════════════╣')
  console.log('║ STATISTICS:                                                ║')
  console.log(`║   Connections:    ${result.stats.connections.toString().padEnd(5)}                              ║`)
  console.log(`║   Trades:         ${result.stats.trades.toString().padEnd(5)}                              ║`)
  console.log(`║   Positions:      ${result.stats.positions.toString().padEnd(5)}                              ║`)
  console.log(`║   Market Data:    ${result.stats.marketData.toString().padEnd(5)}                              ║`)
  console.log(`║   Settings:       ${result.stats.settings.toString().padEnd(5)}                              ║`)
  console.log('╠════════════════════════════════════════════════════════════╣')
  
  if (result.errors.length > 0) {
    console.log('║ ERRORS:                                                    ║')
    result.errors.slice(0, 5).forEach(err => {
      console.log(`║   ${err.slice(0, 50).padEnd(50)} ║`)
    })
    console.log('╠════════════════════════════════════════════════════════════╣')
  }
  
  if (result.repairs.length > 0) {
    console.log('║ REPAIRS:                                                   ║')
    result.repairs.forEach(repair => {
      console.log(`║   ${repair.slice(0, 50).padEnd(50)} ║`)
    })
    console.log('╠════════════════════════════════════════════════════════════╣')
  }
  
  console.log('╚════════════════════════════════════════════════════════════╝\n')
}
