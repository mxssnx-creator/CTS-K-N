/**
 * Structured Logging System
 * 
 * Comprehensive logging with correlation IDs, context tracking,
 * severity levels, and structured output for monitoring
 */

import { getCorrelationId } from './correlation-tracking'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4
}

export enum LogCategory {
  SYSTEM = 'SYSTEM',
  API = 'API',
  DATABASE = 'DATABASE',
  EXCHANGE = 'EXCHANGE',
  ENGINE = 'ENGINE',
  STRATEGY = 'STRATEGY',
  INDICATION = 'INDICATION',
  REALTIME = 'REALTIME',
  SECURITY = 'SECURITY',
  PERFORMANCE = 'PERFORMANCE',
  HEALTH = 'HEALTH',
  BACKUP = 'BACKUP',
  ALERT = 'ALERT'
}

export interface StructuredLog {
  timestamp: string
  correlationId?: string
  level: LogLevel
  category: LogCategory
  message: string
  context?: Record<string, any>
  error?: {
    name: string
    message: string
    stack?: string
    code?: string
  }
  metrics?: {
    duration?: number
    memoryBefore?: number
    memoryAfter?: number
    requestSize?: number
    responseSize?: number
  }
  user?: string
  source?: string
  path?: string
  method?: string
}

export interface LoggerOptions {
  minLevel?: LogLevel
  category: LogCategory
  source?: string
  enableConsole?: boolean
  enableFile?: boolean
  enableMetrics?: boolean
}

/**
 * Structured Logger
 */
export class StructuredLogger {
  private minLevel: LogLevel
  private category: LogCategory
  private source: string
  private enableConsole: boolean
  private enableFile: boolean
  private enableMetrics: boolean
  private logBuffer: StructuredLog[] = []
  private maxBufferSize = 10000

  constructor(options: LoggerOptions) {
    this.minLevel = options.minLevel ?? LogLevel.INFO
    this.category = options.category
    this.source = options.source ?? 'unknown'
    this.enableConsole = options.enableConsole ?? true
    this.enableFile = options.enableFile ?? false
    this.enableMetrics = options.enableMetrics ?? true
  }

