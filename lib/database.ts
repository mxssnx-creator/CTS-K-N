/**
 * Database Module - Redis Primary Database
 * Redis is the ONLY database. SQLite and PostgreSQL are completely removed.
 */

export { 
  getRedisClient, 
  initRedis,
  getConnection,
  getAllConnections,
  saveConnection,
  deleteConnection,
  getTrade,
  getAllTrades,
  saveTrade,
  getPosition,
  getAllPositions,
  savePosition,
  deletePosition,
  setSettings,
  getSettings,
  isRedisConnected,
} from "./redis-db"

export { 
  runMigrations,
  rollbackMigration,
  getMigrationStatus
} from "./redis-migrations"

export {
  getActiveIndications,
  getBestPerformingIndications,
  getRecentIndications,
  getActiveStrategies,
  getBestPerformingStrategies,
  getStrategyStatistics,
  getAllIndicationPerformance,
  getAllStrategyPerformance,
  getDailyPerformanceSummary,
  getRedisHelpers
} from "./db-helpers"

import { getRedisClient, initRedis as initRedisDb } from "./redis-db"
import { nanoid } from "nanoid"

/**
 * Get database type - Always Redis
 */
export function getDatabaseType(): string {
  return "redis"
}

/**
 * Compatibility layer for legacy calls - all operations use Redis
 */
export async function getClient(): Promise<any> {
  const { getRedisClient } = await import("./redis-db")
  return getRedisClient()
}

/**
 * SQL-to-Redis routing shim -- delegates to @/lib/db which has full SQL parsing
 */
export { execute, query, queryOne } from "./db"

/**
 * Connection management - Redis backed
 */
