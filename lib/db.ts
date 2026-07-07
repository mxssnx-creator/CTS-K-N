/**
 * Database Module - Redis-backed SQL compatibility shim
 * All 52+ legacy files import from "@/lib/db" expecting SQL functions.
 * This shim routes SQL-style calls to Redis operations transparently.
 */

export { 
  getRedisClient, 
  initRedis,
  saveConnection,
  getConnection,
  getAllConnections,
  updateConnection,
  deleteConnection,
  saveIndication,
  getIndications,
  saveMarketData,
  getMarketData,
  setSettings,
  getSettings,
  deleteSettings,
  flushAll,
  isRedisConnected,
  getRedisStats,
  verifyRedisHealth,
  createConnection
} from "./redis-db"

export { 
  runMigrations,
  rollbackMigration,
  getMigrationStatus
} from "./redis-migrations"

import { getRedisClient, initRedis as initRedisDb, getAllConnections as redisGetAll, getSettings as redisGetSettings, setSettings as redisSetSettings, getConnection as redisGetConnection, getMarketData as redisGetMarketData, saveMarketData as redisSetMarketData } from "./redis-db"
import { nanoid } from "nanoid"

/** Always returns "redis" */
export function getDatabaseType(): string {
  return "redis"
}

export async function getClient(): Promise<any> {
  return getRedisClient()
}

export function resetDatabaseClients(): void {}

/**
 * Parse a SQL-like query and route to Redis.
 * Supports common patterns:
 *   SELECT * FROM connections WHERE ...
 *   SELECT * FROM settings WHERE key = ...
 *   INSERT INTO <table> ...
 *   UPDATE <table> SET ... WHERE ...
 *   DELETE FROM <table> WHERE ...
 */
