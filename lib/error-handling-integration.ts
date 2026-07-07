/**
 * Error Handling Integration
 * 
 * Integrates error handling, circuit breakers, and recovery strategies
 * across critical trade engine operations and API routes
 */

import { safeAsync, AsyncSafetyOptions, withTimeout } from './async-safety'
import { CircuitBreaker } from './circuit-breaker'
import { metricsCollector, MetricType } from './metrics-collector'
import { alertManager, AlertSeverity } from './alerting-system'
import { ProductionErrorHandler } from './error-handling-production'

/**
 * Circuit breaker registry for different services
 */
export const circuitBreakers = {
  exchange: new CircuitBreaker({
    name: 'exchange-api',
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Exchange API: ${from} -> ${to}`)
      metricsCollector.setGauge('circuit_breaker_state', to === 'open' ? 1 : 0, { service: 'exchange' })
    }
  }),

  database: new CircuitBreaker({
    name: 'database',
    failureThreshold: 10,
    resetTimeoutMs: 30000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Database: ${from} -> ${to}`)
      if (to === 'open') {
        alertManager.sendAlert(
          'Database Circuit Breaker Opened',
          'Database connection failures detected, circuit breaker activated',
          { severity: AlertSeverity.CRITICAL, source: 'circuit-breaker' }
        ).catch(err => console.error('Failed to send alert:', err))
      }
    }
  }),

  cache: new CircuitBreaker({
    name: 'cache',
    failureThreshold: 20,
    resetTimeoutMs: 20000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Cache: ${from} -> ${to}`)
    }
  }),

  indication: new CircuitBreaker({
    name: 'indication-processor',
    failureThreshold: 10,
    resetTimeoutMs: 45000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Indication Processor: ${from} -> ${to}`)
    }
  }),

  strategy: new CircuitBreaker({
    name: 'strategy-processor',
    failureThreshold: 10,
    resetTimeoutMs: 45000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Strategy Processor: ${from} -> ${to}`)
    }
  }),

  realtime: new CircuitBreaker({
    name: 'realtime-processor',
    failureThreshold: 10,
    resetTimeoutMs: 45000,
    onStateChange: (from, to) => {
      console.log(`[CIRCUIT_BREAKER] Realtime Processor: ${from} -> ${to}`)
    }
  })
}

/**
 * Wrap exchange API calls with error handling and circuit breaker
 */
export async function withExchangeErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T | null> {
  try {
    const result = await circuitBreakers.exchange.execute(
      () => safeAsync(fn, {
        name: `exchange-${operationName}`,
        retries: 2,
        timeoutMs: 10000,
        fallback: null
      }).then(result => result.data)
    )
    return result as T | null
  } catch (error) {
    console.error(`[EXCHANGE_ERROR] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('errors_total', 1, { type: 'exchange', operation: operationName })
    return null
  }
}

/**
 * Wrap database operations with error handling and circuit breaker
 */
