/**
 * Production Error Handling System
 * 
 * Handles unhandled promise rejections and uncaught exceptions
 * Provides centralized error logging and alerting
 * Ensures graceful degradation instead of crashes
 */

export interface ProductionError {
  type: 'unhandledRejection' | 'uncaughtException'
  reason?: string
  error?: string
  message?: string
  stack?: string
  timestamp: Date
  severity: 'critical' | 'high' | 'medium' | 'low'
}

// Global error tracking
export class ProductionErrorHandler {
  private static logger = null // Will be used for logging to SystemLogger if needed
  private static errorQueue: ProductionError[] = []
  private static maxQueueSize = 1000
  private static isShuttingDown = false

  /**
   * Initialize production error handlers
   * Must be called early in application startup (instrumentation.ts)
   */
  static initialize() {
    if (this.isInitialized()) {
      console.log('[ERROR_HANDLER] Already initialized, skipping')
      return
    }

    console.log('[ERROR_HANDLER] Initializing production error handlers...')

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.handleUnhandledRejection(reason, promise)
    })

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.handleUncaughtException(error)
    })

    // SIGTERM/SIGINT are real platform-issued termination signals (deploy,
    // scale-down, manual kill) — not something this process should ever send
    // itself. We use them ONLY as a best-effort trigger to close live
    // exchange positions before the platform's own kill completes; we NEVER
    // call process.exit() here. Calling process.exit() from an application
    // module raced the platform's shutdown sequence and was the root cause of
    // the "session regularly restarting" crash-loop — the platform already
    // owns the process lifecycle and will terminate the process on its own
    // schedule regardless of what this handler does.
    process.on('SIGTERM', () => this.handleShutdownSignal('SIGTERM'))
    process.on('SIGINT', () => this.handleShutdownSignal('SIGINT'))

    // Mark initialization
    ;(globalThis as any).__errorHandlerInitialized = true
    console.log('[ERROR_HANDLER] Production error handlers initialized')
  }

  /**
   * Check if error handler is already initialized
   */
  private static isInitialized(): boolean {
    return !!(globalThis as any).__errorHandlerInitialized
  }

  /**
   * Handle unhandled promise rejection
   */
  private static handleUnhandledRejection(reason: any, promise: Promise<any>) {
    const error: ProductionError = {
      type: 'unhandledRejection',
      reason: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: new Date(),
      severity: 'critical'
    }

    console.error('[ERROR] Unhandled Promise Rejection:', reason)
    console.error('Promise:', promise)

    this.logError(error)
    this.trackErrorMetric(error)
  }

  /**
   * Handle uncaught exception
   */
  private static handleUncaughtException(error: Error) {
    const productionError: ProductionError = {
      type: 'uncaughtException',
      error: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date(),
      severity: 'critical'
    }

    console.error('[ERROR] Uncaught Exception (non-fatal, surviving):', error)

    this.logError(productionError)
    this.trackErrorMetric(productionError)

    // DO NOT shut down on an uncaught exception. The Global Trade Coordinator
    // must remain alive and keep every running engine active. Exiting here
    // would kill all engines and force a worker restart — the exact crash the
    // operator reported. We log + track and SURVIVE; the active handler in
    // lib/error-handler.ts additionally self-heals (re-arms running engines).
    // SIGTERM/SIGINT only trigger a best-effort position close, never exit.
  }

  /**
   * Best-effort reaction to a platform-issued SIGTERM/SIGINT. This does NOT
   * call process.exit() — the platform (PM2/systemd/request worker) already sent the
   * signal and owns when the process actually dies. We only race to close
   * live exchange positions within a short budget before that happens, so
   * positions don't stay open on the exchange with no local process managing
   * their stop-loss/take-profit.
   */
  private static handleShutdownSignal(signal: string) {
    if (this.isShuttingDown) return
    this.isShuttingDown = true
    console.log(`[SHUTDOWN] Received ${signal}: attempting best-effort live position close (no process.exit)`)
    this.emergencyCloseAllPositions()
      .then(() => console.log('[SHUTDOWN] Emergency position close attempt complete'))
      .catch((error) => console.error('[SHUTDOWN] Error during emergency close:', error))
  }

  /**
   * Emergency close all open live positions across all connections.
   * Best-effort — errors per connection are swallowed so other connections
   * still get cleaned up. Runs with a hard 8s budget since the platform may
   * force-kill the process shortly after SIGTERM.
   */
  private static async emergencyCloseAllPositions(): Promise<void> {
    try {
      const { getAllConnections, initRedis } = await import(/* webpackMode: "eager" */ "@/lib/redis-db")
      const { getLivePositions, closeLivePosition } = await import(/* webpackMode: "eager" */ "@/lib/trade-engine/stages/live-stage")
      const { exchangeConnectorFactory } = await import(/* webpackMode: "eager" */ "@/lib/exchange-connectors/factory")
      await initRedis()
      const connections = await getAllConnections()

      const deadline = Date.now() + 8000 // 8s budget
      for (const conn of connections) {
        if (Date.now() > deadline) break
        const connId: string = conn.id || conn.connection_id || conn.connectionId
        if (!connId) continue
        const isLive =
          conn.is_live_trade === "1" || conn.is_live_trade === true ||
          (conn as any).live_trade === "1" || (conn as any).live_trade === true
        if (!isLive) continue

        try {
          const connector = await exchangeConnectorFactory.getOrCreateConnector(connId)
          if (!connector) continue

          const all = await getLivePositions(connId)
          const open = all.filter(
            (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled",
          )

          for (const pos of open) {
            if (Date.now() > deadline) break
            const exitPrice = Number(pos.exchangeData?.markPrice) || pos.averageExecutionPrice || pos.entryPrice
            console.log(`[SHUTDOWN] Emergency-closing ${pos.symbol} @ ${exitPrice}`)
            await closeLivePosition(connId, pos.id!, exitPrice, connector, "shutdown").catch(() => {})
          }
        } catch { /* per-connection errors must not abort other connections */ }
      }
    } catch (err) {
      console.warn('[SHUTDOWN] emergencyCloseAllPositions failed:', err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Log error to system
   */
  private static logError(error: ProductionError) {
    // Queue error for later processing
    this.errorQueue.push(error)
    if (this.errorQueue.length > this.maxQueueSize) {
      this.errorQueue.shift() // Remove oldest
    }

    // Log to error tracking system
    try {
      // Log is queued in errorQueue, can be sent to WorkflowLogger later
      console.error('[ERROR_HANDLER] Error logged:', {
        type: error.type,
        message: error.message || error.reason,
        severity: error.severity,
        stack: error.stack
      })
    } catch (logError) {
      console.error('[ERROR_HANDLER] Failed to log error:', logError)
    }
  }

  /**
   * Track error metrics for monitoring
   */
  private static trackErrorMetric(error: ProductionError) {
    // This will be connected to Prometheus metrics in Fix A7
    const key = `error:${error.type}:${error.severity}`
    try {
      // Placeholder for metrics integration
      // Will be implemented with Prometheus in Fix A7
    } catch (e) {
      console.error('[ERROR_HANDLER] Failed to track metric:', e)
    }
  }

  /**
   * Get recent errors for debugging
   */
  static getRecentErrors(limit: number = 50): ProductionError[] {
    return this.errorQueue.slice(-limit)
  }

  /**
   * Clear error queue (be careful with this)
   */
  static clearErrorQueue() {
    this.errorQueue = []
  }

  /**
   * Get error statistics
   */
  static getErrorStats(): { [key: string]: number } {
    const stats: { [key: string]: number } = {}

    for (const error of this.errorQueue) {
      const key = `${error.type}:${error.severity}`
      stats[key] = (stats[key] || 0) + 1
    }

    return stats
  }
}

/**
 * Wrapper function to safely handle async operations
 * Ensures errors are caught and logged
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: { operation: string; severity?: 'low' | 'medium' | 'high' | 'critical' }
): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    const productionError: ProductionError = {
      type: 'uncaughtException',
      message: `Error in ${context.operation}`,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date(),
      severity: context.severity || 'high'
    }

    // Log error to console (ProductionErrorHandler catches unhandled exceptions/rejections separately)
    console.error(`[ERROR_HANDLER] ${context.operation} failed:`, productionError)

    // Return null instead of throwing to allow graceful degradation
    return null
  }
}

export default ProductionErrorHandler
