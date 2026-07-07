/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures when external services are unavailable
 * Implements state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 */

export enum CircuitState {
  CLOSED = 'closed',        // Normal operation
  OPEN = 'open',            // Failing, reject requests
  HALF_OPEN = 'half-open'   // Testing recovery
}

export interface CircuitBreakerMetrics {
  state: CircuitState
  failureCount: number
  successCount: number
  totalRequests: number
  totalFailures: number
  totalSuccesses: number
  lastFailureTime?: Date
  openedAt?: Date
  lastStateChange: Date
}

export interface CircuitBreakerConfig {
  name: string
  failureThreshold?: number      // Failures before opening (default: 5)
  successThreshold?: number      // Successes before closing (default: 3)
  resetTimeoutMs?: number        // Time before half-open attempt (default: 60000)
  onStateChange?: (from: CircuitState, to: CircuitState) => void
  onMetrics?: (metrics: CircuitBreakerMetrics) => void
}

/**
 * Circuit Breaker for managing external API calls
 * 
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   name: 'exchange-api',
 *   failureThreshold: 5,
 *   resetTimeoutMs: 60000
 * })
 *
 * async function callExchangeAPI() {
 *   return breaker.execute(() => connector.getMarketData())
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED
  private failureCount = 0
  private successCount = 0
  private totalRequests = 0
  private totalFailures = 0
  private totalSuccesses = 0
  private lastFailureTime?: Date
  private openedAt?: Date
  private lastStateChange: Date = new Date()

  private readonly failureThreshold: number
  private readonly successThreshold: number
  private readonly resetTimeoutMs: number

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold ?? 5
    this.successThreshold = config.successThreshold ?? 3
    this.resetTimeoutMs = config.resetTimeoutMs ?? 60000

    // Store config for callback access
    ;(this as any).__config = config

    console.log(
      `[CB] Initialized ${config.name} ` +
      `(threshold: ${this.failureThreshold}, reset: ${this.resetTimeoutMs}ms)`
    )
  }

  /**
   * Execute operation with circuit breaker protection
   */
  async execute<T>(
    fn: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    // Check if circuit should transition to half-open
    this.maybeTransitionToHalfOpen()

    // Reject if circuit is open
    if (this.state === CircuitState.OPEN) {
      const config = (this as any).__config as CircuitBreakerConfig
      throw new Error(
        `[CB] Circuit breaker OPEN for ${config.name} - ` +
        `${this.failureCount} failures, ` +
        `retry in ${this.getRetryAfterMs()}ms`
      )
    }

    // Execute with error handling
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  /**
   * Execute with fallback value if circuit is open
   */
  async executeWithFallback<T>(
    fn: () => Promise<T>,
    fallback: T,
    operationName: string = 'operation'
  ): Promise<T> {
    try {
      return await this.execute(fn, operationName)
    } catch (error) {
      if (this.state === CircuitState.OPEN) {
        console.warn(
          `[CB] Using fallback for ${operationName} ` +
          `(circuit open, ${this.getRetryAfterMs()}ms until retry)`
        )
        return fallback
      }
      throw error
    }
  }

  /**
   * Execute batch operations with circuit breaker
   */
  async executeBatch<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    continueOnCircuitOpen: boolean = false
  ): Promise<R[]> {
    const results: R[] = []
    const errors: Error[] = []

    for (const item of items) {
      try {
        const result = await this.execute(() => fn(item))
        results.push(result)
      } catch (error) {
        if (this.state === CircuitState.OPEN && continueOnCircuitOpen) {
          console.warn(`[CB] Skipping item due to open circuit`)
          continue
        }
        errors.push(error as Error)
        if (!continueOnCircuitOpen) {
          throw error
        }
      }
    }

    if (errors.length > 0 && !continueOnCircuitOpen) {
      throw errors[0]
    }

    return results
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.successCount++
    this.totalSuccesses++
    this.totalRequests++

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successCount >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED)
        this.failureCount = 0
        this.successCount = 0
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Success in closed state, reset failure count
      this.failureCount = 0
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failureCount++
    this.totalFailures++
    this.totalRequests++
    this.lastFailureTime = new Date()

    if (this.state === CircuitState.HALF_OPEN) {
      // Failure during recovery, reopen circuit
      this.transitionTo(CircuitState.OPEN)
      this.openedAt = new Date()
      this.successCount = 0
      this.failureCount = 0
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo(CircuitState.OPEN)
        this.openedAt = new Date()
      }
    }
  }

  /**
   * Attempt transition to HALF_OPEN if enough time has passed
   */
  private maybeTransitionToHalfOpen(): void {
    if (this.state !== CircuitState.OPEN) {
      return
    }

    if (!this.openedAt) {
      return
    }

    const timeSinceOpen = Date.now() - this.openedAt.getTime()
    if (timeSinceOpen >= this.resetTimeoutMs) {
      this.transitionTo(CircuitState.HALF_OPEN)
      this.successCount = 0
      this.failureCount = 0
    }
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    if (newState === this.state) {
      return
    }

    const config = (this as any).__config as CircuitBreakerConfig
    const oldState = this.state

    console.log(`[CB] ${config.name}: ${oldState} -> ${newState}`)

    this.state = newState
    this.lastStateChange = new Date()

    // Trigger state change callback
    if (config.onStateChange) {
      try {
        config.onStateChange(oldState, newState)
      } catch (error) {
        console.error('[CB] State change callback error:', error)
      }
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    this.maybeTransitionToHalfOpen() // Check state before returning
    return this.state
  }

  /**
   * Get milliseconds until retry available (for OPEN state)
   */
  getRetryAfterMs(): number {
    if (this.state !== CircuitState.OPEN || !this.openedAt) {
      return 0
    }

    const elapsed = Date.now() - this.openedAt.getTime()
    const remaining = Math.max(0, this.resetTimeoutMs - elapsed)
    return Math.ceil(remaining / 1000) * 1000 // Round to nearest second
  }

  /**
   * Get metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      openedAt: this.openedAt,
      lastStateChange: this.lastStateChange
    }
  }

  /**
   * Get success rate percentage
   */
  getSuccessRate(): number {
    if (this.totalRequests === 0) {
      return 100
    }
    return (this.totalSuccesses / this.totalRequests) * 100
  }

  /**
   * Reset circuit breaker to initial state
   */
  reset(): void {
    console.log(`[CB] Resetting circuit breaker`)
    this.state = CircuitState.CLOSED
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = undefined
    this.openedAt = undefined
    this.lastStateChange = new Date()
  }

  /**
   * Manually open circuit
   */
  forceOpen(): void {
    this.transitionTo(CircuitState.OPEN)
    this.openedAt = new Date()
  }

  /**
   * Manually close circuit
   */
  forceClose(): void {
    this.transitionTo(CircuitState.CLOSED)
    this.failureCount = 0
    this.successCount = 0
  }

  /**
   * Is circuit available for execution
   */
  isAvailable(): boolean {
    return this.state !== CircuitState.OPEN || this.shouldAttemptRecovery()
  }

  /**
   * Should attempt recovery
   */
  private shouldAttemptRecovery(): boolean {
    if (this.state !== CircuitState.OPEN || !this.openedAt) {
      return false
    }

    const timeSinceOpen = Date.now() - this.openedAt.getTime()
    return timeSinceOpen >= this.resetTimeoutMs
  }
}

