/**
 * Request Correlation Tracking
 * 
 * Tracks requests across the distributed system using correlation IDs
 * Enables request tracing and debugging across multiple services
 */

import { AsyncLocalStorage } from 'async_hooks'
import { v4 as uuidv4 } from 'uuid'

export interface RequestContext {
  correlationId: string
  traceId: string
  spanId: string
  userId?: string
  sessionId?: string
  timestamp: Date
  source: 'api' | 'internal' | 'webhook' | 'scheduled' | 'batch'
  path?: string
  method?: string
  duration?: number
  status?: number
  error?: string
}

/**
 * Async local storage for request context
 * Thread-safe storage that doesn't share data between async operations
 */
const contextStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Generate correlation ID
 */
export function generateCorrelationId(): string {
  return uuidv4()
}

/**
 * Generate trace ID (for distributed tracing)
 */
export function generateTraceId(): string {
  return uuidv4()
}

/**
 * Generate span ID (for tracing within a request)
 */
export function generateSpanId(): string {
  return Math.random().toString(36).substring(2, 15)
}

/**
 * Create a new request context
 */
export function createRequestContext(options: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: options.correlationId || generateCorrelationId(),
    traceId: options.traceId || generateTraceId(),
    spanId: options.spanId || generateSpanId(),
    userId: options.userId,
    sessionId: options.sessionId,
    timestamp: options.timestamp || new Date(),
    source: options.source || 'internal',
    path: options.path,
    method: options.method,
    duration: options.duration,
    status: options.status,
    error: options.error
  }
}

/**
 * Set request context in AsyncLocalStorage
 */
export function setRequestContext(context: RequestContext): void {
  try {
    contextStorage.enterWith(context)
  } catch (error) {
    console.warn('[CORRELATION] Failed to set request context:', error)
  }
}

/**
 * Get current request context
 */
export function getRequestContext(): RequestContext | undefined {
  try {
    return contextStorage.getStore()
  } catch (error) {
    console.warn('[CORRELATION] Failed to get request context:', error)
    return undefined
  }
}

/**
 * Get correlation ID from current context
 */
export function getCorrelationId(): string | undefined {
  return getRequestContext()?.correlationId
}

/**
 * Get trace ID from current context
 */
export function getTraceId(): string | undefined {
  return getRequestContext()?.traceId
}

/**
 * Run code with request context
 */
