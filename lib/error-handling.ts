/**
 * Unified Logging & Error Handling System
 * Centralized logging with context, error codes, and structured output
 */

export enum ErrorCode {
  // Connection errors
  CONNECTION_FAILED = "CONNECTION_FAILED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  API_TIMEOUT = "API_TIMEOUT",
  RATE_LIMITED = "RATE_LIMITED",

  // Order errors
  ORDER_FAILED = "ORDER_FAILED",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  INVALID_SYMBOL = "INVALID_SYMBOL",
  ORDER_NOT_FOUND = "ORDER_NOT_FOUND",

  // Position errors
  POSITION_NOT_FOUND = "POSITION_NOT_FOUND",
  POSITION_CLOSED = "POSITION_CLOSED",
  LIQUIDATION_RISK = "LIQUIDATION_RISK",

  // Risk errors
  LEVERAGE_TOO_HIGH = "LEVERAGE_TOO_HIGH",
  POSITION_SIZE_TOO_LARGE = "POSITION_SIZE_TOO_LARGE",
  DRAWDOWN_EXCEEDED = "DRAWDOWN_EXCEEDED",
  MAX_POSITIONS_REACHED = "MAX_POSITIONS_REACHED",

  // Signal errors
  SIGNAL_NOT_READY = "SIGNAL_NOT_READY",
  INDICATOR_CALCULATION_FAILED = "INDICATOR_CALCULATION_FAILED",

  // System errors
  DATABASE_ERROR = "DATABASE_ERROR",
  VALIDATION_FAILED = "VALIDATION_FAILED",
  UNKNOWN = "UNKNOWN",
}

export interface LogContext {
  component: string
  operation: string
  connectionId?: string
  symbol?: string
  orderId?: string
  positionId?: string
  userId?: string
  [key: string]: any
}

export interface ErrorLog {
  code: ErrorCode
  message: string
  context: LogContext
  timestamp: string
  attempt?: number
  maxAttempts?: number
  retryIn?: number
  originalError?: string
}

/**
 * Unified Logger
 * Provides structured logging with context and severity levels
 */
export class UnifiedLogger {
  private static logs: ErrorLog[] = []
  private static maxLogs = 1000

  /**
   * Log info message
   */
  static info(context: LogContext, message: string) {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${context.component}]`
    const details = context.operation ? ` [${context.operation}]` : ""
    const fullMsg = `${prefix}${details} ${message}`

    console.log(`[v0] ${fullMsg}`)
  }

  /**
   * Log warning
   */
  static warn(context: LogContext, message: string) {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${context.component}] WARN`
    const details = context.operation ? ` [${context.operation}]` : ""
    const fullMsg = `${prefix}${details} ${message}`

    console.warn(`[v0] ${fullMsg}`)
  }

  /**
   * Log error with structured error log
   */
  static error(context: LogContext, code: ErrorCode, message: string, originalError?: any) {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${context.component}] ERROR`
    const details = context.operation ? ` [${context.operation}]` : ""
    const errorMsg = `${prefix}${details} [${code}] ${message}`

    // Add context details
    let fullMsg = errorMsg
    if (context.connectionId) fullMsg += ` (connection: ${context.connectionId})`
    if (context.symbol) fullMsg += ` (symbol: ${context.symbol})`
    if (context.orderId) fullMsg += ` (order: ${context.orderId})`

    if (originalError) {
      const errStr = originalError instanceof Error ? originalError.message : String(originalError)
      fullMsg += `\n    Original: ${errStr}`
    }

    console.error(`[v0] ${fullMsg}`)

    // Store error log
    const errorLog: ErrorLog = {
      code,
      message,
      context,
      timestamp,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
    }

    this.logs.push(errorLog)
    if (this.logs.length > this.maxLogs) {
      this.logs.shift()
    }
  }

  /**
   * Log retry attempt
   */
  static retry(context: LogContext, attempt: number, maxAttempts: number, backoffMs: number) {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${context.component}] RETRY`
    const details = context.operation ? ` [${context.operation}]` : ""
    const msg = `${prefix}${details} Attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms`

    console.log(`[v0] ${msg}`)
  }

  /**
   * Get recent error logs
   */
  static getErrorLogs(limit: number = 50): ErrorLog[] {
    return this.logs.slice(-limit)
  }

  /**
   * Get error logs filtered by component or code
   */
  static getErrorsByFilter(filter: { component?: string; code?: ErrorCode }): ErrorLog[] {
    return this.logs.filter((log) => {
      if (filter.component && log.context.component !== filter.component) return false
      if (filter.code && log.code !== filter.code) return false
      return true
    })
  }

  /**
   * Clear logs
   */
  static clearLogs() {
    this.logs = []
  }

  /**
   * Export logs as JSON for analysis
   */
  static exportLogs(): string {
    return JSON.stringify(this.logs, null, 2)
  }
}

