/**
 * Global Rate Limiter
 * 
 * Implements token bucket algorithm for system-wide rate limiting
 * Prevents overwhelming external services and protects system resources
 */

export interface RateLimitConfig {
  maxRequestsPerSecond?: number
  maxRequestsPerMinute?: number
  maxRequestsPerHour?: number
  perUser?: boolean
  perIp?: boolean
  burst?: number // Allow burst above steady rate
}

export interface RateLimitResult {
  allowed: boolean
  current: number
  limit: number
  retryAfterMs?: number
  remaining: number
}

interface RateLimitBucket {
  tokens: number
  lastRefillTime: number
  requestCount: number
}

/**
 * Token bucket rate limiter
 */
export class TokenBucketRateLimiter {
  private buckets = new Map<string, RateLimitBucket>()
  private readonly maxTokens: number
  private readonly refillRatePerSec: number
  private readonly burst: number
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    maxRequestsPerSecond: number = 100,
    burst: number = maxRequestsPerSecond * 2
  ) {
    this.maxTokens = maxRequestsPerSecond
    this.refillRatePerSec = maxRequestsPerSecond
    this.burst = burst

    // Start cleanup timer
    this.startCleanup()
  }

  /**
   * Check if request is allowed
   */
  checkLimit(key: string = 'global'): RateLimitResult {
    let bucket = this.buckets.get(key)

    // Create bucket if doesn't exist
    if (!bucket) {
      bucket = {
        tokens: this.maxTokens,
        lastRefillTime: Date.now(),
        requestCount: 0
      }
      this.buckets.set(key, bucket)
    }

    // Refill tokens based on time elapsed
    const now = Date.now()
    const elapsedSeconds = (now - bucket.lastRefillTime) / 1000
    const tokensToAdd = elapsedSeconds * this.refillRatePerSec

    bucket.tokens = Math.min(this.burst, bucket.tokens + tokensToAdd)
    bucket.lastRefillTime = now

    // Check if token available
    const allowed = bucket.tokens >= 1

    if (allowed) {
      bucket.tokens -= 1
      bucket.requestCount++

      return {
        allowed: true,
        current: Math.floor(bucket.tokens),
        limit: this.maxTokens,
        remaining: Math.floor(bucket.tokens)
      }
    } else {
      // Calculate when next token will be available
      const tokensNeeded = 1 - bucket.tokens
      const retryAfterMs = Math.ceil((tokensNeeded / this.refillRatePerSec) * 1000)

      return {
        allowed: false,
        current: Math.floor(bucket.tokens),
        limit: this.maxTokens,
        retryAfterMs,
        remaining: 0
      }
    }
  }

  /**
   * Wait for rate limit to allow request (blocking).
   *
   * Bounded by `maxWaitMs` (default 30 s) so a misconfigured bucket
   * (retryAfterMs always positive, tokens never refilling due to a
   * clock skew, etc.) can never hang the caller indefinitely. If the
   * deadline is exceeded, resolves without enforcing the limit and
   * emits a warning — the caller continues but the operator gets a
   * signal that something is wrong with the rate limiter.
   */
  async waitForLimit(key: string = 'global', maxWaitMs: number = 30_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    // Bound per-iteration sleep so we can't overshoot the deadline by
    // a ridiculous amount on a large retryAfterMs.
    while (Date.now() < deadline) {
      const result = this.checkLimit(key)
      if (result.allowed) {
        return
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const sleepFor = Math.min(remaining, result.retryAfterMs || 100)
      await new Promise(resolve => setTimeout(resolve, sleepFor))
    }
    console.warn(`[v0] [global-rate-limiter] waitForLimit('${key}') exceeded ${maxWaitMs}ms deadline; releasing without enforcement`)
  }

  /**
   * Get bucket stats
   */
  getStats(key: string = 'global'): RateLimitBucket | undefined {
    return this.buckets.get(key)
  }

  /**
   * Reset bucket
   */
  resetBucket(key: string = 'global'): void {
    this.buckets.delete(key)
  }

  /**
   * Get all buckets
   */
  getAllBuckets(): Map<string, RateLimitBucket> {
    return new Map(this.buckets)
  }

  /**
   * Start cleanup timer to remove stale buckets
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      const maxAge = 5 * 60 * 1000 // 5 minutes

      for (const [key, bucket] of this.buckets.entries()) {
        if (now - bucket.lastRefillTime > maxAge) {
          this.buckets.delete(key)
        }
      }
    }, 60000) // Run cleanup every minute

    this.cleanupInterval.unref() // Don't keep process alive
  }

  /**
   * Stop cleanup timer
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  /**
   * Destroy rate limiter
   */
  destroy(): void {
    this.stopCleanup()
    this.buckets.clear()
  }
}

