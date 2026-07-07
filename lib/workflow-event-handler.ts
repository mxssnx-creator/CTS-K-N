import { WorkflowLogger, WorkflowEventType } from "./workflow-logger"

export interface WorkflowEventSubscriber {
  handle(
    connectionId: string,
    eventType: WorkflowEventType,
    data: Record<string, any>
  ): Promise<void>
}

export interface WorkflowHandlerConfig {
  maxRetries: number
  retryDelayMs: number
  timeoutMs: number
  onError?: (error: Error, connectionId: string, eventType: WorkflowEventType) => Promise<void>
}

/**
 * Central workflow event handler and router
 * Handles all trade engine, position, and strategy events with retry logic and error handling
 */
export class WorkflowEventHandler {
  private handlers: Map<WorkflowEventType, WorkflowEventSubscriber[]> = new Map()
  private config: WorkflowHandlerConfig
  private eventQueue: Array<{
    connectionId: string
    eventType: WorkflowEventType
    data: Record<string, any>
    timestamp: number
    retries: number
  }> = []

  constructor(config: Partial<WorkflowHandlerConfig> = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      timeoutMs: config.timeoutMs ?? 30000,
      onError: config.onError,
    }
  }

  /**
   * Register a handler for a specific event type
   */
  registerHandler(
    eventType: WorkflowEventType,
    handler: WorkflowEventSubscriber
  ): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, [])
    }
    this.handlers.get(eventType)!.push(handler)
    console.log(`[v0] [WorkflowEventHandler] Registered handler for ${eventType}`)
  }

  /**
   * Emit an event to all registered handlers with retry logic
   */
  async emit(
    connectionId: string,
    eventType: WorkflowEventType,
    data: Record<string, any> = {}
  ): Promise<void> {
    const handlers = this.handlers.get(eventType) || []

    if (handlers.length === 0) {
      // No handlers for this event type - log and continue
      console.log(`[v0] [WorkflowEventHandler] No handlers for ${eventType}`)
      return
    }

    for (const handler of handlers) {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          await Promise.race([
            handler.handle(connectionId, eventType, data),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Handler timeout")),
                this.config.timeoutMs
              )
            ),
          ])

          // Success - handler completed
          await WorkflowLogger.logEvent(
            connectionId,
            eventType,
            `${eventType} event handled successfully`,
            {
              status: "success",
              details: { handler: handler.constructor.name, attempt: attempt + 1 },
            }
          )

          break // Success, exit retry loop
        } catch (error) {
          lastError = error as Error
          console.error(
            `[v0] [WorkflowEventHandler] Handler error (attempt ${attempt + 1}/${this.config.maxRetries + 1}):`,
            error
          )

          if (attempt < this.config.maxRetries) {
            // Wait before retrying
            await new Promise((resolve) =>
              setTimeout(resolve, this.config.retryDelayMs * (attempt + 1))
            )
          }
        }
      }

      // If all retries failed, log and call error callback
      if (lastError) {
        await WorkflowLogger.logEvent(
          connectionId,
          eventType,
          `${eventType} event failed after ${this.config.maxRetries + 1} attempts`,
          {
            status: "failed",
            details: {
              handler: handler.constructor.name,
              error: lastError.message,
            },
          }
        )

        if (this.config.onError) {
          try {
            await this.config.onError(lastError, connectionId, eventType)
          } catch (err) {
            console.error("[v0] [WorkflowEventHandler] Error in onError callback:", err)
          }
        }
      }
    }
  }

  /**
   * Get all registered handlers for an event type
   */
  getHandlers(eventType: WorkflowEventType): WorkflowEventSubscriber[] {
    return this.handlers.get(eventType) || []
  }

  /**
   * Get all registered event types
   */
  getEventTypes(): WorkflowEventType[] {
    return Array.from(this.handlers.keys())
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clearHandlers(): void {
    this.handlers.clear()
    console.log("[v0] [WorkflowEventHandler] All handlers cleared")
  }
}

// Global instance
let globalWorkflowHandler: WorkflowEventHandler | null = null

export function getGlobalWorkflowEventHandler(): WorkflowEventHandler {
  if (!globalWorkflowHandler) {
    globalWorkflowHandler = new WorkflowEventHandler({
      maxRetries: 3,
      retryDelayMs: 1000,
      timeoutMs: 30000,
      onError: async (error, connectionId, eventType) => {
        console.error(
          `[v0] [WorkflowEventHandler] Critical error in ${eventType} for ${connectionId}:`,
          error.message
        )
      },
    })
  }
  return globalWorkflowHandler
}
