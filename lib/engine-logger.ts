/**
 * Comprehensive Engine Logger
 * Expandable log system with symbol-specific and overall tracking
 */

import { getRedisClient } from "@/lib/redis-db"

export interface EngineLogEntry {
  id: string
  timestamp: string
  connectionId: string
  level: 'info' | 'warn' | 'error' | 'debug'
  category: 'prehistoric' | 'websocket' | 'indication' | 'strategy' | 'realtime' | 'system' | 'error'
  symbol: string | null
  message: string
  data?: Record<string, any>
  expandable?: boolean
  expandableData?: Record<string, any>
}

export interface LogQuery {
  connectionId: string
  level?: string
  category?: string
  symbol?: string
  limit?: number
  offset?: number
}

export class EngineLogger {
  private connectionId: string
  private logs: EngineLogEntry[] = []
  private maxLogs = 1000

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Add a log entry
   */
  async log(entry: Omit<EngineLogEntry, 'id' | 'timestamp' | 'connectionId'>): Promise<void> {
    const logEntry: EngineLogEntry = {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
    }

    this.logs.push(logEntry)
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    // Store in Redis
    await this.storeLog(logEntry)

    // Console output
    this.consoleLog(logEntry)
  }

  /**
   * Log prehistoric data loading
   */
  async logPrehistoric(symbol: string, message: string, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: 'info',
      category: 'prehistoric',
      symbol,
      message,
      data,
      expandable: true,
      expandableData: data,
    })
  }

  /**
   * Log WebSocket event
   */
  async logWebSocket(symbol: string, message: string, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: 'info',
      category: 'websocket',
      symbol,
      message,
      data,
    })
  }

  /**
   * Log indication evaluation
   */
  async logIndication(symbol: string, type: string, passed: boolean, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: passed ? 'info' : 'warn',
      category: 'indication',
      symbol,
      message: `${type}: ${passed ? 'PASSED' : 'FAILED'}`,
      data: { type, passed, ...data },
      expandable: true,
      expandableData: data,
    })
  }

  /**
   * Log strategy evaluation
   */
  async logStrategy(symbol: string, stage: string, passed: boolean, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: passed ? 'info' : 'warn',
      category: 'strategy',
      symbol,
      message: `${stage.toUpperCase()}: ${passed ? 'PASSED' : 'FAILED'}`,
      data: { stage, passed, ...data },
      expandable: true,
      expandableData: data,
    })
  }

  /**
   * Log realtime update
   */
  async logRealtime(symbol: string, message: string, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: 'info',
      category: 'realtime',
      symbol,
      message,
      data,
    })
  }

  /**
   * Log system event
   */
  async logSystem(message: string, data?: Record<string, any>): Promise<void> {
    await this.log({
      level: 'info',
      category: 'system',
      symbol: null,
      message,
      data,
    })
  }

  /**
   * Log error
   */
  async logError(symbol: string | null, category: string, message: string, error?: Error): Promise<void> {
    await this.log({
      level: 'error',
      category: 'error',
      symbol,
      message,
      data: { category, error: error?.message, stack: error?.stack },
      expandable: true,
      expandableData: { error: error?.message, stack: error?.stack },
    })
  }

  /**
   * Get logs with filtering
   */
  getLogs(query: LogQuery): EngineLogEntry[] {
    let filtered = this.logs

    if (query.level) {
      filtered = filtered.filter(l => l.level === query.level)
    }
    if (query.category) {
      filtered = filtered.filter(l => l.category === query.category)
    }
    if (query.symbol) {
      filtered = filtered.filter(l => l.symbol === query.symbol)
    }

    const offset = query.offset || 0
    const limit = query.limit || 100

    return filtered.slice(offset, offset + limit)
  }

  /**
   * Get logs by symbol
   */
  getLogsBySymbol(symbol: string): EngineLogEntry[] {
    return this.logs.filter(l => l.symbol === symbol)
  }

  /**
   * Get logs by category
   */
  getLogsByCategory(category: string): EngineLogEntry[] {
    return this.logs.filter(l => l.category === category)
  }

  /**
   * Get expandable logs
   */
  getExpandableLogs(): EngineLogEntry[] {
    return this.logs.filter(l => l.expandable)
  }

  /**
   * Get log summary
   */
  getSummary(): {
    total: number
    byLevel: Record<string, number>
    byCategory: Record<string, number>
    bySymbol: Record<string, number>
    recentErrors: EngineLogEntry[]
  } {
    const byLevel: Record<string, number> = {}
    const byCategory: Record<string, number> = {}
    const bySymbol: Record<string, number> = {}
    const recentErrors: EngineLogEntry[] = []

    for (const log of this.logs) {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1
      byCategory[log.category] = (byCategory[log.category] || 0) + 1
      if (log.symbol) {
        bySymbol[log.symbol] = (bySymbol[log.symbol] || 0) + 1
      }
      if (log.level === 'error') {
        recentErrors.push(log)
      }
    }

    return {
      total: this.logs.length,
      byLevel,
      byCategory,
      bySymbol,
      recentErrors: recentErrors.slice(-10),
    }
  }

  /**
   * Store log in Redis
   */
  private async storeLog(entry: EngineLogEntry): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `engine_logs:${this.connectionId}`
      await client.lpush(key, JSON.stringify(entry))
      await client.ltrim(key, 0, 999) // Keep last 1000 logs
    } catch (error) {
      console.error('[EngineLogger] Failed to store log:', error)
    }
  }

  /**
   * Console output
   */
  private consoleLog(entry: EngineLogEntry): void {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}]`
    const symbol = entry.symbol ? ` [${entry.symbol}]` : ''
    const message = `${prefix}${symbol} ${entry.message}`

    switch (entry.level) {
      case 'error':
        console.error(message, entry.data || '')
        break
      case 'warn':
        console.warn(message, entry.data || '')
        break
      default:
        console.log(message, entry.data || '')
    }
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = []
  }
}

// Global logger registry
const loggerRegistry = new Map<string, EngineLogger>()

export function getEngineLogger(connectionId: string): EngineLogger {
  if (!loggerRegistry.has(connectionId)) {
    loggerRegistry.set(connectionId, new EngineLogger(connectionId))
  }
  return loggerRegistry.get(connectionId)!
}

export function getAllLoggers(): Map<string, EngineLogger> {
  return loggerRegistry
}