  /**
   * Log message at specified level
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, any>,
    error?: Error,
    metrics?: StructuredLog['metrics']
  ): void {
    if (level < this.minLevel) return

    const log: StructuredLog = {
      timestamp: new Date().toISOString(),
      correlationId: getCorrelationId(),
      level,
      category: this.category,
      message,
      context,
      source: this.source,
      metrics
    }

    if (error) {
      log.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      }
    }

    // Add to buffer
    this.logBuffer.push(log)
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize)
    }

    // Output to console
    if (this.enableConsole) {
      this.outputConsole(log)
    }

    // Output to metrics
    if (this.enableMetrics && typeof process !== 'undefined') {
      this.outputMetrics(log)
    }
  }

  /**
   * Debug level log
   */
  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context)
  }

  /**
   * Info level log
   */
  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context)
  }

  /**
   * Warning level log
   */
  warn(message: string, context?: Record<string, any>, error?: Error): void {
    this.log(LogLevel.WARN, message, context, error)
  }

  /**
   * Error level log
   */
  error(message: string, error?: Error, context?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, context, error)
  }

  /**
   * Critical level log
   */
  critical(message: string, error?: Error, context?: Record<string, any>): void {
    this.log(LogLevel.CRITICAL, message, context, error)
  }

  /**
   * Log with metrics
   */
  logWithMetrics(
    level: LogLevel,
    message: string,
    metrics: StructuredLog['metrics'],
    context?: Record<string, any>
  ): void {
    this.log(level, message, context, undefined, metrics)
  }

  /**
   * Output to console with color coding
   */
  private outputConsole(log: StructuredLog): void {
    const colors = {
      [LogLevel.DEBUG]: '\x1b[36m', // Cyan
      [LogLevel.INFO]: '\x1b[32m', // Green
      [LogLevel.WARN]: '\x1b[33m', // Yellow
      [LogLevel.ERROR]: '\x1b[31m', // Red
      [LogLevel.CRITICAL]: '\x1b[35m' // Magenta
    }
    const reset = '\x1b[0m'

    const levelName = LogLevel[log.level]
    const color = colors[log.level]

    const prefix = `${color}[${log.timestamp}] [${log.category}] [${levelName}]${reset}`
    const correlationId = log.correlationId ? ` [${log.correlationId}]` : ''

    console.log(`${prefix}${correlationId} ${log.message}`, {
      context: log.context,
      error: log.error,
      metrics: log.metrics
    })
  }

  /**
   * Output to metrics collector
   */
  private outputMetrics(log: StructuredLog): void {
    const { metricsCollector } = require('./metrics-collector')
    
    // Count logs by level and category
    metricsCollector.incrementCounter('log_events_total', 1, {
      level: LogLevel[log.level],
      category: log.category
    })

    // Track error rates
    if (log.level >= LogLevel.ERROR) {
      metricsCollector.incrementCounter('error_logs_total', 1, {
        category: log.category
      })
    }

    // Track performance metrics
    if (log.metrics?.duration) {
      metricsCollector.recordHistogram('log_operation_duration_ms', log.metrics.duration, {
        category: log.category
      })
    }
  }

  /**
   * Get log buffer
   */
  getBuffer(): StructuredLog[] {
    return [...this.logBuffer]
  }

  /**
   * Get filtered logs
   */
  getFilteredLogs(filter: {
    level?: LogLevel
    category?: LogCategory
    correlationId?: string
    since?: Date
    limit?: number
  }): StructuredLog[] {
    let logs = this.logBuffer

    if (filter.level !== undefined) {
      logs = logs.filter(l => l.level >= filter.level!)
    }

    if (filter.category) {
      logs = logs.filter(l => l.category === filter.category)
    }

    if (filter.correlationId) {
      logs = logs.filter(l => l.correlationId === filter.correlationId)
    }

    if (filter.since) {
      logs = logs.filter(l => new Date(l.timestamp) >= filter.since!)
    }

    if (filter.limit) {
      logs = logs.slice(-filter.limit)
    }

    return logs
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.logBuffer = []
  }

  /**
   * Export logs as JSON
   */
  export(): string {
    return JSON.stringify(this.logBuffer, null, 2)
  }

  /**
   * Export logs as CSV
   */
  exportCSV(): string {
    if (this.logBuffer.length === 0) {
      return 'No logs'
    }

    const headers = ['timestamp', 'correlationId', 'level', 'category', 'message', 'context', 'error']
    const rows = this.logBuffer.map(log => [
      log.timestamp,
      log.correlationId || '',
      LogLevel[log.level],
      log.category,
      log.message,
      JSON.stringify(log.context || {}),
      JSON.stringify(log.error || {})
    ])

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  }
}

/**
 * Global logger instances by category
 */
const loggers: Map<LogCategory, StructuredLogger> = new Map()

/**
 * Get or create logger for category
 */
export function getLogger(category: LogCategory, options?: Partial<LoggerOptions>): StructuredLogger {
  if (loggers.has(category)) {
    return loggers.get(category)!
  }

  const logger = new StructuredLogger({
    category,
    ...options
  })

  loggers.set(category, logger)
  return logger
}

/**
 * Get all loggers
 */
export function getAllLoggers(): Map<LogCategory, StructuredLogger> {
  return new Map(loggers)
}

/**
 * Get all logs from all loggers
 */
export function getAllLogs(): StructuredLog[] {
  const allLogs: StructuredLog[] = []
  loggers.forEach(logger => {
    allLogs.push(...logger.getBuffer())
  })
  return allLogs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

/**
 * Export all logs
 */
export function exportAllLogs(format: 'json' | 'csv' = 'json'): string {
  if (format === 'csv') {
    const headers = ['timestamp', 'correlationId', 'level', 'category', 'message', 'context', 'error']
    const allLogs = getAllLogs()
    const rows = allLogs.map(log => [
      log.timestamp,
      log.correlationId || '',
      LogLevel[log.level],
      log.category,
      log.message,
      JSON.stringify(log.context || {}),
      JSON.stringify(log.error || {})
    ])
    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  } else {
    return JSON.stringify(getAllLogs(), null, 2)
  }
}

// Export default loggers for common categories
export const systemLogger = getLogger(LogCategory.SYSTEM)
export const apiLogger = getLogger(LogCategory.API)
export const dbLogger = getLogger(LogCategory.DATABASE)
export const exchangeLogger = getLogger(LogCategory.EXCHANGE)
export const engineLogger = getLogger(LogCategory.ENGINE)
export const securityLogger = getLogger(LogCategory.SECURITY)
