import { getRedisClient } from "./redis-db"
import { loadSettings } from "./settings-storage"

const dbOpsSecondWindow = {
  timestampMs: 0,
  count: 0,
}

/**
 * Helper: Check if database operation limit has been exceeded
 * Returns true if limit is enforced and exceeded, false otherwise
 */
async function shouldEnforceDatabaseLimit(): Promise<boolean> {
  const settings = loadSettings()
  const perSecondLimit = Number(settings.databaseLimitPerSecond ?? 0)
  const perMinuteLimit = Number(settings.databaseLimitPerMinute ?? 0)

  // Per-second limiter (in-memory, sliding by second)
  if (perSecondLimit > 0) {
    const now = Date.now()
    if (now - dbOpsSecondWindow.timestampMs >= 1000) {
      dbOpsSecondWindow.timestampMs = now
      dbOpsSecondWindow.count = 0
    }

    dbOpsSecondWindow.count += 1
    if (dbOpsSecondWindow.count > perSecondLimit) {
      console.warn(
        `[v0] [Database] Per-second limit exceeded: ${dbOpsSecondWindow.count}/${perSecondLimit} operations`,
      )
      return true
    }
  }

  // Per-minute limiter (Redis-backed tracker)
  if (perMinuteLimit > 0) {
    const client = getRedisClient()
    const status = await client.trackDatabaseOperation(perMinuteLimit)
    if (status.exceeded) {
      console.warn(
        `[v0] [Database] Per-minute limit exceeded: ${status.current}/${status.limit} operations`,
      )
      return true
    }
  }

  return false
}

// ========== Connections ==========
export const RedisConnections = {
  async createConnection(conn: any) {
    const client = getRedisClient()
    const key = `connection:${conn.id}`
    const data: Record<string, string> = {
      id: conn.id,
      name: conn.name,
      exchange: conn.exchange,
      api_key: conn.api_key || "",
      api_secret: conn.api_secret || "",
      is_enabled: conn.is_enabled ? "1" : "0",
      is_active: conn.is_active ? "1" : "0",
      created_at: new Date().toISOString(),
    }
    const args: string[] = []
    for (const [k, v] of Object.entries(data)) {
      args.push(k, v)
    }
    await client.hmset(key, ...args)
    // Use "connections" (consistent with redis-db.ts and migrations)
    await client.sadd("connections", conn.id)
    return conn
  },

  async getConnection(id: string) {
    const client = getRedisClient()
    const data = await client.hgetall(`connection:${id}`)
    return data && Object.keys(data).length > 0 ? data : null
  },

  async getAllConnections() {
    const client = getRedisClient()
    // Use "connections" (consistent with redis-db.ts and migrations)
    const ids = (await client.smembers("connections")) || []
    const connections = []
    for (const id of ids) {
      const conn = await this.getConnection(id)
      if (conn) connections.push(conn)
    }
    return connections
  },

  async updateConnection(id: string, updates: Record<string, any>) {
    const client = getRedisClient()
    const existing = await this.getConnection(id)
    if (!existing) throw new Error("Connection not found")
    
    const updated: Record<string, string> = { ...existing }
    for (const [k, v] of Object.entries(updates)) {
      updated[k] = String(v ?? "")
    }
    updated.updated_at = new Date().toISOString()
    
    const args: string[] = []
    for (const [k, v] of Object.entries(updated)) {
      args.push(k, v)
    }
    await client.hmset(`connection:${id}`, ...args)
    return updated
  },

  async deleteConnection(id: string) {
    const client = getRedisClient()
    await client.del(`connection:${id}`)
    // Use "connections" (consistent with redis-db.ts and migrations)
    await client.srem("connections", id)
    await client.srem("connections:active", id)
  },
}

// ========== Trades ==========
export const RedisTrades = {
  async createTrade(connId: string, trade: any) {
    // Check database limit before creating trade
    if (await shouldEnforceDatabaseLimit()) {
      console.warn(`[v0] [RedisTrades] Skipping trade creation due to per-minute database limit`)
      return null
    }

    const client = getRedisClient()
    const key = `trade:${trade.id}`
    await client.hset(key, trade)
    await client.expire(key, 2592000) // 30 day TTL for trade data
    await client.sadd(`trades:${connId}`, trade.id)
    await client.sadd("trades:all", trade.id)
    return trade
  },

  async getTrade(tradeId: string) {
    const client = getRedisClient()
    return await client.hgetall(`trade:${tradeId}`)
  },

  async getTradesByConnection(connId: string) {
    const client = getRedisClient()
    const tradeIds = (await client.smembers(`trades:${connId}`)) || []
    const trades = []
    for (const id of tradeIds) {
      const trade = await this.getTrade(id)
      if (trade) trades.push(trade)
    }
    return trades
  },
}