/**
 * Sliding window rate limiter (for minute/hour limits)
 */
export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>()
  private readonly windowSize: number
  private readonly maxRequests: number

  constructor(windowSizeMs: number = 60000, maxRequests: number = 1000) {
    this.windowSize = windowSizeMs
    this.maxRequests = maxRequests
  }

  /**
   * Check if request is allowed
   */
  checkLimit(key: string = 'global'): RateLimitResult {
    const now = Date.now()
    const windowStart = now - this.windowSize

    let window = this.windows.get(key)

    // Create window if doesn't exist
    if (!window) {
      window = []
      this.windows.set(key, window)
    }

    // Remove old requests outside window
    window = window.filter(time => time > windowStart)
    this.windows.set(key, window)

    const current = window.length
    const allowed = current < this.maxRequests

    if (allowed) {
      window.push(now)
    }

    let retryAfterMs: number | undefined
    if (!allowed && window.length > 0) {
      // Retry after oldest request exits window
      retryAfterMs = window[0] + this.windowSize - now + 1000
    }

    return {
      allowed,
      current,
      limit: this.maxRequests,
      retryAfterMs,
      remaining: Math.max(0, this.maxRequests - current)
    }
  }

  /**
   * Reset window
   */
  resetWindow(key: string = 'global'): void {
    this.windows.delete(key)
  }

  /**
   * Get all windows
   */
  getAllWindows(): Map<string, number[]> {
    return new Map(this.windows)
  }
}

/**
 * Composite rate limiter
 * Combines multiple rate limit strategies
 */
export class CompositeRateLimiter {
  private limiters: Map<string, TokenBucketRateLimiter | SlidingWindowRateLimiter> = new Map()

  addLimiter(name: string, limiter: TokenBucketRateLimiter | SlidingWindowRateLimiter): void {
    this.limiters.set(name, limiter)
  }

  /**
   * Check all limits
   */
  checkAllLimits(key: string = 'global'): {
    allowed: boolean
    results: { [name: string]: RateLimitResult }
  } {
    const results: { [name: string]: RateLimitResult } = {}
    let allowed = true

    for (const [name, limiter] of this.limiters) {
      const result = limiter.checkLimit(key)
      results[name] = result
      if (!result.allowed) {
        allowed = false
      }
    }

    return { allowed, results }
  }

  /**
   * Get max retry time across all limiters
   */
  getMaxRetryAfter(key: string = 'global'): number | undefined {
    let maxRetry: number | undefined

    for (const limiter of this.limiters.values()) {
      const result = limiter.checkLimit(key)
      if (!result.allowed && result.retryAfterMs) {
        if (!maxRetry || result.retryAfterMs > maxRetry) {
          maxRetry = result.retryAfterMs
        }
      }
    }

    return maxRetry
  }
}

/**
 * Global rate limiter instance
 */
export class GlobalRateLimiter {
  private secondLimiter: TokenBucketRateLimiter
  private minuteLimiter: SlidingWindowRateLimiter
  private hourLimiter: SlidingWindowRateLimiter
  private compositeLimiter: CompositeRateLimiter

