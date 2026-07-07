/**
 * API Error Middleware
 * 
 * Provides unified error handling for all API routes
 * Integrates correlation tracking, rate limiting, and error responses
 */

import { NextRequest, NextResponse } from 'next/server'
import { getRequestContext, setRequestContext, createRequestContext, getCorrelationId } from './correlation-tracking'
import { globalRateLimiter } from './global-rate-limiter'
import { metricsCollector } from './metrics-collector'

export interface ApiErrorResponse {
  error: string
  message: string
  correlationId?: string
  statusCode: number
  timestamp: string
  path?: string
  details?: any
}

/**
 * Create standardized error response
 */
export function createErrorResponse(
  error: Error | string,
  statusCode: number = 500,
  details?: any
): NextResponse<ApiErrorResponse> {
  const message = error instanceof Error ? error.message : String(error)
  const correlationId = getCorrelationId()

  const response: ApiErrorResponse = {
    error: statusCode === 500 ? 'Internal Server Error' : 'Request Error',
    message,
    correlationId,
    statusCode,
    timestamp: new Date().toISOString(),
    details
  }

  // Log error
  console.error(`[API_ERROR] ${statusCode}: ${message} [${correlationId}]`, {
    error: error instanceof Error ? error.stack : undefined,
    details
  })

  return NextResponse.json(response, { status: statusCode })
}

/**
 * Wrap API handler with error handling middleware
 */
export function withApiErrorHandling(
  handler: (req: NextRequest) => Promise<NextResponse>,
  options: {
    requireAuth?: boolean
    rateLimit?: boolean
    correlationTracking?: boolean
    metrics?: boolean
  } = {}
) {
  return async (req: NextRequest) => {
    const {
      requireAuth = false,
      rateLimit = true,
      correlationTracking = true,
      metrics = true
    } = options

    const startTime = Date.now()
    let correlationId: string | undefined
    let statusCode = 500

    try {
      // Setup correlation tracking
      if (correlationTracking) {
        const context = createRequestContext({
          correlationId: (req.headers.get('x-correlation-id') as string) || undefined,
          traceId: (req.headers.get('x-trace-id') as string) || undefined,
          userId: (req.headers.get('x-user-id') as string) || undefined,
          source: 'api',
          path: req.nextUrl.pathname,
          method: req.method
        })
        setRequestContext(context)
        correlationId = context.correlationId
      }

      // Check rate limit
      if (rateLimit) {
        const clientIp = (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown') as string
        const rateLimitResult = globalRateLimiter.checkLimit(clientIp)

        if (!rateLimitResult.allowed) {
          statusCode = 429
          metricsCollector.incrementCounter('rate_limit_exceeded_total', 1)

          const response = NextResponse.json(
            {
              error: 'Too Many Requests',
              message: 'Rate limit exceeded',
              correlationId,
              statusCode: 429,
              timestamp: new Date().toISOString(),
              retryAfter: rateLimitResult.retryAfterMs
            },
            { status: 429 }
          )

          response.headers.set('retry-after', String(Math.ceil((rateLimitResult.retryAfterMs || 0) / 1000)))
          return response
        }

        // Add rate limit headers
        const headers = {
          'x-rate-limit-limit': String(rateLimitResult.limit),
          'x-rate-limit-remaining': String(rateLimitResult.remaining)
        }

        Object.entries(headers).forEach(([key, value]) => {
          response?.headers?.set(key, value)
        })
      }

      // Add correlation header to response
      const responseHeaders: Record<string, string> = {}
      if (correlationId) {
        responseHeaders['x-correlation-id'] = correlationId
      }

      // Call handler with error handling
      const response = await handler(req)
      statusCode = response.status

      // Add correlation header to response
      if (correlationId) {
        response.headers.set('x-correlation-id', correlationId)
      }

      // Track metrics
      if (metrics) {
        const duration = Date.now() - startTime
        metricsCollector.incrementCounter('http_requests_total', 1, { method: req.method, status: String(statusCode) })
        metricsCollector.observeHistogram('http_request_duration_seconds', duration / 1000, { method: req.method, status: String(statusCode) })
      }

      return response
    } catch (error) {
      statusCode = 500

      console.error('[API_HANDLER_ERROR]', {
        path: req.nextUrl.pathname,
        method: req.method,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        correlationId
      })

      // Track error metrics
      if (metrics) {
        metricsCollector.incrementCounter('errors_total', 1, { type: 'api', path: req.nextUrl.pathname })
      }

      const response = createErrorResponse(
        error instanceof Error ? error : new Error(String(error)),
        500,
        { path: req.nextUrl.pathname }
      )

      if (correlationId) {
        response.headers.set('x-correlation-id', correlationId)
      }

      return response
    }
  }
}

/**
 * Wrap handler method with error handling
 */
export function withHandlerErrorHandling<T extends (...args: any[]) => Promise<NextResponse>>(
  handler: T,
  handlerName: string
): T {
  return (async (...args: any[]) => {
    const req = args[0] as NextRequest

    try {
      console.log(`[API] ${handlerName} ${req.method} ${req.nextUrl.pathname}`)

      const startTime = Date.now()
      const response = await handler(...args)

      const duration = Date.now() - startTime
      const correlationId = getCorrelationId()

      if (correlationId) {
        response.headers.set('x-correlation-id', correlationId)
      }

      metricsCollector.observeHistogram(
        'http_request_duration_seconds',
        duration / 1000,
        { handler: handlerName, status: String(response.status) }
      )

      console.log(
        `[API] ${handlerName} completed: ${response.status} (${duration}ms)`
      )

      return response
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      console.error(
        `[API_ERROR] ${handlerName} failed:`,
        error instanceof Error ? error.stack : errorMessage
      )

      metricsCollector.incrementCounter('errors_total', 1, { type: 'api_handler', handler: handlerName })

      return createErrorResponse(error instanceof Error ? error : new Error(errorMessage), 500)
    }
  }) as T
}

/**
 * Wrap async handler with timeout and error handling
 */
export async function withHandlerTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = 30000,
  operationName: string = 'operation'
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${operationName} timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    )
  ])
}

/**
 * Validate request body against schema
 */
export function validateRequestBody<T>(
  body: unknown,
  validator: (data: any) => data is T,
  requiredFields?: string[]
): { valid: boolean; data?: T; error?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid request body' }
  }

  if (requiredFields) {
    const bodyObj = body as any
    const missing = requiredFields.filter(field => !(field in bodyObj))
    if (missing.length > 0) {
      return { valid: false, error: `Missing required fields: ${missing.join(', ')}` }
    }
  }

  if (validator(body)) {
    return { valid: true, data: body }
  }

  return { valid: false, error: 'Request body validation failed' }
}

/**
 * Create safe JSON response with error handling
 */
export function createJsonResponse<T>(
  data: T,
  status: number = 200,
  headers?: Record<string, string>
): NextResponse<T> {
  const response = NextResponse.json(data, { status })

  if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
  }

  const correlationId = getCorrelationId()
  if (correlationId) {
    response.headers.set('x-correlation-id', correlationId)
  }

  return response
}

export default {
  createErrorResponse,
  withApiErrorHandling,
  withHandlerErrorHandling,
  withHandlerTimeout,
  validateRequestBody,
  createJsonResponse
}
