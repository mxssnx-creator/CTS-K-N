/**
 * API Handler Middleware with Comprehensive Error Handling
 * Provides consistent error handling across all API endpoints
 */

import { NextRequest, NextResponse } from "next/server"
import { apiErrorHandler, ApiError } from "./api-error-handler"
import { SystemLogger } from "./system-logger"

export interface HandlerContext {
  endpoint: string
  method: string
  operation?: string
  requiresAuth?: boolean
  userId?: string
}

/**
 * Wraps async API handlers with comprehensive error handling, logging, and validation
 */
export async function withErrorHandling<T extends any[], R extends NextResponse | Response>(
  handler: (...args: T) => Promise<R>,
  context: HandlerContext,
): Promise<(...args: T) => Promise<Response>> {
  return async (...args: T): Promise<Response> => {
    const startTime = Date.now()
    const { endpoint, method, operation = endpoint, userId } = context

    try {
      const result = await handler(...args)
      
      // Log successful request (verbose)
      const duration = Date.now() - startTime
      console.log(`[v0] API: ${method} ${endpoint} - ${result.status} (${duration}ms)`)

      return result
    } catch (error) {
      const duration = Date.now() - startTime
      
      // Log error
      console.error(`[v0] API Error: ${method} ${endpoint}`, {
        error: error instanceof Error ? error.message : String(error),
        duration,
      })

      // Handle ApiError instances
      if (error instanceof ApiError) {
        try {
          await SystemLogger.logError("api_error", error, { userId: userId || "system", operation,
            endpoint,
            method,
            statusCode: error.statusCode,
          })
        } catch (logErr) {
          console.error("[v0] Failed to log error:", logErr)
        }

        return apiErrorHandler.handleError(error, {
          endpoint,
          method,
          userId,
          operation,
          statusCode: error.statusCode,
          severity: error.severity,
        }) as any
      }

      // Handle regular Error instances
      if (error instanceof Error) {
        try {
          await SystemLogger.logError("api_error", error, { userId: userId || "system", operation,
            endpoint,
            method,
            stack: error.stack,
          })
        } catch (logErr) {
          console.error("[v0] Failed to log error:", logErr)
        }

        return apiErrorHandler.handleError(error, {
          endpoint,
          method,
          userId,
          operation,
          statusCode: 500,
          severity: "error",
        }) as any
      }

      // Handle unknown error types
      const unknownError = new Error(String(error))
      try {
        await SystemLogger.logError("api_error", unknownError, { userId: userId || "system", operation,
          endpoint,
          method,
          originalError: String(error),
        })
      } catch (logErr) {
        console.error("[v0] Failed to log unknown error:", logErr)
      }

      return apiErrorHandler.handleError(unknownError, {
        endpoint,
        method,
        userId,
        operation,
        statusCode: 500,
        severity: "error",
      }) as any
    }
  }
}

/**
 * Validates API request has required fields
 */
export function validateRequestFields(body: any, requiredFields: string[]): void {
  const { valid, errors } = apiErrorHandler.validateRequired(body, requiredFields)
  if (!valid) {
    throw new ApiError("Validation failed", {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: errors,
      context: { requiredFields },
    })
  }
}

/**
 * Validates environment variables are set
 */
export function validateEnvVariables(vars: string[]): void {
  const { valid, missing } = apiErrorHandler.validateEnvVars(vars)
  if (!valid) {
    throw new ApiError("Missing required environment variables", {
      statusCode: 500,
      code: "ENV_VAR_ERROR",
      details: { missing },
      severity: "critical",
      context: { requiredVars: vars },
    })
  }
}

/**
 * Rate limit error response
 */
export function rateLimitExceeded(retryAfter?: number): NextResponse {
  return apiErrorHandler.rateLimitError(retryAfter)
}

/**
 * Connection error response
 */
export function connectionFailed(resource: string, details?: any): NextResponse {
  return apiErrorHandler.connectionError(resource, details)
}

/**
 * Timeout error response
 */
export function operationTimedOut(operation: string, timeout: number, details?: any): NextResponse {
  return apiErrorHandler.timeoutError(operation, timeout, details)
}

export default withErrorHandling
