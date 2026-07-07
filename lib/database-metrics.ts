/**
 * Database Metrics & Query Profiling
 * 
 * Tracks database performance, slow queries, and index usage
 * Provides detailed diagnostics for optimization
 */

import { metricsCollector, MetricType } from './metrics-collector'

export interface QueryMetrics {
  command: string
  durationMs: number
  timestamp: Date
  status: 'success' | 'error'
  error?: string
  args?: string[]
}

export interface SlowQueryReport {
  command: string
  durationMs: number
  threshold: number
  timestamp: Date
  frequencyInWindow: number
}

export interface DatabaseHealth {
  operationCount: number
  errorCount: number
  slowQueryCount: number
  avgResponseTime: number
  maxResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  errorRate: number
  health: 'healthy' | 'degraded' | 'critical'
}

/**
 * Database metrics collector
 */
export class DatabaseMetricsCollector {
  private queryMetrics: QueryMetrics[] = []
  private slowQueryThreshold = 100 // ms
  private maxMetricsSize = 10000
  private errorCount = 0
  private operationCount = 0

  constructor(slowQueryThreshold: number = 100) {
    this.slowQueryThreshold = slowQueryThreshold
    this.registerMetrics()
  }

  /**
   * Register database metrics
   */
  private registerMetrics(): void {
    metricsCollector.registerMetric({
      name: 'redis_operations_total',
      type: MetricType.COUNTER,
      help: 'Total Redis operations'
    })

    metricsCollector.registerMetric({
      name: 'redis_operation_errors_total',
      type: MetricType.COUNTER,
      help: 'Total Redis operation errors'
    })

    metricsCollector.registerMetric({
      name: 'redis_operation_duration_milliseconds',
      type: MetricType.HISTOGRAM,
      help: 'Redis operation duration in milliseconds'
    })

    metricsCollector.registerMetric({
      name: 'redis_slow_queries_total',
      type: MetricType.COUNTER,
      help: 'Total slow queries detected'
    })

    metricsCollector.registerMetric({
      name: 'redis_connections_active',
      type: MetricType.GAUGE,
      help: 'Active Redis connections'
    })

    metricsCollector.registerMetric({
      name: 'redis_memory_used_bytes',
      type: MetricType.GAUGE,
      help: 'Redis memory usage in bytes'
    })

    metricsCollector.registerMetric({
      name: 'redis_keys_total',
      type: MetricType.GAUGE,
      help: 'Total keys in Redis'
    })

    console.log('[DB_METRICS] Database metrics registered')
  }

  /**
   * Record query execution
   */
  recordQuery(command: string, durationMs: number, success: boolean = true, error?: Error, args?: string[]): void {
    const metric: QueryMetrics = {
      command,
      durationMs,
      timestamp: new Date(),
      status: success ? 'success' : 'error',
      error: error?.message,
      args
    }

    this.queryMetrics.push(metric)
    if (this.queryMetrics.length > this.maxMetricsSize) {
      this.queryMetrics.shift()
    }

    // Update counters
    this.operationCount++
    if (!success) {
      this.errorCount++
    }

    // Track metrics
    metricsCollector.incrementCounter('redis_operations_total', 1, { command })

    if (!success) {
      metricsCollector.incrementCounter('redis_operation_errors_total', 1, { command })
    }

    metricsCollector.observeHistogram('redis_operation_duration_milliseconds', durationMs, { command })

    // Alert on slow queries
    if (durationMs > this.slowQueryThreshold) {
      metricsCollector.incrementCounter('redis_slow_queries_total', 1, { command })
      console.warn(
        `[SLOW_QUERY] ${command} took ${durationMs}ms ` +
        `(threshold: ${this.slowQueryThreshold}ms)`
      )
    }
  }

  /**
   * Get slow queries in time window
   */
  getSlowQueries(windowMs: number = 60000, limit: number = 50): SlowQueryReport[] {
    const now = Date.now()
    const cutoff = now - windowMs

    const slowQueries = this.queryMetrics
      .filter(m => m.timestamp.getTime() > cutoff && m.durationMs > this.slowQueryThreshold)
      .map(m => ({
        command: m.command,
        durationMs: m.durationMs,
        threshold: this.slowQueryThreshold,
        timestamp: m.timestamp,
        frequencyInWindow: 0
      }))

    // Count frequencies
    const frequencies = new Map<string, number>()
    for (const query of slowQueries) {
      frequencies.set(query.command, (frequencies.get(query.command) || 0) + 1)
    }

    return slowQueries
      .sort((a, b) => b.durationMs - a.durationMs)
      .map(q => ({
        ...q,
        frequencyInWindow: frequencies.get(q.command) || 0
      }))
      .slice(0, limit)
  }

