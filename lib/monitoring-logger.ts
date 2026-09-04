/**
 * Monitoring Logger - Redis-native
 * Logs monitoring events to Redis sorted sets
 */

import { initRedis, getRedisClient, setSettings } from "@/lib/redis-db"

export type MonitoringCategory = "system" | "web" | "trading" | "database" | "connection" | "strategy" | "api"
export type MonitoringLevel = "info" | "warn" | "error" | "debug"

interface MonitoringLogOptions {
  category: MonitoringCategory
  level: MonitoringLevel
  message: string
  details?: string
  stack?: string
  metadata?: Record<string, any>
}

export class MonitoringLogger {
  static async log(options: MonitoringLogOptions): Promise<void> {
    const { category, level, message, details, stack, metadata } = options

    console.log(`[v0] [${category.toUpperCase()}] [${level.toUpperCase()}] ${message}`)

    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      await setSettings(`monitor_log:${logId}`, {
        level,
        category,
        message,
        details: details || null,
        stack: stack || null,
        metadata: metadata || null,
        timestamp: new Date().toISOString(),
      })

      // Store in Redis lists instead of sorted sets (Upstash doesn't support zadd)
      const allLogsKey = "monitor_logs:all"
      const categoryLogsKey = `monitor_logs:${category}`
      
      let allLogs: string[] = []
      let categoryLogs: string[] = []
      
      const existingAll = await client.get(allLogsKey)
      if (existingAll) {
        try { allLogs = JSON.parse(existingAll) } catch { allLogs = [] }
      }
      
      const existingCat = await client.get(categoryLogsKey)
      if (existingCat) {
        try { categoryLogs = JSON.parse(existingCat) } catch { categoryLogs = [] }
      }
      
      // Prepend new entry and remove payload hashes that fall out of the
      // shared 1000-row diagnostic window. The previous JSON-list cap left an
      // unbounded settings:monitor_log:* hash for every discarded id.
      allLogs.unshift(logId)
      categoryLogs.unshift(logId)
      const expiredLogIds = allLogs.slice(1000)
      allLogs = allLogs.slice(0, 1000)
      categoryLogs = categoryLogs.slice(0, 1000)
      
      await client.set(allLogsKey, JSON.stringify(allLogs))
      await client.set(categoryLogsKey, JSON.stringify(categoryLogs))
      await client.expire(`settings:monitor_log:${logId}`, 7 * 24 * 60 * 60)
      for (const expiredLogId of new Set(expiredLogIds)) {
        await client.del(`settings:monitor_log:${expiredLogId}`).catch(() => undefined)
      }
    } catch (error) {
      console.error("[v0] Failed to write to monitoring log:", error)
    }
  }

  static async logSystem(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "system", level, message, details, metadata })
  }

  static async logWeb(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "web", level, message, details, metadata })
  }

  static async logTrading(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "trading", level, message, details, metadata })
  }

  static async logDatabase(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "database", level, message, details, metadata })
  }

  static async logConnection(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "connection", level, message, details, metadata })
  }

  static async logStrategy(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "strategy", level, message, details, metadata })
  }

  static async logApi(level: MonitoringLevel, message: string, details?: string, metadata?: Record<string, any>) {
    await this.log({ category: "api", level, message, details, metadata })
  }

  static async logError(category: MonitoringCategory, error: Error | unknown, context: string, metadata?: Record<string, any>) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined
    await this.log({ category, level: "error", message: `${context}: ${errorMessage}`, details: context, stack: errorStack, metadata })
  }
}
