import { query, queryOne, execute } from "./db"

// Insert and return a row through the Redis SQL compatibility layer.
export async function insertReturning<T = any>(
  table: string,
  columns: string[],
  values: any[],
  returningColumns: string[] = ["*"],
): Promise<T | null> {
  const placeholders = columns.map(() => "?").join(", ")
  const insertQuery = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
  const result = await execute(insertQuery, values)
  if (result && (result as any).lastInsertRowid) {
    return await queryOne<T>(`SELECT ${returningColumns.join(", ")} FROM ${table} WHERE rowid = ?`, [(result as any).lastInsertRowid])
  }
  return null
}

// Update and return rows through the Redis SQL compatibility layer.
export async function updateReturning<T = any>(
  table: string,
  updates: Record<string, any>,
  where: string,
  whereParams: any[],
  returningColumns: string[] = ["*"],
): Promise<T[]> {
  const setClause = Object.keys(updates).map((key) => `${key} = ?`).join(", ")
  const updateValues = Object.values(updates)
  await execute(`UPDATE ${table} SET ${setClause} WHERE ${where}`, [...updateValues, ...whereParams])
  return await query<T>(`SELECT ${returningColumns.join(", ")} FROM ${table} WHERE ${where}`, whereParams)
}

// JSON operations helper
export function jsonExtract(column: string, path: string): string {
  return `json_extract(${column}, '${path}')`
}

// Array contains helper
export function jsonArrayContains(column: string, value: any): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${JSON.stringify(value)})`
}

// Date/time helpers
export function now(): string {
  return "datetime('now')"
}

export function dateAdd(column: string, interval: string): string {
  const match = interval.match(/(\d+)\s+(\w+)/)

  if (match) {
    return `datetime(${column}, '+${match[1]} ${match[2]}')`
  }
  return column
}

export function dateSub(column: string, interval: string): string {
  const match = interval.match(/(\d+)\s+(\w+)/)

  if (match) {
    return `datetime(${column}, '-${match[1]} ${match[2]}')`
  }
  return column
}

// Normalize numbered placeholders for the Redis SQL compatibility layer.
export function convertPlaceholders(queryText: string): string {
  return queryText.replace(/\$\d+/g, "?")
}

// Auto-increment ID helper
export function autoIncrementId(): string {
  return "INTEGER PRIMARY KEY AUTOINCREMENT"
}

// Boolean type helper
export function booleanType(): string {
  return "INTEGER"
}

// Timestamp type helper
export function timestampType(): string {
  return "DATETIME"
}

// JSONB type helper
export function jsonType(): string {
  return "TEXT"
}
