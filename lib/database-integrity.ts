/**
 * Database Integrity Checker - Validates relationships, constraints, and data consistency
 */

import { getRedisClient, getAllConnections, getSettings } from "@/lib/redis-db"

export interface IntegrityReport {
  timestamp: string
  passed: boolean
  checks: {
    name: string
    status: "pass" | "fail" | "warn"
    details: string
    errors: string[]
  }[]
  summary: {
    total: number
    passed: number
    failed: number
    warnings: number
  }
}

/**
 * Run comprehensive database integrity checks
 */
export async function checkDatabaseIntegrity(): Promise<IntegrityReport> {
  const checks: IntegrityReport["checks"] = []
  const client = getRedisClient()

  // Check 1: Schema Version
  try {
    const schemaVersion = await client.get("_schema_version")
    checks.push({
      name: "Schema Version",
      status: schemaVersion ? "pass" : "fail",
      details: `Current version: ${schemaVersion || "not set"}`,
      errors: schemaVersion ? [] : ["Schema version not initialized"],
    })
  } catch (e) {
    checks.push({
      name: "Schema Version",
      status: "fail",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 2: All Connections Valid
  try {
    const connections = await getAllConnections()
    const errors: string[] = []
    
    for (const conn of connections) {
      if (!conn.id) errors.push(`Connection missing id`)
      if (!conn.exchange) errors.push(`Connection ${conn.id} missing exchange`)
      if (!conn.is_inserted && !conn.is_predefined) {
        errors.push(`Connection ${conn.id} neither inserted nor predefined`)
      }
    }
    
    checks.push({
      name: "Connection Validity",
      status: errors.length === 0 ? "pass" : errors.length > 3 ? "fail" : "warn",
      details: `Total connections: ${connections.length}`,
      errors,
    })
  } catch (e) {
    checks.push({
      name: "Connection Validity",
      status: "fail",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 3: Global Engine State
  try {
    const globalEngine = await client.hgetall("trade_engine:global")
    const status = (globalEngine as any)?.status
    const errors: string[] = []
    
    if (!status) {
      errors.push("Global engine status not set")
    } else if (!["running", "stopped", "paused"].includes(status)) {
      errors.push(`Invalid global engine status: ${status}`)
    }
    
    checks.push({
      name: "Global Engine State",
      status: errors.length === 0 ? "pass" : "fail",
      details: `Status: ${status || "not set"}`,
      errors,
    })
  } catch (e) {
    checks.push({
      name: "Global Engine State",
      status: "fail",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 4: Active Connections Relationship
  try {
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c) => c.is_enabled_dashboard === true || c.is_enabled_dashboard === "1")
    const errors: string[] = []
    
    for (const conn of activeConnections) {
      const progressionKey = `engine_progression:${conn.id}`
      // Should have progression tracking if active
      const progression = await client.hget(progressionKey, "phase")
      if (!progression) {
        // Only warn if connection was supposed to run
        if (conn.is_enabled === true || conn.is_enabled === "1") {
          errors.push(`Active connection ${conn.id} missing progression tracking`)
        }
      }
    }
    
    checks.push({
      name: "Active Connections Relationships",
      status: errors.length === 0 ? "pass" : errors.length > 2 ? "fail" : "warn",
      details: `Active connections: ${activeConnections.length}, Checked progression: ${activeConnections.length}`,
      errors,
    })
  } catch (e) {
    checks.push({
      name: "Active Connections Relationships",
      status: "warn",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 5: Market Data Consistency
  try {
    const connections = await getAllConnections()
    const errors: string[] = []
    
    for (const conn of connections.slice(0, 5)) {
      // Check first 5 for performance
      const symbolsKey = `market_data:symbols:${conn.id}`
      const symbols = await client.smembers(symbolsKey)
      
      for (const symbol of symbols.slice(0, 3)) {
        const candlesKey = `market_data:candles:${conn.id}:${symbol}`
        const candles = await client.hgetall(candlesKey)
        if ((!candles || Object.keys(candles).length === 0) && symbols.length > 0) {
          errors.push(`${conn.id}:${symbol} registered but no candle data`)
        }
      }
    }
    
    checks.push({
      name: "Market Data Consistency",
      status: errors.length === 0 ? "pass" : errors.length > 5 ? "fail" : "warn",
      details: `Spot-checked market data for 5 connections`,
      errors: errors.slice(0, 10),
    })
  } catch (e) {
    checks.push({
      name: "Market Data Consistency",
      status: "warn",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 6: Settings Integrity
  try {
    const connections = await getAllConnections()
    const errors: string[] = []
    
    for (const conn of connections.filter((c) => c.is_enabled_dashboard)) {
      const settings = await getSettings(`settings:connection:${conn.id}`)
      if (!settings || Object.keys(settings).length === 0) {
        errors.push(`${conn.id} active but missing configuration settings`)
      }
    }
    
    checks.push({
      name: "Settings Integrity",
      status: errors.length === 0 ? "pass" : "warn",
      details: `Verified settings for active connections`,
      errors,
    })
  } catch (e) {
    checks.push({
      name: "Settings Integrity",
      status: "warn",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Check 7: Logs Accessibility
  try {
    const connections = await getAllConnections()
    const activeConns = connections.filter((c) => c.is_enabled_dashboard)
    let logsAccessible = 0
    
    for (const conn of activeConns) {
      const logsKey = `engine_logs:${conn.id}`
      const logs = await client.get(logsKey)
      if (logs) logsAccessible++
    }
    
    checks.push({
      name: "Logs Accessibility",
      status: logsAccessible > 0 ? "pass" : "warn",
      details: `${logsAccessible}/${activeConns.length} active connections have logs`,
      errors: logsAccessible === 0 && activeConns.length > 0 ? ["No logs found for active connections"] : [],
    })
  } catch (e) {
    checks.push({
      name: "Logs Accessibility",
      status: "warn",
      details: String(e),
      errors: [String(e)],
    })
  }

  // Summary
  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
  }

  return {
    timestamp: new Date().toISOString(),
    passed: summary.failed === 0,
    checks,
    summary,
  }
}

/**
 * Format integrity report for display
 */
export function formatIntegrityReport(report: IntegrityReport): string {
  let output = `\n=== DATABASE INTEGRITY REPORT ===\nTime: ${report.timestamp}\n`
  output += `Status: ${report.passed ? "✓ PASSED" : "✗ FAILED"}\n`
  output += `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.warnings} warnings\n\n`

  for (const check of report.checks) {
    const symbol = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "⚠"
    output += `${symbol} ${check.name}\n`
    output += `  ${check.details}\n`
    if (check.errors.length > 0) {
      output += `  Errors: ${check.errors.join("; ")}\n`
    }
  }

  return output
}
