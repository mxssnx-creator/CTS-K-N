"use server"

import { query, getDatabaseType } from "@/lib/db"

export interface TableInfo {
  name: string
  exists: boolean
  rowCount: number
}

export interface DatabaseStatus {
  isInitialized: boolean
  databaseType: string
  tables: TableInfo[]
  totalTables: number
  existingTables: number
  missingTables: string[]
}

const REQUIRED_TABLES = [
  "users",
  "system_settings",
  "site_logs",
  "exchange_connections",
  "connection_coordination",
  "indications_direction",
  "indications_move",
  "indications_active",
  "indications_optimal",
  "indications_auto",
  "indication_states",
  "strategies_base",
  "strategies_main",
  "strategies_real",
  "strategies_block",
  "strategies_dca",
  "strategies_trailing",
  "preset_types",
  "preset_configurations",
  "market_data",
  "orders",
  "trades",
  "base_pseudo_positions",
  "pseudo_positions",
  "performance_metrics",
]

export async function verifyDatabaseSetup(): Promise<DatabaseStatus> {
  console.log("[v0] Verifying database setup...")
  
  const dbType = getDatabaseType()
  const tables: TableInfo[] = []
  const missingTables: string[] = []
  let existingTables = 0

  for (const tableName of REQUIRED_TABLES) {
    const exists = await tableExists(tableName)
    let rowCount = 0
    
    if (exists) {
      try {
        const result = await query<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName}`)
        rowCount = result[0]?.count || 0
        existingTables++
      } catch (error) {
        console.warn(`[v0] Could not count rows in ${tableName}:`, error)
      }
    } else {
      missingTables.push(tableName)
    }
    
    tables.push({
      name: tableName,
      exists,
      rowCount,
    })
  }

  const isInitialized = missingTables.length === 0

  console.log(`[v0] Database verification: ${existingTables}/${REQUIRED_TABLES.length} tables exist`)
  if (missingTables.length > 0) {
    console.log(`[v0] Missing tables:`, missingTables.join(", "))
  }

  return {
    isInitialized,
    databaseType: dbType,
    tables,
    totalTables: REQUIRED_TABLES.length,
    existingTables,
    missingTables,
  }
}

async function tableExists(tableName: string): Promise<boolean> {
  const dbType = getDatabaseType()
  
  try {
    if (dbType === "postgresql") {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        ) as exists`,
        [tableName]
      )
      return result[0]?.exists || false
    } else {
      // SQLite
      const result = await query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [tableName]
      )
      return result.length > 0
    }
  } catch (error) {
    console.error(`[v0] Error checking if table ${tableName} exists:`, error)
    return false
  }
}

export async function getTableSizes(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {}
  
  for (const tableName of REQUIRED_TABLES) {
    try {
      const result = await query<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName}`)
      sizes[tableName] = result[0]?.count || 0
    } catch (error) {
      sizes[tableName] = -1 // Indicates table doesn't exist or error
    }
  }
  
  return sizes
}
