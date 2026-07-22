/**
 * Get the appropriate NOW() function for the current database type
 */
export function nowFunction(): string {
  return "datetime('now')"
}

/**
 * Get the appropriate CURRENT_TIMESTAMP for the current database type
 */
export function currentTimestamp(): string {
  return "CURRENT_TIMESTAMP"
}

/**
 * Create a date interval SQL expression
 * @param amount - Number of units
 * @param unit - Time unit (days, hours, minutes)
 */
export function dateInterval(amount: number, unit: "days" | "hours" | "minutes"): string {
  return `datetime('now', '-${amount} ${unit}')`
}

/**
 * Replace SQL functions in a query string to be compatible with current database
 */
export function adaptSQL(sqlQuery: string): string {
  return sqlQuery
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\bCURRENT_TIMESTAMP\b/gi, "CURRENT_TIMESTAMP")
}