export async function addConnection(name: string, exchange: string, apiKey: string, apiSecret: string) {
  const { createConnection } = await import("./redis-db")
  return createConnection({
    id: nanoid(),
    name,
    exchange,
    api_key: apiKey,
    api_secret: apiSecret,
    is_enabled: false,
    is_active: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any)
}

/**
 * Initialize database - Redis only
 */
export async function initializeDatabase() {
  try {
    // initRedisDb includes the complete migration barrier.
    await initRedisDb()
    console.log("[v0] Database initialized with Redis")
    return true
  } catch (error) {
    console.error("[v0] Database initialization error:", error)
    return false
  }
}

/**
 * Compatibility class `DatabaseManager` - wraps Redis operations
 * Used by: import DatabaseManager from "@/lib/database"
 * Supports both static and instance-level getInstance()
 */
class DatabaseManagerClass {
  static instance: DatabaseManagerClass | null = null

  static getInstance(): DatabaseManagerClass {
    if (!DatabaseManagerClass.instance) {
      DatabaseManagerClass.instance = new DatabaseManagerClass()
    }
    return DatabaseManagerClass.instance
  }

  // Instance method so callers can do DatabaseManager.getInstance() on the exported instance
  getInstance(): DatabaseManagerClass {
    return this
  }

  async query<T = any>(sqlStr: string, params: any[] = []): Promise<T[]> {
    const { query: dbQuery } = await import("./db")
    return dbQuery<T>(sqlStr, params)
  }

  async queryOne<T = any>(sqlStr: string, params: any[] = []): Promise<T | null> {
    const { queryOne: dbQueryOne } = await import("./db")
    return dbQueryOne<T>(sqlStr, params)
  }

  async execute(sqlStr: string, params: any[] = []): Promise<{ rowCount: number }> {
    const { execute: dbExecute } = await import("./db")
    return dbExecute(sqlStr, params)
  }

  async all(sqlStr: string, params: any[] = []) {
    return this.query(sqlStr, params)
  }

  async get(sqlStr: string, params: any[] = []) {
    return this.queryOne(sqlStr, params)
  }

  async run(sqlStr: string, params: any[] = []) {
    return this.execute(sqlStr, params)
  }

  getDatabaseType(): string {
    return "redis"
  }

  async initialize() {
    return initializeDatabase()
  }

  // CRUD methods for entity-based storage via Redis
  async insert(entityType: string, subType: string, data: any): Promise<any> {
    const { getRedisClient } = await import("./redis-db")
    const client = getRedisClient()
    const id = data.id || `${entityType}:${subType}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    const record = { ...data, id, entity_type: entityType, sub_type: subType, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    const key = `entity:${entityType}:${subType}:${id}`
    await client.hset(key, Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])))
    await client.sadd(`entities:${entityType}:${subType}`, id)
    return record
  }

  async getAll(entityType: string, subType: string): Promise<any[]> {
    const { getRedisClient } = await import("./redis-db")
    const client = getRedisClient()
    const ids = await client.smembers(`entities:${entityType}:${subType}`)
    if (ids.length === 0) return []
    const results = await Promise.all(ids.map(async (id: string) => {
      const data = await client.hgetall(`entity:${entityType}:${subType}:${id}`)
      return data && Object.keys(data).length > 0 ? data : null
    }))
    return results.filter(Boolean)
  }

  async getById(entityType: string, subType: string, id: string): Promise<any | null> {
    const { getRedisClient } = await import("./redis-db")
    const client = getRedisClient()
    const data = await client.hgetall(`entity:${entityType}:${subType}:${id}`)
    return data && Object.keys(data).length > 0 ? data : null
  }

  async find(entityType: string, subType: string, filter: Record<string, any>): Promise<any[]> {
    const all = await this.getAll(entityType, subType)
    return all.filter((item: any) => Object.entries(filter).every(([k, v]) => item[k] === String(v)))
  }

  async update(entityType: string, subType: string, id: string, data: any): Promise<any> {
    const { getRedisClient } = await import("./redis-db")
    const client = getRedisClient()
    const key = `entity:${entityType}:${subType}:${id}`
    const record = { ...data, updated_at: new Date().toISOString() }
    await client.hset(key, Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])))
    return record
  }

  async delete(entityType: string, subType: string, id: string): Promise<void> {
    const { getRedisClient } = await import("./redis-db")
    const client = getRedisClient()
    await client.srem(`entities:${entityType}:${subType}`, id)
    await client.del(`entity:${entityType}:${subType}:${id}`)
  }

  // Position methods
  async getPseudoPositions(_connectionId?: string, _limit?: number): Promise<any[]> {
    return this.getAll("positions", "pseudo")
  }

  async getRealPositions(_connectionId?: string): Promise<any[]> {
    return this.getAll("positions", "real")
  }

  async getPositionStats(_connectionId?: string): Promise<any> {
    const pseudo = await this.getPseudoPositions(_connectionId)
    const real = await this.getRealPositions(_connectionId)
    return { pseudoCount: pseudo.length, realCount: real.length, total: pseudo.length + real.length }
  }

  async getGlobalPositionStats(): Promise<any> {
    return this.getPositionStats()
  }

  // Error methods
  async getErrors(_limit?: number, _resolved?: boolean): Promise<any[]> {
    return this.getAll("monitoring", "errors")
  }

  async resolveError(id: string): Promise<void> {
    await this.update("monitoring", "errors", id, { resolved: "true", resolved_at: new Date().toISOString() })
  }

  async clearOldErrors(_days?: number): Promise<void> {
    // No-op for Redis - errors auto-expire via TTL
  }

  // Log methods
  async getLogs(_limit?: number): Promise<any[]> {
    return this.getAll("monitoring", "logs")
  }

  async insertLog(level: string, category: string, message: string, details?: string): Promise<void> {
    await this.insert("monitoring", "logs", { level, category, message, details: details || "" })
  }

  async insertError(name: string, message: string, stack?: string, context?: string): Promise<void> {
    await this.insert("monitoring", "errors", { name, message, stack: stack || "", context: context || "", resolved: "false" })
  }

  async executeQuery(sqlStr: string, params: any[] = []): Promise<{ rowCount: number }> {
    return this.execute(sqlStr, params)
  }

  // Connection methods
  async getConnections(): Promise<any[]> {
    const { getAllConnections } = await import("./redis-db")
    return getAllConnections()
  }

  // Settings methods
  async getSetting(key: string): Promise<any> {
    const { getSettings } = await import("./redis-db")
    return getSettings(key)
  }

  async setSetting(key: string, value: any): Promise<void> {
    const { setSettings } = await import("./redis-db")
    await setSettings(key, value)
  }
}

const DatabaseManager = DatabaseManagerClass.getInstance()
export default DatabaseManager

/**
 * Named export `db` - same instance as DatabaseManager
 * Used by: import { db } from "@/lib/database"
 */
export const db = DatabaseManager as any