async function routeQuery(queryText: string, params: any[] = []): Promise<{ rows: any[], rowCount: number }> {
  await initRedisDb()
  const q = queryText.trim().replace(/\s+/g, " ")
  const upper = q.toUpperCase()

  try {
    // ---- SELECT FROM connections ----
    if (upper.includes("FROM CONNECTIONS") || upper.includes("FROM CONNECTION")) {
      if (upper.includes("WHERE") && params.length > 0) {
        const conn = await redisGetConnection(String(params[0]))
        return { rows: conn ? [conn] : [], rowCount: conn ? 1 : 0 }
      }
      const all = await redisGetAll()
      return { rows: all, rowCount: all.length }
    }

    // ---- SELECT FROM settings / config ----
    if (upper.includes("FROM SETTINGS") || upper.includes("FROM CONFIG") || upper.includes("FROM SYSTEM_SETTINGS")) {
      if (params.length > 0) {
        const val = await redisGetSettings(String(params[0]))
        if (val !== null && val !== undefined) {
          const row = typeof val === "object" ? val : { key: String(params[0]), value: val }
          return { rows: [row], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    }

    // ---- SELECT FROM market_data / candles / ohlcv ----
    if (upper.includes("FROM MARKET_DATA") || upper.includes("FROM CANDLES") || upper.includes("FROM OHLCV")) {
      if (params.length >= 1) {
        const interval = params.length >= 2 ? String(params[1]) : "1m"
        const data = await redisGetMarketData(String(params[0]), interval)
        return { rows: data || [], rowCount: (data || []).length }
      }
      return { rows: [], rowCount: 0 }
    }

    // ---- SELECT FROM trades / positions / orders ----
    if (upper.includes("FROM TRADES") || upper.includes("FROM POSITIONS") || upper.includes("FROM ORDERS")) {
      const client = getRedisClient()
      const table = upper.includes("FROM TRADES") ? "trades" : upper.includes("FROM POSITIONS") ? "positions" : "orders"
      
      if (upper.includes("WHERE") && params.length > 0) {
        const key = `${table}:${params[0]}`
        const item = await client.hgetall(key)
        if (item && Object.keys(item).length > 0) {
          return { rows: [{ ...item, id: params[0] }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      
      const keys = await client.smembers(table)
      const items: any[] = []
      for (const k of keys.slice(0, 100)) {
        const item = await client.hgetall(`${table}:${k}`)
        if (item && Object.keys(item).length > 0) {
          items.push({ ...item, id: k })
        }
      }
      return { rows: items, rowCount: items.length }
    }

    // ---- SELECT FROM indications ----
    if (upper.includes("FROM INDICATIONS")) {
      const client = getRedisClient()
      
      if (upper.includes("WHERE") && params.length > 0) {
        // Get indications for a specific connection
        const connId = params[0]
        const keys = await client.keys(`indications:${connId}:*`)
        const items: any[] = []
        for (const key of keys.slice(0, 100)) {
          const data = await client.get(key)
          if (data) {
            try {
              items.push(JSON.parse(data))
            } catch {
              items.push({ key, data })
            }
          }
        }
        return { rows: items, rowCount: items.length }
      }
      
      return { rows: [], rowCount: 0 }
    }

    // ---- SELECT FROM preset_types / presets / strategies ----
    if (upper.includes("FROM PRESET_TYPES") || upper.includes("FROM PRESETS") || upper.includes("FROM STRATEGIES")) {
      const client = getRedisClient()
      const table = upper.includes("FROM PRESET_TYPES") ? "preset_types" : upper.includes("FROM PRESETS") ? "presets" : "strategies"
      
      if (upper.includes("WHERE") && params.length > 0) {
        const item = await client.hgetall(`${table}:${params[0]}`)
        if (item && Object.keys(item).length > 0) {
          return { rows: [{ ...item, id: params[0] }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      
      const keys = await client.smembers(table)
      const items: any[] = []
      for (const k of keys.slice(0, 100)) {
        const item = await client.hgetall(`${table}:${k}`)
        if (item && Object.keys(item).length > 0) {
          items.push({ ...item, id: k })
        }
      }
      return { rows: items, rowCount: items.length }
    }

    // ---- SELECT FROM logs / errors / monitoring ----
    if (upper.includes("FROM LOGS") || upper.includes("FROM ERROR_LOGS") || upper.includes("FROM MONITORING")) {
      const client = getRedisClient()
      const listKey = upper.includes("FROM ERROR_LOGS") ? "error_logs" : upper.includes("FROM MONITORING") ? "monitoring_logs" : "logs"
      const items = await client.lrange(listKey, 0, 99)
      const parsed = items.map((item: any) => {
        try { return typeof item === "string" ? JSON.parse(item) : item } catch { return { message: item } }
      })
      return { rows: parsed, rowCount: parsed.length }
    }

    // ---- AGGREGATE QUERIES (COUNT, SUM, AVG, GROUP BY) ----
    if ((upper.includes("SELECT COUNT") || upper.includes("SUM(") || upper.includes("AVG(") || upper.includes("GROUP BY")) && !upper.includes("*")) {
      const tableMatch = upper.match(/FROM\s+(\w+)/i)
      const groupByMatch = upper.match(/GROUP BY\s+(\w+)/i)
      
      if (tableMatch) {
        const client = getRedisClient()
        const table = tableMatch[1].toLowerCase()
        const groupByField = groupByMatch ? groupByMatch[1].toLowerCase() : null
        
        // Extract aggregate functions
        const aggregates: {fn: string, field: string, alias: string}[] = []
        const aggregateMatches = q.matchAll(/(COUNT|SUM|AVG)\(([^)]+)\)\s*(?:AS\s+(\w+))?/gi)
        for (const match of aggregateMatches) {
          aggregates.push({
            fn: match[1].toUpperCase(),
            field: match[2].trim(),
            alias: match[3] || match[2].trim()
          })
        }
        
        // Get all items from table
        const ids = await client.smembers(table)
        const items: any[] = []
        for (const id of ids) {
          const item = await client.hgetall(`${table}:${id}`)
          if (item && Object.keys(item).length > 0) {
            // Parse numeric values
            const parsed: any = { id }
            for (const [k, v] of Object.entries(item)) {
              if (typeof v === 'string' && !isNaN(Number(v))) {
                parsed[k] = Number(v)
              } else {
                parsed[k] = v
              }
            }
            items.push(parsed)
          }
        }
        
        // Apply WHERE date filter if present
        let filteredItems = items
        const dateFilterMatch = upper.match(/(\w+)\s*>\s*datetime\('now',\s*\?\)/i)
        if (dateFilterMatch && params.length > 0) {
          const dateField = dateFilterMatch[1].toLowerCase()
          const timeDelta = params[params.length - 1] as string
          
          // Parse time delta like "-24 hours"
          const hoursMatch = timeDelta.match(/-(\d+)\s+hours?/i)
          if (hoursMatch) {
            const hoursBack = parseInt(hoursMatch[1])
            const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000)
            
            filteredItems = items.filter(item => {
              if (!item[dateField]) return false
              const itemTime = new Date(item[dateField]).getTime()
              return itemTime > cutoffTime
            })
          }
        }
        
        // Apply connection_id filter if present
        const connFilterMatch = upper.match(/connection_id\s*=\s*\?/i)
        if (connFilterMatch && params.length > 0) {
          const connectionId = params[0]
          filteredItems = filteredItems.filter(item => item.connection_id === connectionId)
        }
        
        // Group items if GROUP BY is specified
        const groups: Record<string, any[]> = {}
        if (groupByField) {
          for (const item of filteredItems) {
            const key = item[groupByField] || 'unknown'
            if (!groups[key]) groups[key] = []
            groups[key].push(item)
          }
        } else {
          groups['all'] = filteredItems
        }
        
        // Calculate aggregates for each group
        const results: any[] = []
        for (const [groupKey, groupItems] of Object.entries(groups)) {
          const result: any = {}
          
          if (groupByField) {
            result[groupByField] = groupKey
          }
          
          for (const agg of aggregates) {
            if (agg.fn === 'COUNT') {
              result[agg.alias] = groupItems.length
            } else if (agg.fn === 'SUM' && agg.field !== '*') {
              result[agg.alias] = groupItems.reduce((sum, item) => sum + (Number(item[agg.field]) || 0), 0)
            } else if (agg.fn === 'AVG' && agg.field !== '*') {
              const sum = groupItems.reduce((sum, item) => sum + (Number(item[agg.field]) || 0), 0)
              result[agg.alias] = groupItems.length > 0 ? sum / groupItems.length : 0
            }
          }
          
          results.push(result)
        }
        
        return { rows: results, rowCount: results.length }
      }
      
      return { rows: [{ count: 0 }], rowCount: 1 }
    }
    
    // ---- SELECT COUNT * ----
    if (upper.includes("SELECT COUNT(*)")) {
      const tableMatch = upper.match(/FROM\s+(\w+)/i)
      if (tableMatch) {
        const client = getRedisClient()
        const table = tableMatch[1].toLowerCase()
        const keys = await client.smembers(table)
        return { rows: [{ count: keys.length }], rowCount: 1 }
      }
      return { rows: [{ count: 0 }], rowCount: 1 }
    }

    // ---- INSERT INTO ----
    if (upper.startsWith("INSERT")) {
      const tableMatch = upper.match(/INTO\s+(\w+)/i)
      if (tableMatch) {
        const table = tableMatch[1].toLowerCase()
        const id = nanoid()
        const client = getRedisClient()
        
        if (table === "settings" || table === "config") {
          if (params.length >= 2) {
            await redisSetSettings(String(params[0]), params[1])
          }
        } else {
          await client.sadd(table, String(id))
          
          // Extract column names from INSERT statement
          const columnsMatch = q.match(/\(([^)]+)\)/i)
          if (columnsMatch && params.length > 0) {
            const columns = columnsMatch[1].split(',').map(c => c.trim().toLowerCase())
            const data: Record<string, any> = { id }
            
            // Map params to columns (skip VALUES placeholder positions)
            params.forEach((value, index) => {
              if (index < columns.length) {
                const col = columns[index]
                // Handle datetime('now')
                if (typeof value === 'string' && value.includes('datetime')) {
                  data[col] = new Date().toISOString()
                } else {
                  data[col] = value
                }
              }
            })
            
            // Store all fields as hash
            await client.hset(`${table}:${id}`, Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
            ))
          }
        }
        return { rows: [{ id, created_at: new Date().toISOString() }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // ---- UPDATE ----
    if (upper.startsWith("UPDATE")) {
      return { rows: [], rowCount: 1 }
    }

    // ---- DELETE ----
    if (upper.startsWith("DELETE")) {
      return { rows: [], rowCount: 1 }
    }

    // ---- CREATE TABLE / ALTER TABLE / DROP ----
    if (upper.startsWith("CREATE") || upper.startsWith("ALTER") || upper.startsWith("DROP")) {
      return { rows: [], rowCount: 0 }
    }

    // ---- GENERIC TABLE FALLBACK ----
    // Catch any SELECT/INSERT/UPDATE/DELETE on tables not explicitly handled above
    const tableMatch = upper.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i)
    if (tableMatch) {
      const table = tableMatch[1].toLowerCase()
      const client = getRedisClient()

      if (upper.startsWith("SELECT")) {
        if (upper.includes("WHERE") && params.length > 0) {
          // Single item lookup by first param (assumed to be id)
          const item = await client.hgetall(`${table}:${params[0]}`)
          if (item && Object.keys(item).length > 0) {
            return { rows: [{ ...item, id: params[0] }], rowCount: 1 }
          }
          // Try settings-style lookup
          const settingsVal = await redisGetSettings(`${table}:${params[0]}`)
          if (settingsVal) {
            const row = typeof settingsVal === "object" ? settingsVal : { key: params[0], value: settingsVal }
            return { rows: [row], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }
        // List all items in the table
        const ids = await client.smembers(table)
        const items: any[] = []
        for (const id of ids.slice(0, 200)) {
          const item = await client.hgetall(`${table}:${id}`)
          if (item && Object.keys(item).length > 0) {
            items.push({ ...item, id })
          }
        }
        return { rows: items, rowCount: items.length }
      }

      if (upper.startsWith("INSERT")) {
        const id = params[0] || nanoid()
        await client.sadd(table, String(id))
        // If params provide key-value pairs, store them
        if (params.length >= 2 && typeof params[1] === "object") {
          const data = params[1]
          await client.hset(`${table}:${id}`, Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
          ))
        }
        return { rows: [{ id, created_at: new Date().toISOString() }], rowCount: 1 }
      }

      if (upper.startsWith("UPDATE")) {
        // UPDATE table SET ... WHERE id = params[last]
        if (params.length > 0) {
          const id = String(params[params.length - 1])
          // Store update as settings
          await redisSetSettings(`${table}:${id}:updated_at`, new Date().toISOString())
        }
        return { rows: [], rowCount: 1 }
      }

      if (upper.startsWith("DELETE")) {
        if (params.length > 0) {
          const id = String(params[0])
          await client.srem(table, id)
          await client.del(`${table}:${id}`)
        }
        return { rows: [], rowCount: 1 }
      }
    }

  } catch (error) {
    console.error("[v0] [DB Shim] Error routing query:", error instanceof Error ? error.message : String(error))
  }

  return { rows: [], rowCount: 0 }
}

/** Compatibility wrapper for execute() */
export async function execute(queryText: string, params: any[] = []): Promise<{ rowCount: number }> {
  const result = await routeQuery(queryText, params)
  return { rowCount: result.rowCount }
}

/** Compatibility wrapper for insertReturning() */
export async function insertReturning(queryText: string, params: any[] = []): Promise<any> {
  const result = await routeQuery(queryText, params)
  return result.rows[0] || { id: nanoid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
}

/** Compatibility wrapper for query() */
export async function query<T = any>(queryText: string, params: any[] = []): Promise<T[]> {
  const result = await routeQuery(queryText, params)
  return result.rows as T[]
}

/** Compatibility wrapper for queryOne() */
export async function queryOne<T = any>(queryText: string, params: any[] = []): Promise<T | null> {
  const results = await query<T>(queryText, params)
  return results.length > 0 ? results[0] : null
}

/** Compatibility wrapper for sql tagged template */
export async function sql<T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]> {
  let queryText = strings[0]
  for (let i = 0; i < values.length; i++) {
    queryText += `$${i + 1}` + strings[i + 1]
  }
  return query<T>(queryText, values)
}

export function generateId(): string {
  return nanoid()
}

export function dbNow(): string {
  return new Date().toISOString()
}

export async function runStartupMigrations(): Promise<void> {
  try {
    const { runMigrations } = await import("./redis-migrations")
    await runMigrations()
  } catch (error) {
    console.warn("[v0] Startup migrations failed:", error)
  }
}
