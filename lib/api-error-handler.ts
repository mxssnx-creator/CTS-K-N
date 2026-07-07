/**
 * Comprehensive API Error Handling Utility
 * Handles all API errors consistently across testing, orders, websockets, and variables
 */

import { NextRequest, NextResponse } from "next/server"
import { errorResponse } from "./api-response"
import { SystemLogger } from "./system-logger"

export type ErrorSeverity = "critical" | "error" | "warning" | "info"

export interface ApiErrorOptions {
  statusCode?: number
  code?: string
  details?: Record<string, any>
  context?: Record<string, any>
  severity?: ErrorSeverity
  logToDatabase?: boolean
}

export class ApiError extends Error {
  public statusCode: number
  public code: string
  public details?: Record<string, any>
  public context?: Record<string, any>
  public severity: ErrorSeverity
  public timestamp: Date

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message)
    this.name = "ApiError"
    this.statusCode = options.statusCode || 500
    this.code = options.code || `ERROR_${this.statusCode}`
    this.details = options.details
    this.context = options.context
    this.severity = options.severity || "error"
    this.timestamp = new Date()
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ApiErrorHandler {
  private static instance: ApiErrorHandler

  private constructor() {}

  public static getInstance(): ApiErrorHandler {
    if (!ApiErrorHandler.instance) {
      ApiErrorHandler.instance = new ApiErrorHandler()
    }
    return ApiErrorHandler.instance
  }

  /**
   * Validates required fields in request
   */
  public validateRequired(data: any, fields: string[]): { valid: boolean; errors?: Record<string, string> } {
    const errors: Record<string, string> = {}

    for (const field of fields) {
      if (data[field] === undefined || data[field] === null || data[field] === "") {
        errors[field] = `${field} is required`
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    }
  }

  /**
   * Validates environment variables
   */
  public validateEnvVars(vars: string[]): { valid: boolean; missing?: string[] } {
    const missing: string[] = []

    for (const varName of vars) {
      if (!process.env[varName]) {
        missing.push(varName)
      }
    }

    return {
      valid: missing.length === 0,
      missing: missing.length > 0 ? missing : undefined,
    }
  }

  /**
   * Handles and formats API errors for response
   */
  public async handleError(error: unknown, options: {
    endpoint: string
    method: string
    userId?: string
    operation?: string
    statusCode?: number
    severity?: ErrorSeverity
  }): Promise<NextResponse> {
    const {
      endpoint,
      method,
      userId,
      operation,
      statusCode = 500,
      severity = "error",
    } = options

    let message = "Internal server error"
    let code = `ERROR_${statusCode}`
    let details: Record<string, any> | undefined

    if (error instanceof ApiError) {
      message = error.message
      code = error.code
      details = error.details
      console.error(`[v0] ${operation || "API"} Error:`, {
        code,
        message,
        severity: error.severity,
        statusCode: error.statusCode,
        details: error.details,
        context: error.context,
        timestamp: error.timestamp,
      })

      // Log to database
      if (error.severity === "critical") {
        try {
          await SystemLogger.logError(error, userId || "system", operation || endpoint)
        } catch (logError) {
          console.error("[v0] Failed to log error:", logError)
        }
      }

      return errorResponse(message, {
        status: error.statusCode,
        code: error.code,
        details: error.details,
      })
    }

    if (error instanceof Error) {
      message = error.message
      console.error(`[v0] ${operation || "API"} Error:`, {
        name: error.name,
        message: error.message,
        stack: error.stack,
        endpoint,
        method,
      })

      // Log critical errors
      if (severity === "critical") {
        try {
          await SystemLogger.logError(error, userId || "system", operation || endpoint)
        } catch (logError) {
          console.error("[v0] Failed to log error:", logError)
        }
      }
    } else {
      message = String(error)
      console.error(`[v0] ${operation || "API"} Unknown Error:`, error)
    }

    return errorResponse(message, {
      status: statusCode,
      code,
      details,
    })
  }

  /**
   * Wraps an async API handler with comprehensive error handling
   */
  public wrapHandler<T extends any[], R>(
    handler: (...args: T) => Promise<R>,
    options: { endpoint: string; operation?: string }
  ): (...args: T) => Promise<NextResponse | R> {
    return async (...args: T): Promise<NextResponse | R> => {
      try {
        return await handler(...args)
      } catch (error) {
        return await this.handleError(error, {
          endpoint: options.endpoint,
          method: "POST",
          operation: options.operation,
        })
      }
    }
  }

  /**
   * Creates validation errors for API responses
   */
  public validationError(errors: Record<string, string[]>, details?: any): NextResponse {
    return errorResponse("Validation failed", {
      status: 400,
      code: "VALIDATION_ERROR",
      details: { ...errors, ...details },
    })
  }

  /**
   * Creates rate limit error
   */
  public rateLimitError(retryAfter?: number): NextResponse {
    const headers: Record<string, string> = {}
    if (retryAfter) {
      headers["Retry-After"] = String(retryAfter)
    }

    return errorResponse("Rate limit exceeded", {
      status: 429,
      code: "RATE_LIMIT_EXCEEDED",
      details: { retryAfter },
    })
  }

  /**
   * Creates connection error
   */
  public connectionError(resource: string, details?: any): NextResponse {
    return errorResponse(`Failed to connect to ${resource}`, {
      status: 503,
      code: "CONNECTION_ERROR",
      details,
    })
  }

  /**
   * Creates timeout error
   */
  public timeoutError(operation: string, timeout: number, details?: any): NextResponse {
    return errorResponse(`${operation} timed out after ${timeout}ms`, {
      status: 504,
      code: "TIMEOUT",
      details,
    })
  }

  /**
   * Creates not found error
   */
  public notFoundError(resource: string): NextResponse {
    return errorResponse(`${resource} not found`, {
      status: 404,
      code: "NOT_FOUND",
    })
  }

  /**
   * Creates unauthorized error
   */
  public unauthorizedError(reason?: string): NextResponse {
    return errorResponse(reason || "Unauthorized", {
      status: 401,
      code: "UNAUTHORIZED",
    })
  }

  /**
   * Creates forbidden error
   */
  public forbiddenError(reason?: string): NextResponse {
    return errorResponse(reason || "Forbidden", {
      status: 403,
      code: "FORBIDDEN",
    })
  }
}

export const apiErrorHandler = ApiErrorHandler.getInstance()

export default ApiErrorHandler
