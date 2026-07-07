import { initRedis, getRedisClient } from "@/lib/redis-db"

interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Max requests per window
  timeoutMs?: number // Request timeout in milliseconds
  keyPrefix: string // Redis key prefix
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetTime: number
  retryAfter?: number
  timeoutMs?: number
}

/**
 * Systemwide rate limiter with timeout management for connection requests
 * Uses Redis for distributed rate limiting across multiple servers
 * Integrated with timeout handling to prevent hanging requests
 */
export class ConnectionRateLimiter {
  private config: RateLimitConfig

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      windowMs: config.windowMs || 60 * 1000, // 1 minute default
      maxRequests: config.maxRequests || 30, // 30 requests per window
      timeoutMs: config.timeoutMs || 30000, // 30 second timeout
      keyPrefix: config.keyPrefix || "rate_limit:connection:",
    }
  }

  /**
   * Check if a connection request should be rate limited
   * @param connectionId - The connection identifier
   * @returns Rate limit result with allowed status and remaining requests
   */
  async checkLimit(connectionId: string): Promise<RateLimitResult> {
    try {
      await initRedis()
      const client = getRedisClient()

      if (!client) {
        // If Redis not available, allow the request with timeout info
        console.warn("[v0] [RateLimit] Redis client unavailable, allowing request")
        return {
          allowed: true,
          remaining: this.config.maxRequests,
          resetTime: Date.now() + this.config.windowMs,
          timeoutMs: this.config.timeoutMs,
        }
      }

      const key = `${this.config.keyPrefix}${connectionId}`
      const now = Date.now()

      // Get current window start time from Redis
      const windowStartStr = await client.get(`${key}:window`)
      const windowStart = windowStartStr ? Number.parseInt(windowStartStr, 10) : now

      // Check if window has expired
      if (now - windowStart > this.config.windowMs) {
        // Reset: new window
        await client.set(`${key}:window`, now.toString())
        await client.set(`${key}:count`, "1")
        await client.expire(key, Math.ceil(this.config.windowMs / 1000))
        await client.expire(`${key}:window`, Math.ceil(this.config.windowMs / 1000))
        await client.expire(`${key}:count`, Math.ceil(this.config.windowMs / 1000))

        return {
          allowed: true,
          remaining: this.config.maxRequests - 1,
          resetTime: now + this.config.windowMs,
        }
      }

      // Increment counter for current window
      const countStr = await client.get(`${key}:count`)
      const count = countStr ? Number.parseInt(countStr, 10) : 0
      const newCount = count + 1

      if (newCount > this.config.maxRequests) {
        // Rate limit exceeded
        const resetTime = windowStart + this.config.windowMs
        const retryAfter = Math.ceil((resetTime - now) / 1000)

        return {
          allowed: false,
          remaining: 0,
          resetTime,
          retryAfter,
          timeoutMs: this.config.timeoutMs,
        }
      }

      // Update counter
      await client.set(`${key}:count`, newCount.toString())

      return {
        allowed: true,
        remaining: this.config.maxRequests - newCount,
        resetTime: windowStart + this.config.windowMs,
        timeoutMs: this.config.timeoutMs,
      }
    } catch (error) {
      console.error("[v0] [RateLimit] Error checking limit:", error)
      // On error, allow the request (fail open)
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: Date.now() + this.config.windowMs,
        timeoutMs: this.config.timeoutMs,
      }
    }
  }

  /**
   * Reset rate limit for a connection (admin only)
   */
  async resetLimit(connectionId: string): Promise<boolean> {
    try {
      await initRedis()
      const client = getRedisClient()

      if (!client) {
        return false
      }

      const key = `${this.config.keyPrefix}${connectionId}`
      await client.del(key)
      await client.del(`${key}:window`)
      await client.del(`${key}:count`)

      console.log(`[v0] [RateLimit] Reset limit for ${connectionId}`)
      return true
    } catch (error) {
      console.error("[v0] [RateLimit] Error resetting limit:", error)
      return false
    }
  }

  /**
   * Get current rate limit status for a connection
   */
  async getStatus(connectionId: string): Promise<RateLimitResult | null> {
    try {
      await initRedis()
      const client = getRedisClient()

      if (!client) {
        return null
      }

      const key = `${this.config.keyPrefix}${connectionId}`
      const windowStartStr = await client.get(`${key}:window`)
      const countStr = await client.get(`${key}:count`)

      if (!windowStartStr) {
        return null // No rate limit record
      }

      const windowStart = Number.parseInt(windowStartStr, 10)
      const count = countStr ? Number.parseInt(countStr, 10) : 0
      const now = Date.now()
      const resetTime = windowStart + this.config.windowMs

      return {
        allowed: count < this.config.maxRequests,
        remaining: Math.max(0, this.config.maxRequests - count),
        resetTime,
      }
    } catch (error) {
      console.error("[v0] [RateLimit] Error getting status:", error)
      return null
    }
  }
}

// Global rate limiters for different connection request types
export const testConnectionLimiter = new ConnectionRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 50, // 50 test requests per minute (increased from 10)
  timeoutMs: 30000, // 30 second timeout
  keyPrefix: "rate_limit:test:",
})

export const toggleConnectionLimiter = new ConnectionRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30, // 30 toggle requests per minute
  timeoutMs: 30000,
  keyPrefix: "rate_limit:toggle:",
})

export const fetchDataLimiter = new ConnectionRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 20, // 20 data fetch requests per minute
  timeoutMs: 30000,
  keyPrefix: "rate_limit:fetch:",
})

export const generalLimiter = new ConnectionRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60, // 60 general requests per minute
  timeoutMs: 30000,
  keyPrefix: "rate_limit:general:",
})