  constructor(config: RateLimitConfig = {}) {
    const {
      maxRequestsPerSecond = 1000,
      maxRequestsPerMinute = 50000,
      maxRequestsPerHour = 500000
    } = config

    // Initialize limiters
    this.secondLimiter = new TokenBucketRateLimiter(
      maxRequestsPerSecond,
      maxRequestsPerSecond * 2
    )

    this.minuteLimiter = new SlidingWindowRateLimiter(60000, maxRequestsPerMinute)
    this.hourLimiter = new SlidingWindowRateLimiter(3600000, maxRequestsPerHour)

    // Composite limiter checks all
    this.compositeLimiter = new CompositeRateLimiter()
    this.compositeLimiter.addLimiter('second', this.secondLimiter)
    this.compositeLimiter.addLimiter('minute', this.minuteLimiter)
    this.compositeLimiter.addLimiter('hour', this.hourLimiter)

    console.log(
      '[RATE_LIMIT] Global limiter initialized: ' +
      `${maxRequestsPerSecond}/s, ${maxRequestsPerMinute}/min, ${maxRequestsPerHour}/h`
    )
  }

  /**
   * Check if request is allowed across all limits
   */
  checkLimit(key: string = 'global'): RateLimitResult {
    const { allowed, results } = this.compositeLimiter.checkAllLimits(key)

    // Find the most restrictive limit
    let result: RateLimitResult | undefined
    const retryAfter = this.compositeLimiter.getMaxRetryAfter(key)

    for (const r of Object.values(results)) {
      if (!r.allowed) {
        result = r
        break
      }
    }

    if (!result) {
      result = results['second']
    }

    return {
      ...result,
      allowed,
      retryAfterMs: retryAfter
    }
  }

  /**
   * Wait for rate limit.
   *
   * Bounded by `maxWaitMs` for the same reason as the sibling class's
   * `waitForLimit` — no caller should be hangable-forever by a
   * pathological bucket state.
   */
  async waitForLimit(key: string = 'global', maxWaitMs: number = 60_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      const result = this.checkLimit(key)
      if (result.allowed) {
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const sleepFor = Math.min(remaining, result.retryAfterMs || 1000)
      await new Promise(resolve => setTimeout(resolve, sleepFor))
    }
    console.warn(`[v0] [exchange-rate-limiter] waitForLimit('${key}') exceeded ${maxWaitMs}ms deadline; releasing without enforcement`)
  }

  /**
   * Get detailed status
   */
  getStatus(key: string = 'global'): {
    allowed: boolean
    second: RateLimitResult
    minute: RateLimitResult
    hour: RateLimitResult
  } {
    return {
      allowed: this.checkLimit(key).allowed,
      second: this.secondLimiter.checkLimit(key),
      minute: this.minuteLimiter.checkLimit(key),
      hour: this.hourLimiter.checkLimit(key)
    }
  }

  /**
   * Reset all limits for a key
   */
  resetKey(key: string = 'global'): void {
    this.secondLimiter.resetBucket(key)
    this.minuteLimiter.resetWindow(key)
    this.hourLimiter.resetWindow(key)
  }

  /**
   * Destroy limiter
   */
  destroy(): void {
    this.secondLimiter.destroy()
  }
}

/**
 * Next.js API route middleware for rate limiting
 */
export function withRateLimit(
  handler: (req: any, res: any) => Promise<void>,
  limiter: GlobalRateLimiter,
  keyFn?: (req: any) => string
) {
  return async (req: any, res: any) => {
    const key = keyFn ? keyFn(req) : req.ip || 'unknown'
    const result = limiter.checkLimit(key)

    // Add rate limit headers
    res.setHeader('x-rate-limit-limit', result.limit)
    res.setHeader('x-rate-limit-remaining', result.remaining)

    if (!result.allowed) {
      res.setHeader('x-rate-limit-reset', new Date(Date.now() + (result.retryAfterMs || 0)).toISOString())
      res.setHeader('retry-after', Math.ceil((result.retryAfterMs || 0) / 1000))

      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: result.retryAfterMs
      })
    }

    await handler(req, res)
  }
}

// Export singleton instance
export const globalRateLimiter = new GlobalRateLimiter()

export default GlobalRateLimiter
