import { query, queryOne, execute, getDatabaseType } from "./db"

// Convert PostgreSQL RETURNING clause to SQLite equivalent
export async function insertReturning<T = any>(
  table: string,
  columns: string[],
  values: any[],
  returningColumns: string[] = ["*"],
): Promise<T | null> {
  const dbType = getDatabaseType()

  if (dbType === "postgresql") {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")
    const insertQuery = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING ${returningColumns.join(", ")}`
    return await queryOne<T>(insertQuery, values)
  } else {
    const placeholders = columns.map(() => "?").join(", ")
    const insertQuery = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`

    const result = await execute(insertQuery, values)

    if (result && (result as any).lastInsertRowid) {
      const selectQuery = `SELECT ${returningColumns.join(", ")} FROM ${table} WHERE rowid = ?`
      return await queryOne<T>(selectQuery, [(result as any).lastInsertRowid])
    }

    return null
  }
}

// Convert PostgreSQL UPDATE ... RETURNING to SQLite equivalent
export async function updateReturning<T = any>(
  table: string,
  updates: Record<string, any>,
  where: string,
  whereParams: any[],
  returningColumns: string[] = ["*"],
): Promise<T[]> {
  const dbType = getDatabaseType()

  if (dbType === "postgresql") {
    const setClause = Object.keys(updates)
      .map((key, i) => `${key} = $${i + 1}`)
      .join(", ")
    const updateValues = Object.values(updates)
    const whereParamStart = updateValues.length + 1
    const whereClause = where.replace(/\?/g, () => `$${whereParamStart + whereParams.indexOf("?")}`)

    const updateQuery = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING ${returningColumns.join(", ")}`
    return await query<T>(updateQuery, [...updateValues, ...whereParams])
  } else {
    const setClause = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(", ")
    const updateValues = Object.values(updates)

    const updateQuery = `UPDATE ${table} SET ${setClause} WHERE ${where}`
    await execute(updateQuery, [...updateValues, ...whereParams])

    const selectQuery = `SELECT ${returningColumns.join(", ")} FROM ${table} WHERE ${where}`
    return await query<T>(selectQuery, whereParams)
  }
}

// JSON operations helper
export function jsonExtract(column: string, path: string): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return `${column}->>'${path}'`
  }
  return `json_extract(${column}, '${path}')`
}

// Array contains helper
export function jsonArrayContains(column: string, value: any): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return `${column} @> '${JSON.stringify([value])}'::jsonb`
  }
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${JSON.stringify(value)})`
}

// Date/time helpers
export function now(): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return "NOW()"
  }
  return "datetime('now')"
}

export function dateAdd(column: string, interval: string): string {
  const dbType = getDatabaseType()
  const match = interval.match(/(\d+)\s+(\w+)/)

  if (dbType === "postgresql") {
    return `${column} + INTERVAL '${interval}'`
  }

  if (match) {
    return `datetime(${column}, '+${match[1]} ${match[2]}')`
  }
  return column
}

export function dateSub(column: string, interval: string): string {
  const dbType = getDatabaseType()
  const match = interval.match(/(\d+)\s+(\w+)/)

  if (dbType === "postgresql") {
    return `${column} - INTERVAL '${interval}'`
  }

  if (match) {
    return `datetime(${column}, '-${match[1]} ${match[2]}')`
  }
  return column
}

// Convert PostgreSQL placeholders ($1, $2) to SQLite placeholders (?, ?)
export function convertPlaceholders(queryText: string): string {
  const dbType = getDatabaseType()
  if (dbType === "sqlite") {
    return queryText.replace(/\$\d+/g, "?")
  }
  return queryText
}

// Auto-increment ID helper
export function autoIncrementId(): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return "SERIAL PRIMARY KEY"
  }
  return "INTEGER PRIMARY KEY AUTOINCREMENT"
}

// Boolean type helper
export function booleanType(): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return "BOOLEAN"
  }
  return "INTEGER"
}

// Timestamp type helper
export function timestampType(): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return "TIMESTAMP"
  }
  return "DATETIME"
}

// JSONB type helper
export function jsonType(): string {
  const dbType = getDatabaseType()
  if (dbType === "postgresql") {
    return "JSONB"
  }
  return "TEXT"
}
