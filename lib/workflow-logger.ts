import { getRedisClient, initRedis } from "./redis-db"

export type WorkflowEventType =
  | "engine_start"
  | "engine_stop"
  | "engine_error"
  | "indication_check"
  | "indication_signal"
  | "strategy_evaluate"
  | "strategy_execute"
  | "order_place"
  | "order_fill"
  | "order_cancel"
  | "position_open"
  | "position_close"
  | "position_modify"
  | "trade_entry"
  | "trade_exit"
  | "progression_cycle"
  | "pseudo_position_update"

export interface WorkflowLogEntry {
  id: string
  timestamp: number
  connectionId: string
  eventType: WorkflowEventType
  symbol?: string
  status: "success" | "pending" | "failed" | "warning"
  message: string
  details?: Record<string, any>
  duration?: number
}

export class WorkflowLogger {
  private static readonly MAX_LOGS_PER_CONNECTION = 1000
  private static readonly LOG_RETENTION_DAYS = 7

  /**
   * Log a workflow event with structured data
   */
  static async logEvent(
    connectionId: string,
    eventType: WorkflowEventType,
    message: string,
    options: {
      symbol?: string
      status?: "success" | "pending" | "failed" | "warning"
      details?: Record<string, any>
      duration?: number
    } = {}
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      const logEntry: WorkflowLogEntry = {
        id: `${connectionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: Date.now(),
        connectionId,
        eventType,
        symbol: options.symbol,
        status: options.status || "success",
        message,
        details: options.details,
        duration: options.duration,
      }

      const logKey = `workflow_logs:${connectionId}`
      const logsJson = JSON.stringify(logEntry)

      // Store in Redis list using lpush for efficient prepend
      // Using Redis list (not sorted set) for better Upstash compatibility
      await client.lpush(logKey, logsJson)
      
      // Trim to max entries
      await client.ltrim(logKey, 0, this.MAX_LOGS_PER_CONNECTION - 1)
      
      // Set TTL for auto-expiration (7 days)
      // Note: Upstash Redis DOES support expire
      await client.expire(logKey, this.LOG_RETENTION_DAYS * 24 * 60 * 60)

      // Also log to console with structured format
      const levelEmoji = {
        success: "✓",
        pending: "⏳",
        failed: "✗",
        warning: "⚠",
      }[logEntry.status]

      const symbol = logEntry.symbol ? ` [${logEntry.symbol}]` : ""
      const duration = logEntry.duration ? ` (${logEntry.duration}ms)` : ""

      console.log(
        `[v0] [${eventType.toUpperCase()}] ${levelEmoji} ${message}${symbol}${duration}`,
        logEntry.details ? logEntry.details : ""
      )
    } catch (error) {
      console.error("[v0] [WorkflowLogger] Error logging event:", error)
    }
  }

  /**
   * Get workflow logs for a connection
   */
  static async getLogs(
    connectionId: string,
    limit: number = 100,
    eventType?: WorkflowEventType
  ): Promise<WorkflowLogEntry[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      const logKey = `workflow_logs:${connectionId}`
      // Use lrange to get logs from Redis list (newest first via lrange 0 to limit-1)
      const logsJson = await client.lrange(logKey, 0, limit - 1)

      let logs: WorkflowLogEntry[] = logsJson.map((log: string) =>
        JSON.parse(log)
      )

      if (eventType) {
        logs = logs.filter((log) => log.eventType === eventType)
      }

      return logs
    } catch (error) {
      console.error("[v0] [WorkflowLogger] Error retrieving logs:", error)
      return []
    }
  }

  /**
   * Get workflow statistics for a connection
   */
  static async getStats(
    connectionId: string,
    timeWindowMs: number = 3600000 // 1 hour default
  ): Promise<Record<string, any>> {
    try {
      const logs = await this.getLogs(connectionId, 1000)
      const now = Date.now()
      const cutoff = now - timeWindowMs

      const recentLogs = logs.filter((log) => log.timestamp >= cutoff)

      const stats = {
        total_events: recentLogs.length,
        success_count: recentLogs.filter((l) => l.status === "success").length,
        failed_count: recentLogs.filter((l) => l.status === "failed").length,
        warning_count: recentLogs.filter((l) => l.status === "warning").length,
        pending_count: recentLogs.filter((l) => l.status === "pending").length,
        avg_duration_ms:
          recentLogs.reduce((sum, log) => sum + (log.duration || 0), 0) /
          Math.max(1, recentLogs.length),
        events_by_type: {} as Record<string, number>,
        time_window_ms: timeWindowMs,
      }

      // Count by event type
      recentLogs.forEach((log) => {
        stats.events_by_type[log.eventType] =
          (stats.events_by_type[log.eventType] || 0) + 1
      })

      return stats
    } catch (error) {
      console.error("[v0] [WorkflowLogger] Error getting stats:", error)
      return {}
    }
  }

  /**
   * Clear logs for a connection
   */
  static async clearLogs(connectionId: string): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      const logKey = `workflow_logs:${connectionId}`
      await (client as any).del(logKey)

      console.log(`[v0] [WorkflowLogger] Cleared logs for ${connectionId}`)
    } catch (error) {
      console.error("[v0] [WorkflowLogger] Error clearing logs:", error)
    }
  }

  /**
   * Log engine lifecycle events
   */
  static async logEngineEvent(
    connectionId: string,
    event: "start" | "stop" | "error",
    message: string,
    details?: Record<string, any>
  ): Promise<void> {
    const eventType = `engine_${event}` as WorkflowEventType
    await this.logEvent(connectionId, eventType, message, {
      status: event === "error" ? "failed" : "success",
      details,
    })
  }

  /**
   * Log trade entry/exit events
   */
  static async logTradeEvent(
    connectionId: string,
    symbol: string,
    event: "entry" | "exit",
    details: {
      side?: "long" | "short"
      quantity?: number
      entryPrice?: number
      exitPrice?: number
      pnl?: number
      reason?: string
    }
  ): Promise<void> {
    const eventType = `trade_${event}` as WorkflowEventType
    await this.logEvent(connectionId, eventType, `Trade ${event} on ${symbol}`, {
      symbol,
      status: "success",
      details,
    })
  }

  /**
   * Log indication signal detections
   */
  static async logIndicationSignal(
    connectionId: string,
    symbol: string,
    indication: string,
    signal: "buy" | "sell" | "neutral",
    strength?: number
  ): Promise<void> {
    await this.logEvent(
      connectionId,
      "indication_signal",
      `${indication} signal: ${signal}`,
      {
        symbol,
        status: "success",
        details: { indication, signal, strength: strength || 0 },
      }
    )
  }

  /**
   * Log progression cycle events
   */
  static async logProgressionCycle(
    connectionId: string,
    cycleNumber: number,
    duration: number,
    result: "success" | "partial" | "failed",
    details?: Record<string, any>
  ): Promise<void> {
    await this.logEvent(
      connectionId,
      "progression_cycle",
      `Progression cycle #${cycleNumber} completed`,
      {
        status: result === "failed" ? "failed" : "success",
        duration,
        details: { cycle_number: cycleNumber, result, ...details },
      }
    )
  }

  /**
   * Log pseudo position updates
   */
  static async logPseudoPositionUpdate(
    connectionId: string,
    symbol: string,
    action: "created" | "updated" | "closed",
    details: Record<string, any>
  ): Promise<void> {
    await this.logEvent(
      connectionId,
      "pseudo_position_update",
      `Pseudo position ${action}: ${symbol}`,
      {
        symbol,
        status: "success",
        details,
      }
    )
  }
}
