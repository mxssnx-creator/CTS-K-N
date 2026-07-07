/**
 * Metrics Collection System
 * 
 * Collects and exports metrics in Prometheus format
 * Tracks system performance, errors, and application-specific metrics
 */

export enum MetricType {
  COUNTER = 'counter',     // Always increases
  GAUGE = 'gauge',         // Can go up or down
  HISTOGRAM = 'histogram', // Distribution of values
  SUMMARY = 'summary'      // Similar to histogram
}

export interface Metric {
  name: string
  type: MetricType
  help: string
  value: number
  labels?: { [key: string]: string }
  timestamp: number
}

export interface MetricDefinition {
  name: string
  type: MetricType
  help: string
}

/**
 * Prometheus-compatible metrics collector
 */
export class MetricsCollector {
  private metrics = new Map<string, Metric[]>()
  private definitions = new Map<string, MetricDefinition>()
  private startTime = Date.now()

  /**
   * Register a new metric definition
   */
  registerMetric(definition: MetricDefinition): void {
    if (this.definitions.has(definition.name)) {
      console.warn(`[METRICS] Metric ${definition.name} already registered`)
      return
    }

    this.definitions.set(definition.name, definition)
    this.metrics.set(definition.name, [])

    console.log(`[METRICS] Registered metric: ${definition.name}`)
  }

  /**
   * Increment counter
   */
  incrementCounter(name: string, value: number = 1, labels?: { [key: string]: string }): void {
    const definition = this.definitions.get(name)
    if (!definition) {
      console.warn(`[METRICS] Counter ${name} not registered`)
      return
    }

    if (definition.type !== MetricType.COUNTER) {
      console.warn(`[METRICS] Metric ${name} is not a counter`)
      return
    }

    const key = this.getMetricKey(name, labels)
    let metricList = this.metrics.get(name)

    if (!metricList) {
      metricList = []
      this.metrics.set(name, metricList)
    }

    // Find or create metric
    let metric = metricList.find(m => this.getMetricKey(name, m.labels) === key)

    if (!metric) {
      metric = {
        name,
        type: MetricType.COUNTER,
        help: definition.help,
        value: 0,
        labels,
        timestamp: Date.now()
      }
      metricList.push(metric)
    }

    metric.value += value
    metric.timestamp = Date.now()
  }

  /**
   * Set gauge value
   */
  setGauge(name: string, value: number, labels?: { [key: string]: string }): void {
    const definition = this.definitions.get(name)
    if (!definition) {
      console.warn(`[METRICS] Gauge ${name} not registered`)
      return
    }

    if (definition.type !== MetricType.GAUGE) {
      console.warn(`[METRICS] Metric ${name} is not a gauge`)
      return
    }

    const key = this.getMetricKey(name, labels)
    let metricList = this.metrics.get(name)

    if (!metricList) {
      metricList = []
      this.metrics.set(name, metricList)
    }

    // Find or create metric
    let metric = metricList.find(m => this.getMetricKey(name, m.labels) === key)

    if (!metric) {
      metric = {
        name,
        type: MetricType.GAUGE,
        help: definition.help,
        value: 0,
        labels,
        timestamp: Date.now()
      }
      metricList.push(metric)
    }

    metric.value = value
    metric.timestamp = Date.now()
  }

  /**
   * Observe histogram value
   */
  observeHistogram(
    name: string,
    value: number,
    labels?: { [key: string]: string }
  ): void {
    const definition = this.definitions.get(name)
    if (!definition) {
      console.warn(`[METRICS] Histogram ${name} not registered`)
      return
    }

    if (definition.type !== MetricType.HISTOGRAM) {
      console.warn(`[METRICS] Metric ${name} is not a histogram`)
      return
    }

    const key = this.getMetricKey(name, labels)
    let metricList = this.metrics.get(name)

    if (!metricList) {
      metricList = []
      this.metrics.set(name, metricList)
    }

    // For histograms, store individual observations
    metricList.push({
      name,
      type: MetricType.HISTOGRAM,
      help: definition.help,
      value,
      labels,
      timestamp: Date.now()
    })

    // Limit stored observations
    if (metricList.length > 10000) {
      metricList.shift()
    }
  }

  /**
   * Get metric key for deduplication
   */
  private getMetricKey(name: string, labels?: { [key: string]: string }): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name
    }

    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')

    return `${name}{${labelStr}}`
  }

  /**
   * Get all metrics in Prometheus text format
   */
  getMetricsText(): string {
    let output = ''

    // Group by metric name
    const metricsByName = new Map<string, Metric[]>()

    for (const [name, metrics] of this.metrics) {
      if (!metricsByName.has(name)) {
        metricsByName.set(name, [])
      }
      metricsByName.get(name)!.push(...metrics)
    }

    // Output in Prometheus format
    for (const [name, metrics] of metricsByName) {
      const definition = this.definitions.get(name)
      if (!definition) continue

      // Output TYPE and HELP comments
      output += `# HELP ${name} ${definition.help}\n`
      output += `# TYPE ${name} ${definition.type}\n`

      // Output metrics
      for (const metric of metrics) {
        const labels = this.formatLabels(metric.labels)
        output += `${name}${labels} ${metric.value}\n`
      }

      output += '\n'
    }

    return output
  }

  /**
   * Format labels for Prometheus output
   */
  private formatLabels(labels?: { [key: string]: string }): string {
    if (!labels || Object.keys(labels).length === 0) {
      return ''
    }

    const labelStrs = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
      .join(',')

    return `{${labelStrs}}`
  }

  /**
   * Escape label value for Prometheus
   */
  private escapeLabel(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
  }

  /**
   * Get metrics as JSON
   */
  getMetricsJson(): object {
    const metricsJson: { [key: string]: any } = {}

    for (const [name, metrics] of this.metrics) {
      metricsJson[name] = metrics.map(m => ({
        value: m.value,
        labels: m.labels,
        timestamp: m.timestamp
      }))
    }

    return metricsJson
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear()
    console.log('[METRICS] All metrics reset')
  }

  /**
   * Reset specific metric
   */
  resetMetric(name: string): void {
    this.metrics.delete(name)
    console.log(`[METRICS] Metric ${name} reset`)
  }
}