export async function withDatabaseErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string,
  options: { retries?: number; timeoutMs?: number; fallback?: T } = {}
): Promise<T | null> {
  try {
    const result = await circuitBreakers.database.execute(
      () => safeAsync(fn, {
        name: `database-${operationName}`,
        retries: options.retries ?? 2,
        timeoutMs: options.timeoutMs ?? 5000,
        fallback: options.fallback ?? null
      }).then(result => result.data)
    )
    return result as T | null
  } catch (error) {
    console.error(`[DATABASE_ERROR] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('errors_total', 1, { type: 'database', operation: operationName })
    return options.fallback ?? null
  }
}

/**
 * Wrap cache operations with error handling
 */
export async function withCacheErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string,
  fallback?: T
): Promise<T | null> {
  try {
    const result = await circuitBreakers.cache.executeWithFallback(
      () => safeAsync(fn, {
        name: `cache-${operationName}`,
        retries: 1,
        timeoutMs: 3000,
        fallback: null
      }).then(result => result.data),
      fallback ?? null
    )
    return result as T | null
  } catch (error) {
    console.warn(`[CACHE_WARNING] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('cache_errors_total', 1)
    return fallback ?? null
  }
}

/**
 * Wrap indication processor with error handling
 */
export async function withIndicationErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T | null> {
  try {
    const result = await circuitBreakers.indication.executeWithFallback(
      () => safeAsync(fn, {
        name: `indication-${operationName}`,
        retries: 1,
        timeoutMs: 30000,
        fallback: null
      }).then(result => result.data),
      null
    )
    return result as T | null
  } catch (error) {
    console.error(`[INDICATION_ERROR] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('indication_processor_errors_total', 1)
    return null
  }
}

/**
 * Wrap strategy processor with error handling
 */
export async function withStrategyErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T | null> {
  try {
    const result = await circuitBreakers.strategy.executeWithFallback(
      () => safeAsync(fn, {
        name: `strategy-${operationName}`,
        retries: 1,
        timeoutMs: 30000,
        fallback: null
      }).then(result => result.data),
      null
    )
    return result as T | null
  } catch (error) {
    console.error(`[STRATEGY_ERROR] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('strategy_processor_errors_total', 1)
    return null
  }
}

/**
 * Wrap realtime processor with error handling
 */
export async function withRealtimeErrorHandling<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T | null> {
  try {
    const result = await circuitBreakers.realtime.executeWithFallback(
      () => safeAsync(fn, {
        name: `realtime-${operationName}`,
        retries: 1,
        timeoutMs: 15000,
        fallback: null
      }).then(result => result.data),
      null
    )
    return result as T | null
  } catch (error) {
    console.error(`[REALTIME_ERROR] ${operationName} failed:`, error)
    metricsCollector.incrementCounter('realtime_processor_errors_total', 1)
    return null
  }
}

/**
 * Safely execute batch operations with error collection
 */
export async function batchWithErrorHandling<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  options: {
    batchName: string
    continueOnError?: boolean
    timeoutMs?: number
    maxConcurrency?: number
  }
): Promise<{ results: R[]; errors: Array<{ item: T; error: Error }> }> {
  const { batchName, continueOnError = true, timeoutMs = 30000, maxConcurrency = 5 } = options

  const results: R[] = []
  const errors: Array<{ item: T; error: Error }> = []

  // Process in chunks for concurrency control
  for (let i = 0; i < items.length; i += maxConcurrency) {
    const chunk = items.slice(i, i + maxConcurrency)

    const promises = chunk.map(async (item) => {
      try {
        const result = await withTimeout(fn(item), timeoutMs, `${batchName}-item`)
        results.push(result)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        errors.push({ item, error: err })

        if (!continueOnError) {
          throw error
        }

        console.warn(`[BATCH_ERROR] ${batchName}: Item processing failed:`, err.message)
      }
    })

    try {
      await Promise.all(promises)
    } catch (error) {
      if (!continueOnError) {
        metricsCollector.incrementCounter('batch_operation_errors_total', 1)
        throw error
      }
    }
  }

  if (errors.length > 0) {
    console.error(`[BATCH_ERROR] ${batchName}: ${errors.length}/${items.length} items failed`)
    metricsCollector.incrementCounter('batch_item_errors_total', errors.length)
  }

  return { results, errors }
}

/**
 * Retry operation with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    operationName: string
    maxAttempts?: number
    initialDelayMs?: number
    maxDelayMs?: number
    backoffMultiplier?: number
  }
): Promise<T | null> {
  const {
    operationName,
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2
  } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      console.log(`[RETRY] ${operationName}: Attempt ${attempt + 1}/${maxAttempts}`)
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxAttempts - 1) {
        const delayMs = Math.min(
          initialDelayMs * Math.pow(backoffMultiplier, attempt),
          maxDelayMs
        )

        console.warn(
          `[RETRY] ${operationName}: Attempt ${attempt + 1} failed, ` +
          `retrying in ${delayMs}ms: ${lastError.message}`
        )

        await new Promise(r => setTimeout(r, delayMs))
      }
    }
  }

  console.error(`[RETRY_FAILED] ${operationName}: All ${maxAttempts} attempts failed`)
  metricsCollector.incrementCounter('retry_exhausted_total', 1, { operation: operationName })

  return null
}

/**
 * Circuit breaker status dashboard
 */
export function getCircuitBreakerStatus() {
  return Object.entries(circuitBreakers).reduce((acc, [name, breaker]) => {
    const metrics = breaker.getMetrics()
    acc[name] = {
      state: metrics.state,
      failureCount: metrics.failureCount,
      successRate: breaker.getSuccessRate().toFixed(2) + '%',
      totalRequests: metrics.totalRequests,
      availability: breaker.isAvailable() ? 'available' : 'unavailable'
    }
    return acc
  }, {} as any)
}

/**
 * Initialize error handling for all critical operations
 */
export function initializeErrorHandling() {
  console.log('[ERROR_INTEGRATION] Error handling initialized with circuit breakers')

  // Register default error metrics
  metricsCollector.registerMetric({
    name: 'cache_errors_total',
    type: MetricType.COUNTER,
    help: 'Total cache operation errors'
  })

  metricsCollector.registerMetric({
    name: 'indication_processor_errors_total',
    type: MetricType.COUNTER,
    help: 'Total indication processor errors'
  })

  metricsCollector.registerMetric({
    name: 'strategy_processor_errors_total',
    type: MetricType.COUNTER,
    help: 'Total strategy processor errors'
  })

  metricsCollector.registerMetric({
    name: 'realtime_processor_errors_total',
    type: MetricType.COUNTER,
    help: 'Total realtime processor errors'
  })

  metricsCollector.registerMetric({
    name: 'batch_operation_errors_total',
    type: MetricType.COUNTER,
    help: 'Total batch operation errors'
  })

  metricsCollector.registerMetric({
    name: 'batch_item_errors_total',
    type: MetricType.COUNTER,
    help: 'Total batch item errors'
  })

  metricsCollector.registerMetric({
    name: 'retry_exhausted_total',
    type: MetricType.COUNTER,
    help: 'Total retry exhausted events'
  })
}

export default {
  circuitBreakers,
  withExchangeErrorHandling,
  withDatabaseErrorHandling,
  withCacheErrorHandling,
  withIndicationErrorHandling,
  withStrategyErrorHandling,
  withRealtimeErrorHandling,
  batchWithErrorHandling,
  retryWithBackoff,
  getCircuitBreakerStatus,
  initializeErrorHandling
}
