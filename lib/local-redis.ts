/**
 * Local Redis In-Memory Implementation
 * Replaces remote Upstash Redis with local storage
 * This is a production-grade in-memory database compatible with Redis operations
 */

interface RedisData {
  [key: string]: string | Set<string> | Record<string, string>
}

interface RedisExpiry {
  [key: string]: number // timestamp when key expires
}

class LocalRedis {
  private data: RedisData = {}
  private expiry: RedisExpiry = {}

  constructor() {
    // Cleanup on each access instead of timer (works in serverless)
  }

  private cleanupExpiredIfNeeded() {
    const now = Date.now()
    for (const key in this.expiry) {
      if (this.expiry[key] < now) {
        delete this.data[key]
        delete this.expiry[key]
      }
    }
  }

  private isExpired(key: string): boolean {
    if (key in this.expiry) {
      if (this.expiry[key] < Date.now()) {
        delete this.data[key]
        delete this.expiry[key]
        return true
      }
    }
    return false
  }

  // String operations
  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const value = this.data[key]
    return typeof value === "string" ? value : null
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<"OK"> {
    this.data[key] = value
    if (options?.ex) {
      this.expiry[key] = Date.now() + options.ex * 1000
    } else {
      delete this.expiry[key]
    }
    return "OK"
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => {
      if (this.isExpired(key)) return null
      const value = this.data[key]
      return typeof value === "string" ? value : null
    })
  }

  async mset(...args: string[]): Promise<"OK"> {
    for (let i = 0; i < args.length; i += 2) {
      this.data[args[i]] = args[i + 1]
      delete this.expiry[args[i]]
    }
    return "OK"
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      if (key in this.data) {
        delete this.data[key]
        delete this.expiry[key]
        count++
      }
    }
    return count
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      if (!this.isExpired(key) && key in this.data) {
        count++
      }
    }
    return count
  }

  // Hash operations
  // Supports both: hset(key, field, value) and hset(key, {field: value, ...})
  async hset(key: string, fieldOrObject: string | Record<string, any>, value?: string): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = {}
    }
    if (!(key in this.data) || typeof this.data[key] !== "object" || this.data[key] instanceof Set) {
      this.data[key] = {}
    }
    const hash = this.data[key] as Record<string, string>
    
    if (typeof fieldOrObject === "object") {
      // hset(key, { field1: val1, field2: val2 })
      let count = 0
      for (const [f, v] of Object.entries(fieldOrObject)) {
        const isNew = !(f in hash)
        hash[f] = String(v ?? "")
        if (isNew) count++
      }
      return count
    } else {
      // hset(key, field, value)
      const isNew = !(fieldOrObject in hash)
      hash[fieldOrObject] = String(value ?? "")
      return isNew ? 1 : 0
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const value = this.data[key]
    if (typeof value === "object" && !(value instanceof Set)) {
      return (value[field] as string) || null
    }
    return null
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.isExpired(key)) return {}
    const value = this.data[key]
    if (typeof value === "object" && !(value instanceof Set)) {
      return { ...value }
    }
    return {}
  }

  async hmset(key: string, ...args: string[]): Promise<"OK"> {
    if (this.isExpired(key)) {
      this.data[key] = {}
    }
    if (!(key in this.data) || typeof this.data[key] !== "object" || this.data[key] instanceof Set) {
      this.data[key] = {}
    }
    const hash = this.data[key] as Record<string, string>
    for (let i = 0; i < args.length; i += 2) {
      hash[args[i]] = args[i + 1]
    }
    return "OK"
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (typeof value === "object" && !(value instanceof Set)) {
      const hash = value as Record<string, string>
      let count = 0
      for (const field of fields) {
        if (field in hash) {
          delete hash[field]
          count++
        }
      }
      return count
    }
    return 0
  }

  async hexists(key: string, field: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (typeof value === "object" && !(value instanceof Set)) {
      return field in value ? 1 : 0
    }
    return 0
  }

  async hlen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (typeof value === "object" && !(value instanceof Set)) {
      return Object.keys(value).length
    }
    return 0
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = new Set()
    }
    if (!(key in this.data) || typeof this.data[key] === "string") {
      this.data[key] = new Set()
    }
    const set = this.data[key] as Set<string>
    let count = 0
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member)
        count++
      }
    }
    return count
  }

  async smembers(key: string): Promise<string[]> {
    if (this.isExpired(key)) return []
    const value = this.data[key]
    if (value instanceof Set) {
      return Array.from(value)
    }
    return []
  }

  async sismember(key: string, member: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (value instanceof Set) {
      return value.has(member) ? 1 : 0
    }
    return 0
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (value instanceof Set) {
      let count = 0
      for (const member of members) {
        if (value.has(member)) {
          value.delete(member)
          count++
        }
      }
      return count
    }
    return 0
  }

  async scard(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (value instanceof Set) {
      return value.size
    }
    return 0
  }

  // List operations
  async lpush(key: string, ...values: string[]): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = JSON.stringify([])
    }
    if (!(key in this.data) || typeof this.data[key] === "string") {
      const arr = typeof this.data[key] === "string" ? JSON.parse(this.data[key]) : []
      this.data[key] = JSON.stringify([...values, ...arr])
    }
    return values.length
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = JSON.stringify([])
    }
    if (!(key in this.data) || typeof this.data[key] === "string") {
      const arr = typeof this.data[key] === "string" ? JSON.parse(this.data[key]) : []
      this.data[key] = JSON.stringify([...arr, ...values])
    }
    return values.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return []
    const value = this.data[key]
    if (typeof value === "string") {
      try {
        const arr = JSON.parse(value)
        return arr.slice(start, stop + 1)
      } catch {
        return []
      }
    }
    return []
  }

  async llen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const value = this.data[key]
    if (typeof value === "string") {
      try {
        const arr = JSON.parse(value)
        return arr.length
      } catch {
        return 0
      }
    }
    return 0
  }

  /**
   * Redis LREM semantics — see `redis-db.ts` for full docs. Added so the
   * live-stage.savePosition() path (moves position ids between open and
   * closed index lists) works on whichever adapter the runtime picks.
   */
  async lrem(key: string, count: number, value: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const raw = this.data[key]
    if (typeof raw !== "string") return 0
    let arr: string[]
    try {
      arr = JSON.parse(raw)
    } catch {
      return 0
    }
    if (!Array.isArray(arr) || arr.length === 0) return 0

    let removed = 0
    const wantAll = count === 0
    const target = Math.abs(count)
    if (count >= 0) {
      for (let i = 0; i < arr.length; ) {
        if (arr[i] === value && (wantAll || removed < target)) {
          arr.splice(i, 1)
          removed++
        } else {
          i++
        }
      }
    } else {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === value && (wantAll || removed < target)) {
          arr.splice(i, 1)
          removed++
        }
      }
    }
    this.data[key] = JSON.stringify(arr)
    return removed
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    if (this.isExpired(key)) return
    const raw = this.data[key]
    if (typeof raw !== "string") return
    try {
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      const len = arr.length
      const normStart = start < 0 ? Math.max(0, len + start) : start
      const normStop = stop < 0 ? len + stop : stop
      this.data[key] = JSON.stringify(arr.slice(normStart, normStop + 1))
    } catch {
      /* ignore */
    }
  }

  async lpop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const raw = this.data[key]
    if (typeof raw !== "string") return null
    try {
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr) || arr.length === 0) return null
      const head = arr.shift()
      this.data[key] = JSON.stringify(arr)
      return head ?? null
    } catch {
      return null
    }
  }

  // Other operations
  async ping(): Promise<"PONG"> {
    return "PONG"
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`)
    const result: string[] = []
    for (const key in this.data) {
      if (!this.isExpired(key) && regex.test(key)) {
        result.push(key)
      }
    }
    return result
  }

  async flushdb(): Promise<"OK"> {
    this.data = {}
    this.expiry = {}
    return "OK"
  }

  async dbsize(): Promise<number> {
    let count = 0
    for (const key in this.data) {
      if (!this.isExpired(key)) {
        count++
      }
    }
    return count
  }

  async incr(key: string): Promise<number> {
    const current = parseInt((this.data[key] as string) || "0", 10)
    const newValue = current + 1
    this.data[key] = String(newValue)
    return newValue
  }

  async decr(key: string): Promise<number> {
    const current = parseInt((this.data[key] as string) || "0", 10)
    const newValue = current - 1
    this.data[key] = String(newValue)
    return newValue
  }

  async incrby(key: string, increment: number): Promise<number> {
    const current = parseInt((this.data[key] as string) || "0", 10)
    const newValue = current + increment
    this.data[key] = String(newValue)
    return newValue
  }

  async decrby(key: string, decrement: number): Promise<number> {
    const current = parseInt((this.data[key] as string) || "0", 10)
    const newValue = current - decrement
    this.data[key] = String(newValue)
    return newValue
  }

  // Hash increment helpers — mirror Redis HINCRBY/HINCRBYFLOAT behaviour
  async hincrby(key: string, field: string, increment: number): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = {}
    }
    if (!(key in this.data) || typeof this.data[key] === "string" || this.data[key] instanceof Set) {
      this.data[key] = {}
    }
    const hash = this.data[key] as Record<string, string>
    const current = parseInt(hash[field] || "0", 10) || 0
    const next = current + Math.floor(increment)
    hash[field] = String(next)
    return next
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<number> {
    if (this.isExpired(key)) {
      this.data[key] = {}
    }
    if (!(key in this.data) || typeof this.data[key] === "string" || this.data[key] instanceof Set) {
      this.data[key] = {}
    }
    const hash = this.data[key] as Record<string, string>
    const current = parseFloat(hash[field] || "0") || 0
    const next = current + increment
    // Preserve reasonable float precision
    hash[field] = String(Math.round(next * 100) / 100)
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (key in this.data && !this.isExpired(key)) {
      this.expiry[key] = Date.now() + seconds * 1000
      return 1
    }
    return 0
  }

  async ttl(key: string): Promise<number> {
    if (this.isExpired(key)) return -2
    if (!(key in this.expiry)) return -1
    const remaining = Math.ceil((this.expiry[key] - Date.now()) / 1000)
    return remaining > 0 ? remaining : -2
  }

  destroy() {
    this.data = {}
    this.expiry = {}
  }
}

// Global singleton instance
let localRedisInstance: LocalRedis | null = null

/** Get (or create) the local Redis singleton */
export async function getLocalRedis(): Promise<LocalRedis> {
  if (!localRedisInstance) {
    localRedisInstance = new LocalRedis()
  }
  return localRedisInstance
}

/** Destroy the local Redis instance */
export async function destroyLocalRedis(): Promise<void> {
  if (localRedisInstance) {
    localRedisInstance.destroy()
    localRedisInstance = null
  }
}