/**
 * Global metrics collector
 */
export const metricsCollector = new MetricsCollector()

/**
 * Initialize default system metrics
 */
export function initializeDefaultMetrics(): void {
  // Request metrics
  metricsCollector.registerMetric({
    name: 'http_requests_total',
    type: MetricType.COUNTER,
    help: 'Total HTTP requests'
  })

  metricsCollector.registerMetric({
    name: 'http_request_duration_seconds',
    type: MetricType.HISTOGRAM,
    help: 'HTTP request duration in seconds'
  })

  metricsCollector.registerMetric({
    name: 'http_response_size_bytes',
    type: MetricType.HISTOGRAM,
    help: 'HTTP response size in bytes'
  })

  // Error metrics
  metricsCollector.registerMetric({
    name: 'errors_total',
    type: MetricType.COUNTER,
    help: 'Total errors'
  })

  metricsCollector.registerMetric({
    name: 'unhandled_rejections_total',
    type: MetricType.COUNTER,
    help: 'Total unhandled promise rejections'
  })

  metricsCollector.registerMetric({
    name: 'uncaught_exceptions_total',
    type: MetricType.COUNTER,
    help: 'Total uncaught exceptions'
  })

  // System metrics
  metricsCollector.registerMetric({
    name: 'process_uptime_seconds',
    type: MetricType.GAUGE,
    help: 'Process uptime in seconds'
  })

  metricsCollector.registerMetric({
    name: 'process_memory_heap_used_bytes',
    type: MetricType.GAUGE,
    help: 'Process memory heap used in bytes'
  })

  metricsCollector.registerMetric({
    name: 'process_memory_heap_total_bytes',
    type: MetricType.GAUGE,
    help: 'Process memory heap total in bytes'
  })

  // Circuit breaker metrics
  metricsCollector.registerMetric({
    name: 'circuit_breaker_state',
    type: MetricType.GAUGE,
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)'
  })

  metricsCollector.registerMetric({
    name: 'circuit_breaker_failures_total',
    type: MetricType.COUNTER,
    help: 'Total circuit breaker failures'
  })

  // Rate limiter metrics
  metricsCollector.registerMetric({
    name: 'rate_limit_exceeded_total',
    type: MetricType.COUNTER,
    help: 'Total rate limit exceeded events'
  })

  // Database metrics
  metricsCollector.registerMetric({
    name: 'redis_commands_total',
    type: MetricType.COUNTER,
    help: 'Total Redis commands'
  })

  metricsCollector.registerMetric({
    name: 'redis_command_duration_seconds',
    type: MetricType.HISTOGRAM,
    help: 'Redis command duration in seconds'
  })

  metricsCollector.registerMetric({
    name: 'redis_requests_per_second',
    type: MetricType.GAUGE,
    help: 'Redis requests per second'
  })

  // Trade engine metrics
  metricsCollector.registerMetric({
    name: 'trade_engine_cycles_total',
    type: MetricType.COUNTER,
    help: 'Total trade engine cycles'
  })

  metricsCollector.registerMetric({
    name: 'trade_engine_cycle_duration_seconds',
    type: MetricType.HISTOGRAM,
    help: 'Trade engine cycle duration in seconds'
  })

  metricsCollector.registerMetric({
    name: 'active_trades_total',
    type: MetricType.GAUGE,
    help: 'Total active trades'
  })

  metricsCollector.registerMetric({
    name: 'active_positions_total',
    type: MetricType.GAUGE,
    help: 'Total active positions'
  })

  console.log('[METRICS] Default metrics initialized')
}

/**
 * Update system metrics
 */
export function updateSystemMetrics(): void {
  const uptime = (Date.now() - (metricsCollector as any).startTime) / 1000
  const memory = process.memoryUsage()

  metricsCollector.setGauge('process_uptime_seconds', uptime)
  metricsCollector.setGauge('process_memory_heap_used_bytes', memory.heapUsed)
  metricsCollector.setGauge('process_memory_heap_total_bytes', memory.heapTotal)
  
  // Add Redis request rate tracking
  try {
    const { getRedisRequestsPerSecond } = require("@/lib/redis-db")
    const requestsPerSecond = getRedisRequestsPerSecond()
    metricsCollector.setGauge('redis_requests_per_second', requestsPerSecond)
  } catch (error) {
    // Silently fail if Redis function not available
  }
}

// Initialize default metrics on module load
if (typeof process !== 'undefined' && process.env.NEXT_RUNTIME === 'nodejs') {
  initializeDefaultMetrics()
}

export default metricsCollector
