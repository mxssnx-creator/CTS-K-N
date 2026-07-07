/**
 * Error Logger - Redis-native
 * Logs errors, info, warnings and debug messages to Redis
 */

import { initRedis, getRedisClient, setSettings } from "@/lib/redis-db"

interface ErrorLogOptions {
  category?: string
  userId?: string
  connectionId?: string
  metadata?: Record<string, any>
  severity?: "low" | "medium" | "high" | "critical"
}

export class ErrorLogger {
  private static async writeLog(level: string, category: string, message: string, extra: Record<string, any> = {}): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const logEntry = {
        level,
        category,
        message,
        timestamp: new Date().toISOString(),
        ...extra,
      }

      await setSettings(`site_log:${logId}`, logEntry)
      
      // Store in Redis lists instead of sorted sets (Upstash doesn't support zadd)
      const allLogsKey = "site_logs:all"
      const levelLogsKey = `site_logs:${level}`
      
      let allLogs: string[] = []
      let levelLogs: string[] = []
      
      const existingAll = await client.get(allLogsKey)
      if (existingAll) {
        try { allLogs = JSON.parse(existingAll) } catch { allLogs = [] }
      }
      
      const existingLevel = await client.get(levelLogsKey)
      if (existingLevel) {
        try { levelLogs = JSON.parse(existingLevel) } catch { levelLogs = [] }
      }
      
      // Prepend new entry
      allLogs.unshift(logId)
      levelLogs.unshift(logId)
      
      // Trim to max 1000 entries
      if (allLogs.length > 1000) allLogs = allLogs.slice(0, 1000)
      if (levelLogs.length > 1000) levelLogs = levelLogs.slice(0, 1000)
      
      // Remove old entries from individual log storage
      const toRemove = allLogs.slice(1000)
      for (const oldId of toRemove) {
        await client.del(`site_log:${oldId}`)
      }
      
      await client.set(allLogsKey, JSON.stringify(allLogs))
      await client.set(levelLogsKey, JSON.stringify(levelLogs))
    } catch (logError) {
      console.error("[v0] Failed to write log to Redis:", logError)
    }
  }

  static async logError(error: Error | unknown, context: string, options: ErrorLogOptions = {}): Promise<void> {
    const { category = "API", userId, connectionId, metadata = {}, severity = "medium" } = options
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    console.error(`[v0] Error in ${context}:`, { message: errorMessage, category, severity })

    await this.writeLog("error", category, `${context}: ${errorMessage}`, {
      context,
      user_id: userId || null,
      connection_id: connectionId || null,
      error_message: errorMessage,
      error_stack: errorStack || null,
      metadata: { ...metadata, severity },
    })
  }

  static async logInfo(message: string, context: string, metadata: Record<string, any> = {}): Promise<void> {
    console.log(`[v0] Info in ${context}:`, message)
    await this.writeLog("info", "system", `${context}: ${message}`, { context, metadata })
  }

  static async logWarning(message: string, context: string, metadata: Record<string, any> = {}): Promise<void> {
    console.warn(`[v0] Warning in ${context}:`, message)
    await this.writeLog("warn", "system", `${context}: ${message}`, { context, metadata })
  }

  static async logDebug(message: string, context: string, metadata: Record<string, any> = {}): Promise<void> {
    if (process.env.NODE_ENV === "development") {
      console.debug(`[v0] Debug in ${context}:`, message)
    }
    await this.writeLog("debug", "system", `${context}: ${message}`, { context, metadata })
  }
}