export function runWithContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    contextStorage.run(context, async () => {
      try {
        const result = await fn()
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * Add correlation headers to log message
 */
export function formatLogWithCorrelation(message: string): string {
  const context = getRequestContext()
  if (!context) {
    return message
  }

  return (
    `[${context.correlationId}] ` +
    `[${context.source}] ` +
    `${message}`
  )
}

/**
 * Next.js API route middleware for correlation
 */
export function withCorrelation(
  handler: (req: any, res: any, context: RequestContext) => Promise<void>
) {
  return async (req: any, res: any) => {
    const context: RequestContext = createRequestContext({
      correlationId: req.headers['x-correlation-id'] as string,
      traceId: req.headers['x-trace-id'] as string,
      userId: req.headers['x-user-id'] as string,
      sessionId: req.cookies?.session_id,
      source: 'api',
      path: req.url,
      method: req.method,
      timestamp: new Date()
    })

    setRequestContext(context)

    // Add correlation headers to response
    res.setHeader('x-correlation-id', context.correlationId)
    res.setHeader('x-trace-id', context.traceId)

    const startTime = Date.now()

    try {
      await handler(req, res, context)
      context.duration = Date.now() - startTime
      context.status = res.statusCode || 200

      console.log(
        formatLogWithCorrelation(
          `API request completed: ${req.method} ${req.url} ` +
          `(${context.status}, ${context.duration}ms)`
        )
      )
    } catch (error) {
      context.duration = Date.now() - startTime
      context.error = error instanceof Error ? error.message : String(error)

      console.error(
        formatLogWithCorrelation(
          `API request failed: ${req.method} ${req.url} ` +
          `(${context.duration}ms) - ${context.error}`
        )
      )

      // Re-throw to Next.js error handler
      throw error
    }
  }
}

/**
 * Middleware to inject correlation headers from incoming request
 */
export function correlationMiddleware(
  req: any,
  res: any,
  next: () => void
): void {
  const correlationId = req.headers['x-correlation-id'] || generateCorrelationId()
  const traceId = req.headers['x-trace-id'] || generateTraceId()

  const context = createRequestContext({
    correlationId: correlationId as string,
    traceId: traceId as string,
    userId: req.headers['x-user-id'] as string,
    source: 'api',
    path: req.url,
    method: req.method
  })

  setRequestContext(context)

  // Add to response headers
  res.setHeader('x-correlation-id', correlationId)
  res.setHeader('x-trace-id', traceId)

  // Store in request for downstream handlers
  ;(req as any).correlationId = correlationId
  ;(req as any).traceId = traceId
  ;(req as any).context = context

  next()
}

/**
 * Create child span for operations within a request
 */
export function createChildSpan(operationName: string): {
  spanId: string
  parentSpanId: string
  startTime: number
  end: (status?: number, error?: string) => void
} {
  const parentContext = getRequestContext()
  const spanId = generateSpanId()
  const startTime = Date.now()

  return {
    spanId,
    parentSpanId: parentContext?.spanId || 'root',
    startTime,
    end: (status?: number, error?: string) => {
      const duration = Date.now() - startTime
      console.log(
        formatLogWithCorrelation(
          `Span [${spanId}] completed: ${operationName} ` +
          `(${duration}ms${status ? `, status: ${status}` : ''}` +
          `${error ? `, error: ${error}` : ''})`
        )
      )
    }
  }
}

/**
 * Wrap function with correlation tracking
 */
export function withTracing<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  operationName: string
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    const span = createChildSpan(operationName)

    try {
      const result = await fn(...args)
      span.end(200)
      return result
    } catch (error) {
      span.end(500, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

/**
 * Batch request tracking
 */
export class BatchRequestTracker {
  private batches = new Map<string, BatchRequest>()

  addBatch(batchId: string, totalItems: number): void {
    this.batches.set(batchId, {
      id: batchId,
      totalItems,
      processedItems: 0,
      failedItems: 0,
      startTime: Date.now(),
      context: getRequestContext()
    })

    console.log(
      formatLogWithCorrelation(
        `Batch [${batchId}] started with ${totalItems} items`
      )
    )
  }

  incrementProcessed(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (batch) {
      batch.processedItems++
    }
  }

  incrementFailed(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (batch) {
      batch.failedItems++
    }
  }

  completeBatch(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (!batch) return

    const duration = Date.now() - batch.startTime
    console.log(
      formatLogWithCorrelation(
        `Batch [${batchId}] completed: ` +
        `${batch.processedItems}/${batch.totalItems} items processed ` +
        `(${batch.failedItems} failed, ${duration}ms)`
      )
    )

    this.batches.delete(batchId)
  }

  getBatch(batchId: string): BatchRequest | undefined {
    return this.batches.get(batchId)
  }
}

interface BatchRequest {
  id: string
  totalItems: number
  processedItems: number
  failedItems: number
  startTime: number
  context?: RequestContext
}

// Export singleton tracker
export const batchTracker = new BatchRequestTracker()

/**
 * Extract correlation headers from context for outgoing requests
 */
export function getCorrelationHeaders(): {
  'x-correlation-id': string
  'x-trace-id': string
} {
  const context = getRequestContext()

  return {
    'x-correlation-id': context?.correlationId || generateCorrelationId(),
    'x-trace-id': context?.traceId || generateTraceId()
  }
}

/**
 * Create instrumented fetch wrapper
 */
export async function correlatedFetch(
  url: string,
  options: RequestInit & { operationName?: string } = {}
): Promise<Response> {
  const { operationName, ...fetchOptions } = options
  const span = createChildSpan(operationName || `FETCH ${url}`)

  try {
    // Add correlation headers
    const headers = new Headers(fetchOptions.headers)
    const correlationHeaders = getCorrelationHeaders()
    headers.set('x-correlation-id', correlationHeaders['x-correlation-id'])
    headers.set('x-trace-id', correlationHeaders['x-trace-id'])

    const response = await fetch(url, {
      ...fetchOptions,
      headers
    })

    span.end(response.status)
    return response
  } catch (error) {
    span.end(500, error instanceof Error ? error.message : String(error))
    throw error
  }
}

export default {
  createRequestContext,
  setRequestContext,
  getRequestContext,
  getCorrelationId,
  getTraceId,
  runWithContext,
  formatLogWithCorrelation,
  withCorrelation,
  correlationMiddleware,
  createChildSpan,
  withTracing,
  getCorrelationHeaders,
  correlatedFetch,
  batchTracker
}
