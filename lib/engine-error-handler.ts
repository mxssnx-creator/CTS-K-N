/**
 * Engine Error Handler
 * Comprehensive error tracking, handling, and recovery for all engine components
 */

import { getRedisClient } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"
import { EngineLogger, getEngineLogger } from "./engine-logger"

export interface EngineError {
  id: string
  timestamp: string
  connectionId: string
  component: 'prehistoric' | 'websocket' | 'indication' | 'strategy' | 'realtime' | 'database' | 'system'
  symbol: string | null
  type: string
  message: string
  stack?: string
  recovered: boolean
  recoveryAction?: string
  retryCount: number
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface ErrorStats {
  totalErrors: number
  errorsByComponent: Record<string, number>
  errorsBySeverity: Record<string, number>
  errorsBySymbol: Record<string, number>
  recoveryRate: number
  recentErrors: EngineError[]
  criticalErrors: EngineError[]
}

export class EngineErrorHandler {
  private connectionId: string
  private progressManager: EngineProgressManager
  private logger: EngineLogger
  private errors: EngineError[] = []
  private errorCounts: Map<string, number> = new Map()
  private maxErrors = 500
  private recoveryActions: Map<string, () => Promise<void>> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
    this.logger = getEngineLogger(connectionId)
  }

  /**
   * Handle an error with tracking and potential recovery
   */
  async handleError(error: {
    component: EngineError['component']
    symbol?: string | null
    type: string
    message: string
    error?: Error
    severity?: EngineError['severity']
    retryCount?: number
  }): Promise<EngineError> {
    const engineError: EngineError = {
      id: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      component: error.component,
      symbol: error.symbol || null,
      type: error.type,
      message: error.message,
      stack: error.error?.stack,
      recovered: false,
      recoveryAction: undefined,
      retryCount: error.retryCount || 0,
      severity: error.severity || this.determineSeverity(error.component, error.type),
    }

    // Track error
    this.errors.push(engineError)
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors)
    }

    // Track error count for this type
    const errorKey = `${error.component}:${error.type}`
    this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1)

    // Store in Redis
    await this.storeError(engineError)

    // Log error
    await this.logger.logError(
      engineError.symbol,
      error.component,
      error.message,
      error.error
    )

    // Update progress manager
    await this.progressManager.addError(error.type, error.message, error.symbol)

    // Attempt recovery if action registered
    const recoveryAction = this.recoveryActions.get(errorKey)
    if (recoveryAction) {
      try {
        await recoveryAction()
        engineError.recovered = true
        engineError.recoveryAction = `Auto-recovery: ${errorKey}`
        await this.logger.logSystem(`✓ Recovered from ${errorKey}`)
      } catch (recoveryError) {
        engineError.recovered = false
        await this.logger.logError(null, 'recovery', `Failed to recover from ${errorKey}`, recoveryError instanceof Error ? recoveryError : undefined)
      }
    }

    return engineError
  }

  /**
   * Register a recovery action for an error type
   */
  registerRecoveryAction(component: EngineError['component'], type: string, action: () => Promise<void>): void {
    const key = `${component}:${type}`
    this.recoveryActions.set(key, action)
  }

  /**
   * Get error statistics
   */
  getErrorStats(): ErrorStats {
    const errorsByComponent: Record<string, number> = {}
    const errorsBySeverity: Record<string, number> = {}
    const errorsBySymbol: Record<string, number> = {}
    let recoveredCount = 0
    const criticalErrors: EngineError[] = []

    for (const error of this.errors) {
      errorsByComponent[error.component] = (errorsByComponent[error.component] || 0) + 1
      errorsBySeverity[error.severity] = (errorsBySeverity[error.severity] || 0) + 1
      if (error.symbol) {
        errorsBySymbol[error.symbol] = (errorsBySymbol[error.symbol] || 0) + 1
      }
      if (error.recovered) {
        recoveredCount++
      }
      if (error.severity === 'critical') {
        criticalErrors.push(error)
      }
    }

    return {
      totalErrors: this.errors.length,
      errorsByComponent,
      errorsBySeverity,
      errorsBySymbol,
      recoveryRate: this.errors.length > 0 ? (recoveredCount / this.errors.length) * 100 : 0,
      recentErrors: this.errors.slice(-20),
      criticalErrors,
    }
  }

  /**
   * Get errors by component
   */
  getErrorsByComponent(component: EngineError['component']): EngineError[] {
    return this.errors.filter(e => e.component === component)
  }

  /**
   * Get errors by symbol
   */
  getErrorsBySymbol(symbol: string): EngineError[] {
    return this.errors.filter(e => e.symbol === symbol)
  }

  /**
   * Get errors by severity
   */
  getErrorsBySeverity(severity: EngineError['severity']): EngineError[] {
    return this.errors.filter(e => e.severity === severity)
  }

  /**
   * Clear all errors
   */
  clearErrors(): void {
    this.errors = []
    this.errorCounts.clear()
  }

  /**
   * Determine error severity based on component and type
   */
  private determineSeverity(component: EngineError['component'], type: string): EngineError['severity'] {
    const criticalTypes = ['connection_failed', 'database_corruption', 'system_crash']
    const highTypes = ['websocket_disconnect', 'data_loss', 'calculation_error']
    const mediumTypes = ['timeout', 'rate_limit', 'parse_error']

    if (criticalTypes.includes(type)) return 'critical'
    if (highTypes.includes(type)) return 'high'
    if (mediumTypes.includes(type)) return 'medium'
    return 'low'
  }

  /**
   * Store error in Redis
   */
  private async storeError(error: EngineError): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `errors:${this.connectionId}`
      await client.lpush(key, JSON.stringify(error))
      await client.ltrim(key, 0, 499) // Keep last 500 errors
    } catch (storeError) {
      console.error('[ErrorHandler] Failed to store error:', storeError)
    }
  }

  /**
   * Get recent errors from Redis
   */
  async getRecentErrors(limit: number = 50): Promise<EngineError[]> {
    try {
      const client = getRedisClient()
      const key = `errors:${this.connectionId}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }
}

// Global error handler registry
const handlerRegistry = new Map<string, EngineErrorHandler>()

export function getErrorHandler(connectionId: string): EngineErrorHandler {
  if (!handlerRegistry.has(connectionId)) {
    handlerRegistry.set(connectionId, new EngineErrorHandler(connectionId))
  }
  return handlerRegistry.get(connectionId)!
}

export function getAllErrorHandlers(): Map<string, EngineErrorHandler> {
  return handlerRegistry
}