// ========== Positions ==========
export const RedisPositions = {
  async createPosition(connId: string, pos: any) {
    // Check database limit before creating position
    if (await shouldEnforceDatabaseLimit()) {
      console.warn(`[v0] [RedisPositions] Skipping position creation due to per-minute database limit`)
      return null
    }

    const client = getRedisClient()
    const key = `position:${pos.id}`
    await client.hset(key, pos)
    await client.expire(key, 2592000) // 30 day TTL for position data
    await client.sadd(`positions:${connId}`, pos.id)
    await client.sadd("positions:all", pos.id)
    return pos
  },

  async getPosition(posId: string) {
    const client = getRedisClient()
    return await client.hgetall(`position:${posId}`)
  },

  async getPositionsByConnection(connId: string) {
    const client = getRedisClient()
    const posIds = (await client.smembers(`positions:${connId}`)) || []
    const positions = []
    for (const id of posIds) {
      const pos = await this.getPosition(id)
      if (pos) positions.push(pos)
    }
    return positions
  },

  async updatePosition(id: string, updates: Record<string, any>) {
    const client = getRedisClient()
    const existing = await this.getPosition(id)
    if (!existing) throw new Error("Position not found")
    
    const updated: Record<string, string> = { ...existing }
    for (const [k, v] of Object.entries(updates)) {
      updated[k] = String(v ?? "")
    }
    
    await client.hset(`position:${id}`, updated)
    return updated
  },
}

// ========== Cache ==========
export const RedisCache = {
  async set(key: string, value: any, ttl?: number) {
    const client = getRedisClient()
    await client.set(`cache:${key}`, JSON.stringify(value))
    if (ttl) await client.expire(`cache:${key}`, ttl)
  },

  async get(key: string) {
    const client = getRedisClient()
    // Fixed: use cache: prefix to match set() method
    const data = await client.get(`cache:${key}`)
    return data ? JSON.parse(data) : null
  },

  async getAll() {
    const client = getRedisClient()
    // Fixed: use cache: prefix
    const keys = await client.keys("cache:*")
    const settings: Record<string, any> = {}
    for (const key of keys) {
      const settingKey = key.replace("cache:", "")
      const data = await client.get(key)
      if (data) {
        try {
          settings[settingKey] = JSON.parse(data)
        } catch {
          settings[settingKey] = data
        }
      }
    }
    return settings
  },
}

// ========== Settings ==========
export const RedisSettings = {
  async set(key: string, value: any) {
    const client = getRedisClient()
    await client.set(`settings:${key}`, JSON.stringify(value))
  },

  async get(key: string) {
    const client = getRedisClient()
    const data = await client.get(`settings:${key}`)
    return data ? JSON.parse(data) : null
  },

  async getAll() {
    const client = getRedisClient()
    const keys = await client.keys("settings:*")
    const settings: Record<string, any> = {}
    for (const key of keys) {
      const settingKey = key.replace("settings:", "")
      const data = await client.get(key)
      if (data) {
        try {
          settings[settingKey] = JSON.parse(data)
        } catch {
          settings[settingKey] = data
        }
      }
    }
    return settings
  },
}

// ========== Monitoring ==========
export const RedisMonitoring = {
  async recordEvent(eventType: string, eventData?: any) {
    const client = getRedisClient()
    const eventId = `event:${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const data: Record<string, string> = {
      type: eventType,
      timestamp: new Date().toISOString(),
    }
    if (eventData && typeof eventData === "object") {
      for (const [k, v] of Object.entries(eventData)) {
        data[k] = String(v ?? "")
      }
    }
    const args: string[] = []
    for (const [k, v] of Object.entries(data)) {
      args.push(k, v)
    }
    await client.hmset(eventId, ...args)
    // Use bounded list instead of unbounded set for monitoring events
    await client.lpush("monitoring:events:list", eventId)
    await client.ltrim("monitoring:events:list", 0, 4999) // Keep max 5000 events
    await client.expire(eventId, 2592000) // 30 days
  },

  async getStatistics() {
    const client = getRedisClient()
    const [connectionsCount, tradesCount, positionsCount] = await Promise.all([
      client.scard("connections:all").catch(() => 0),
      client.scard("trades:all").catch(() => 0),
      client.scard("positions:all").catch(() => 0),
    ])
    return {
      connections: connectionsCount,
      trades: tradesCount,
      positions: positionsCount,
      timestamp: Date.now(),
    }
  },
}

// ========== Backup ==========
export const RedisBackup = {
  async createSnapshot(name: string) {
    const client = getRedisClient()
    const snapshotId = `snapshot:${Date.now()}`
    await client.hset(snapshotId, {
      id: snapshotId,
      name,
      created_at: new Date().toISOString(),
      status: "completed",
    })
    await client.lpush("snapshots:all:list", snapshotId)
    await client.ltrim("snapshots:all:list", 0, 99) // Keep max 100 snapshots
    return snapshotId
  },

  async listSnapshots() {
    const client = getRedisClient()
    // Read from bounded list with fallback to legacy set
    let snapshotIds = await client.lrange("snapshots:all:list", 0, -1).catch(() => [] as string[])
    if (!snapshotIds || snapshotIds.length === 0) {
      snapshotIds = await client.smembers("snapshots:all").catch(() => [] as string[])
    }
    const snapshots = []
    for (const id of snapshotIds) {
      const snapshot = await client.hgetall(id)
      if (snapshot) snapshots.push(snapshot)
    }
    return snapshots
  },
}
