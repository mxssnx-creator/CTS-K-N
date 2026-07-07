import { getDatabaseType } from "./db"

/**
 * Get the appropriate NOW() function for the current database type
 */
export function nowFunction(): string {
  const dbType = getDatabaseType()
  return dbType === "sqlite" ? "datetime('now')" : "NOW()"
}

/**
 * Get the appropriate CURRENT_TIMESTAMP for the current database type
 */
export function currentTimestamp(): string {
  const dbType = getDatabaseType()
  return dbType === "sqlite" ? "CURRENT_TIMESTAMP" : "CURRENT_TIMESTAMP"
}

/**
 * Create a date interval SQL expression
 * @param amount - Number of units
 * @param unit - Time unit (days, hours, minutes)
 */
export function dateInterval(amount: number, unit: "days" | "hours" | "minutes"): string {
  const dbType = getDatabaseType()
  
  if (dbType === "sqlite") {
    return `datetime('now', '-${amount} ${unit}')`
  } else {
    return `NOW() - INTERVAL '${amount} ${unit}'`
  }
}

/**
 * Replace SQL functions in a query string to be compatible with current database
 */
export function adaptSQL(sqlQuery: string): string {
  const dbType = getDatabaseType()
  
  if (dbType === "sqlite") {
    // Replace PostgreSQL-specific functions with SQLite equivalents
    return sqlQuery
      .replace(/\bNOW\(\)/gi, "datetime('now')")
      .replace(/\bCURRENT_TIMESTAMP\b/gi, "CURRENT_TIMESTAMP")
  }
  
  return sqlQuery
}
