/**
 * Database Verification and Audit Tool
 * Verifies SQLite database integrity, schema completeness, and performance configuration
 */

import path from "path"
import fs from "fs"
import { getClient } from "./db"

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "database.db")

interface TableInfo {
  name: string
  columns: number
  indexes: number
  rows: number
  size: string
}

interface DatabaseAudit {
  timestamp: string
  dbPath: string
  exists: boolean
  size: string
  totalTables: number
  totalIndexes: number
  pragmaSettings: Record<string, any>
  tables: TableInfo[]
  issues: string[]
  warnings: string[]
  recommendations: string[]
}

async function checkDatabaseIntegrity(): Promise<DatabaseAudit> {
  const audit: DatabaseAudit = {
    timestamp: new Date().toISOString(),
    dbPath: DB_PATH,
    exists: fs.existsSync(DB_PATH),
    size: "",
    totalTables: 0,
    totalIndexes: 0,
    pragmaSettings: {},
    tables: [],
    issues: [],
    warnings: [],
    recommendations: [],
  }

  if (!audit.exists) {
    audit.issues.push("Database file does not exist")
    return audit
  }

  try {
    const stats = fs.statSync(DB_PATH)
    audit.size = `${(stats.size / 1024 / 1024).toFixed(2)} MB`

    const db = await getClient()

    // Check critical PRAGMA settings
    const pragmas = [
      "journal_mode",
      "foreign_keys",
      "synchronous",
      "cache_size",
      "page_size",
      "busy_timeout",
      "auto_vacuum",
    ]

    for (const pragma of pragmas) {
      try {
        const result = db.prepare(`PRAGMA ${pragma}`).all()
        audit.pragmaSettings[pragma] = result[0]
      } catch (e) {
        // Some pragmas might not return results
      }
    }

    // Verify journal mode
    const journalMode = db.prepare("PRAGMA journal_mode").get() as any
    if (journalMode?.journal_mode !== "wal") {
      audit.warnings.push("WAL mode is not enabled - performance may be impacted")
      audit.recommendations.push("Enable WAL mode: PRAGMA journal_mode = WAL")
    }

    // Verify foreign keys
    const fkCheck = db.prepare("PRAGMA foreign_keys").get() as any
    if (fkCheck?.foreign_keys !== 1) {
      audit.issues.push("Foreign key constraints are not enabled")
      audit.recommendations.push("Enable foreign keys: PRAGMA foreign_keys = ON")
    }

    // Get all tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>

    audit.totalTables = tables.length

    for (const table of tables) {
      const columnInfo = db
        .prepare(`PRAGMA table_info(${table.name})`)
        .all() as Array<{ name: string }>

      const indexInfo = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`, [
          table.name,
        ])
        .all() as Array<{ name: string }>

      const rowCount = db
        .prepare(`SELECT COUNT(*) as count FROM ${table.name}`)
        .get() as { count: number }

      audit.tables.push({
        name: table.name,
        columns: columnInfo.length,
        indexes: indexInfo.length,
        rows: rowCount.count,
        size: `${((rowCount.count * 100) / 1024).toFixed(2)} KB`, // Rough estimate
      })
    }

    // Count indexes
    const indexes = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .get() as { count: number }
    audit.totalIndexes = indexes.count

    // Check for critical missing tables
    const expectedTables = [
      "users",
      "exchanges",
      "trading_pairs",
      "portfolios",
      "positions",
      "orders",
      "trades",
      "market_data",
      "strategies",
    ]

    const existingTableNames = new Set(tables.map((t) => t.name))
    const missingTables = expectedTables.filter((t) => !existingTableNames.has(t))

    if (missingTables.length > 0) {
      audit.warnings.push(`Missing expected tables: ${missingTables.join(", ")}`)
    }

    // Check migrations table
    const migrationsCheck = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='migrations'")
      .get() as { count: number }

    if (migrationsCheck.count === 0) {
      audit.issues.push("Migrations table does not exist")
      audit.recommendations.push("Run migration initialization")
    } else {
      const migrationCount = db.prepare("SELECT COUNT(*) as count FROM migrations").get() as { count: number }
      console.log(`[v0] Database has ${migrationCount.count} executed migrations`)
    }

    db.close()
  } catch (error) {
    audit.issues.push(`Database check error: ${error instanceof Error ? error.message : String(error)}`)
  }

  return audit
}

export async function auditDatabase() {
  console.log("[v0] ========================================")
  console.log("[v0] SQLite Database Audit")
  console.log("[v0] ========================================")

  const audit = await checkDatabaseIntegrity()

  console.log(`[v0] Database: ${audit.dbPath}`)
  console.log(`[v0] Exists: ${audit.exists ? "Yes" : "No"}`)
  console.log(`[v0] Size: ${audit.size}`)
  console.log(`[v0] Tables: ${audit.totalTables}`)
  console.log(`[v0] Indexes: ${audit.totalIndexes}`)

  if (Object.keys(audit.pragmaSettings).length > 0) {
    console.log("[v0] PRAGMA Settings:")
    for (const [pragma, value] of Object.entries(audit.pragmaSettings)) {
      console.log(`[v0]   - ${pragma}: ${JSON.stringify(value)}`)
    }
  }

  if (audit.issues.length > 0) {
    console.log("[v0] ISSUES:")
    audit.issues.forEach((issue) => console.log(`[v0]   ✗ ${issue}`))
  }

  if (audit.warnings.length > 0) {
    console.log("[v0] WARNINGS:")
    audit.warnings.forEach((warning) => console.log(`[v0]   ⚠ ${warning}`))
  }

  if (audit.recommendations.length > 0) {
    console.log("[v0] RECOMMENDATIONS:")
    audit.recommendations.forEach((rec) => console.log(`[v0]   → ${rec}`))
  }

  if (audit.tables.length > 0) {
    console.log("[v0] Tables Summary:")
    audit.tables.forEach((table) => {
      console.log(
        `[v0]   - ${table.name}: ${table.columns} columns, ${table.indexes} indexes, ${table.rows} rows`
      )
    })
  }

  console.log("[v0] ========================================")

  return audit
}

/**
 * Export the audit type for use elsewhere
 */
export type { DatabaseAudit, TableInfo }