  /**
   * Get database health
   */
  getHealth(): DatabaseHealth {
    const now = Date.now()
    const recentMetrics = this.queryMetrics.filter(
      m => now - m.timestamp.getTime() < 300000 // Last 5 minutes
    )

    const responseTimes = recentMetrics.map(m => m.durationMs).sort((a, b) => a - b)
    const slowCount = recentMetrics.filter(m => m.durationMs > this.slowQueryThreshold).length
    const errorCount = recentMetrics.filter(m => m.status === 'error').length

    let health: 'healthy' | 'degraded' | 'critical' = 'healthy'
    if (errorCount > recentMetrics.length * 0.1 || slowCount > recentMetrics.length * 0.2) {
      health = 'degraded'
    }
    if (errorCount > recentMetrics.length * 0.2 || slowCount > recentMetrics.length * 0.3) {
      health = 'critical'
    }

    const p95Index = Math.floor(responseTimes.length * 0.95)
    const p99Index = Math.floor(responseTimes.length * 0.99)

    return {
      operationCount: this.operationCount,
      errorCount: this.errorCount,
      slowQueryCount: slowCount,
      avgResponseTime: responseTimes.length > 0 
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
        : 0,
      maxResponseTime: Math.max(...responseTimes, 0),
      p95ResponseTime: responseTimes[p95Index] || 0,
      p99ResponseTime: responseTimes[p99Index] || 0,
      errorRate: recentMetrics.length > 0 
        ? (errorCount / recentMetrics.length) * 100 
        : 0,
      health
    }
  }

  /**
   * Get command statistics
   */
  getCommandStats(windowMs: number = 300000): Map<string, {
    count: number
    avgDuration: number
    maxDuration: number
    errorCount: number
  }> {
    const now = Date.now()
    const cutoff = now - windowMs

    const stats = new Map()

    for (const metric of this.queryMetrics) {
      if (metric.timestamp.getTime() < cutoff) continue

      if (!stats.has(metric.command)) {
        stats.set(metric.command, {
          count: 0,
          totalDuration: 0,
          maxDuration: 0,
          errorCount: 0
        })
      }

      const stat = stats.get(metric.command)
      stat.count++
      stat.totalDuration += metric.durationMs
      stat.maxDuration = Math.max(stat.maxDuration, metric.durationMs)
      if (metric.status === 'error') {
        stat.errorCount++
      }
    }

    // Convert to final format
    const result = new Map()
    for (const [command, stat] of stats) {
      result.set(command, {
        count: stat.count,
        avgDuration: stat.totalDuration / stat.count,
        maxDuration: stat.maxDuration,
        errorCount: stat.errorCount
      })
    }

    return result
  }

  /**
   * Get query pattern analysis
   */
  analyzePatterns(windowMs: number = 300000): {
    hotkeys: Array<{ command: string; count: number; avgDuration: number }>
    bottlenecks: Array<{ command: string; maxDuration: number; count: number }>
    errorPatterns: Array<{ command: string; errorCount: number; errorRate: number }>
  } {
    const stats = this.getCommandStats(windowMs)

    // Hot keys (most frequent)
    const hotkeys = Array.from(stats.entries())
      .map(([command, stat]) => ({
        command,
        count: stat.count,
        avgDuration: stat.avgDuration
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    // Bottlenecks (slowest operations)
    const bottlenecks = Array.from(stats.entries())
      .map(([command, stat]) => ({
        command,
        maxDuration: stat.maxDuration,
        count: stat.count
      }))
      .sort((a, b) => b.maxDuration - a.maxDuration)
      .slice(0, 10)

    // Error patterns
    const errorPatterns = Array.from(stats.entries())
      .filter(([_, stat]) => stat.errorCount > 0)
      .map(([command, stat]) => ({
        command,
        errorCount: stat.errorCount,
        errorRate: (stat.errorCount / stat.count) * 100
      }))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 10)

    return { hotkeys, bottlenecks, errorPatterns }
  }

  /**
   * Set slow query threshold
   */
  setSlowQueryThreshold(thresholdMs: number): void {
    this.slowQueryThreshold = thresholdMs
    console.log(`[DB_METRICS] Slow query threshold set to ${thresholdMs}ms`)
  }

  /**
   * Clear metrics
   */
  clear(): void {
    this.queryMetrics = []
    this.errorCount = 0
    this.operationCount = 0
  }

  /**
   * Export metrics summary
   */
  exportSummary(): {
    totalOperations: number
    totalErrors: number
    slowQueries: SlowQueryReport[]
    health: DatabaseHealth
    patterns: any
  } {
    return {
      totalOperations: this.operationCount,
      totalErrors: this.errorCount,
      slowQueries: this.getSlowQueries(),
      health: this.getHealth(),
      patterns: this.analyzePatterns()
    }
  }
}

// Export singleton
export const dbMetrics = new DatabaseMetricsCollector()

export default DatabaseMetricsCollector
