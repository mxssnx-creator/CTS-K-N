import DatabaseManager from "./database"

export type LogLevel = "info" | "warn" | "error" | "debug"
export type LogCategory =
  | "system"
  | "trading"
  | "strategy"
  | "connection"
  | "indication"
  | "database"
  | "api"
  | "nextjs"
  | "build"
  | "runtime"

interface SiteLogEntry {
  level: LogLevel
  category: string
  message: string
  details?: string
  stack?: string
  metadata?: Record<string, any>
}

class Logger {
  private static instance: Logger
  private db: typeof DatabaseManager

  private constructor() {
    this.db = DatabaseManager.getInstance()
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger()
    }
    return Logger.instance
  }

  public async log(level: LogLevel, category: LogCategory, message: string, details?: any) {
    // Console output
    const timestamp = new Date().toISOString()
    const detailsStr = details ? JSON.stringify(details) : ""
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}`, detailsStr)

    // Database storage
    try {
      await this.db.insertLog(level, category, message, detailsStr)
    } catch (error) {
      console.error("Failed to write log to database:", error)
    }
  }

  public async info(category: LogCategory, message: string, details?: any) {
    await this.log("info", category, message, details)
  }

  public async warn(category: LogCategory, message: string, details?: any) {
    await this.log("warn", category, message, details)
  }

  public async error(category: LogCategory, message: string, error?: Error, context?: any) {
    await this.log("error", category, message, { error: error?.message, context })

    // Also store in errors table
    try {
      await this.db.insertError(
        error?.name || "Error",
        message,
        error?.stack,
        context ? JSON.stringify(context) : undefined,
      )
    } catch (err) {
      console.error("Failed to write error to database:", err)
    }
  }

  public async debug(category: LogCategory, message: string, details?: any) {
    await this.log("debug", category, message, details)
  }

  public async logSite(entry: SiteLogEntry) {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [SITE] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}`)

    try {
      const databaseUrl = process.env.DATABASE_URL || process.env.REMOTE_POSTGRES_URL || ""
      const isPostgreSQL = databaseUrl.startsWith("postgresql://")

      if (isPostgreSQL) {
        await this.db.executeQuery(
          `INSERT INTO site_logs (level, category, message, details, stack, metadata, timestamp) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            entry.level,
            entry.category,
            entry.message,
            entry.details || null,
            entry.stack || null,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
          ],
        )
      } else {
        await this.db.executeQuery(
          `INSERT INTO site_logs (level, category, message, details, stack, metadata, timestamp) 
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          [
            entry.level,
            entry.category,
            entry.message,
            entry.details || null,
            entry.stack || null,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
          ],
        )
      }
    } catch (error) {
      console.error("[v0] Failed to write site log to database:", error)
    }
  }

  public async logNextError(error: Error, context?: { route?: string; method?: string; userId?: string }) {
    await this.logSite({
      level: "error",
      category: "nextjs",
      message: error.message,
      stack: error.stack,
      metadata: {
        name: error.name,
        ...context,
        timestamp: new Date().toISOString(),
      },
    })
  }

  public async logBuildError(message: string, details?: any) {
    await this.logSite({
      level: "error",
      category: "build",
      message,
      details: typeof details === "string" ? details : JSON.stringify(details),
    })
  }

  public async logRuntimeError(error: Error, context?: Record<string, any>) {
    await this.logSite({
      level: "error",
      category: "runtime",
      message: error.message,
      stack: error.stack,
      metadata: {
        name: error.name,
        ...context,
      },
    })
  }
}

export default Logger