/**
 * Global circuit breaker registry
 */
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>()

  /**
   * Register or get circuit breaker
   */
  register(config: CircuitBreakerConfig): CircuitBreaker {
    if (this.breakers.has(config.name)) {
      return this.breakers.get(config.name)!
    }

    const breaker = new CircuitBreaker(config)
    this.breakers.set(config.name, breaker)
    return breaker
  }

  /**
   * Get circuit breaker by name
   */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name)
  }

  /**
   * Get all circuit breakers
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers)
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): { [name: string]: CircuitBreakerMetrics } {
    const metrics: { [name: string]: CircuitBreakerMetrics } = {}

    for (const [name, breaker] of this.breakers) {
      metrics[name] = breaker.getMetrics()
    }

    return metrics
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset()
    }
  }

  /**
   * Get health status
   */
  getHealthStatus(): 'healthy' | 'degraded' | 'critical' {
    const metrics = this.getAllMetrics()
    const openCount = Object.values(metrics).filter(m => m.state === CircuitState.OPEN).length
    const halfOpenCount = Object.values(metrics).filter(m => m.state === CircuitState.HALF_OPEN).length

    if (openCount === 0 && halfOpenCount === 0) {
      return 'healthy'
    } else if (openCount === 0) {
      return 'degraded'
    } else {
      return 'critical'
    }
  }
}

// Export singleton registry
export const circuitBreakerRegistry = new CircuitBreakerRegistry()

export default CircuitBreaker
