/**
 * Database Validation and Repair Utility
 * Checks Redis database completeness and repairs missing data structures
 */

import { initRedis, getRedisClient, getAllConnections, setSettings, getSettings } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"

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

export async function validateDatabase(): Promise<ValidationResult> {
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

    // Check 1: Connections exist
    const connections = await getAllConnections()
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
    const connectionIds = await client.smembers('connections')
    if (connectionIds.length === 0) {
      result.errors.push("Connections set is empty")
      result.repairs.push("Rebuilding connections set...")
      for (const conn of connections) {
        await client.sadd('connections', conn.id)
      }
    }

    // Check 4: Settings exist
    const settings = await getSettings('system')
    result.stats.settings = settings ? Object.keys(settings).length : 0

    // Check 5: Migration status
    const migrationStatus = await client.get('migrations:status')
    if (!migrationStatus) {
      result.errors.push("Migration status not found")
      result.repairs.push("Running migrations...")
      await runMigrations()
    }

    // Check 6: Trade engine global state
    const globalState = await client.hgetall('trade_engine:global')
    if (!globalState || Object.keys(globalState).length === 0) {
      result.repairs.push("Initializing trade engine global state...")
      await client.hset('trade_engine:global', {
        status: 'stopped',
        initialized_at: new Date().toISOString(),
      })
    }

    // Check 7: Market data exists
    const marketDataKeys = await client.keys('market_data:*')
    result.stats.marketData = marketDataKeys.length

    if (marketDataKeys.length === 0) {
      result.errors.push("No market data found")
    }

    // Check 8: Trades and positions indexes
    const tradeKeys = await client.keys('trades:*')
    result.stats.trades = tradeKeys.length

    const positionKeys = await client.keys('positions:*')
    result.stats.positions = positionKeys.length

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

    // Repair 1: Ensure migrations are run
    await runMigrations()
    result.repairs.push('Migrations completed')

    // Repair 2: Rebuild connection indexes
    const connections = await getAllConnections()
    for (const conn of connections) {
      // Ensure connection is in main set
      await client.sadd('connections', conn.id)
      
      // Ensure connection has updated_at
      if (!conn.updated_at) {
        await setSettings(`connection:${conn.id}`, {
          ...conn,
          updated_at: new Date().toISOString(),
        })
      }
    }
    result.repairs.push(`Rebuilt indexes for ${connections.length} connections`)

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