/**
 * Error Handler - catches and categorizes errors
 */
export class ErrorHandler {
  /**
   * Classify error and return appropriate error code
   */
  static classifyError(error: any): ErrorCode {
    if (!error) return ErrorCode.UNKNOWN

    const msg = error.message?.toLowerCase() || error.toString().toLowerCase()

    // Connection errors
    if (msg.includes("econnrefused") || msg.includes("connection refused")) return ErrorCode.CONNECTION_FAILED
    if (msg.includes("invalid api key") || msg.includes("invalid credentials")) return ErrorCode.INVALID_CREDENTIALS
    if (msg.includes("timeout")) return ErrorCode.API_TIMEOUT
    if (msg.includes("rate limit") || msg.includes("429")) return ErrorCode.RATE_LIMITED

    // Order errors
    if (msg.includes("insufficient balance") || msg.includes("insufficient margin")) return ErrorCode.INSUFFICIENT_BALANCE
    if (msg.includes("invalid symbol")) return ErrorCode.INVALID_SYMBOL
    if (msg.includes("order not found")) return ErrorCode.ORDER_NOT_FOUND

    // Position errors
    if (msg.includes("position not found")) return ErrorCode.POSITION_NOT_FOUND
    if (msg.includes("liquidation")) return ErrorCode.LIQUIDATION_RISK

    // Risk errors
    if (msg.includes("leverage") && msg.includes("too high")) return ErrorCode.LEVERAGE_TOO_HIGH
    if (msg.includes("position size") && msg.includes("too large")) return ErrorCode.POSITION_SIZE_TOO_LARGE
    if (msg.includes("drawdown")) return ErrorCode.DRAWDOWN_EXCEEDED
    if (msg.includes("max positions")) return ErrorCode.MAX_POSITIONS_REACHED

    return ErrorCode.UNKNOWN
  }

  /**
   * Get retry delay based on error code
   */
  static getRetryDelay(code: ErrorCode, attempt: number): number {
    const baseDelay = 1000 // 1 second
    const exponential = Math.pow(2, attempt - 1)

    switch (code) {
      case ErrorCode.RATE_LIMITED:
        // Back off longer for rate limit
        return baseDelay * exponential * 5
      case ErrorCode.API_TIMEOUT:
        return baseDelay * exponential * 2
      case ErrorCode.CONNECTION_FAILED:
        return baseDelay * exponential * 3
      default:
        return baseDelay * exponential
    }
  }

  /**
   * Determine if error is retryable
   */
  static isRetryable(code: ErrorCode): boolean {
    const nonRetryable = [
      ErrorCode.INVALID_CREDENTIALS,
      ErrorCode.INVALID_SYMBOL,
      ErrorCode.LEVERAGE_TOO_HIGH,
      ErrorCode.POSITION_SIZE_TOO_LARGE,
      ErrorCode.VALIDATION_FAILED,
    ]

    return !nonRetryable.includes(code)
  }

  /**
   * Should stop processing on this error?
   */
  static shouldStop(code: ErrorCode): boolean {
    const stopErrors = [ErrorCode.INVALID_CREDENTIALS, ErrorCode.LIQUIDATION_RISK, ErrorCode.DRAWDOWN_EXCEEDED]

    return stopErrors.includes(code)
  }
}

/**
 * Operation wrapper with automatic error handling and logging
 */
export async function withErrorHandling<T>(
  context: LogContext,
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<{ success: boolean; data?: T; error?: string; code?: ErrorCode }> {
  let lastError: any
  let lastCode: ErrorCode = ErrorCode.UNKNOWN

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation()
      return { success: true, data: result }
    } catch (error) {
      lastError = error
      lastCode = ErrorHandler.classifyError(error)

      UnifiedLogger.error(context, lastCode, "Operation failed", error)

      // Check if error is retryable
      if (!ErrorHandler.isRetryable(lastCode)) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: lastCode,
        }
      }

      // Check if we should stop
      if (ErrorHandler.shouldStop(lastCode)) {
        return {
          success: false,
          error: "Critical error - stopping",
          code: lastCode,
        }
      }

      // Retry if not last attempt
      if (attempt < maxRetries) {
        const delay = ErrorHandler.getRetryDelay(lastCode, attempt)
        UnifiedLogger.retry(context, attempt, maxRetries, delay)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  return {
    success: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    code: lastCode,
  }
}
