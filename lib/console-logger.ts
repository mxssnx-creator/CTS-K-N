/**
 * Console Logger - Intercepts console.log, console.warn, console.error
 * and captures them to Redis for the logs viewer
 */
import { getRedisClient } from "./redis-db"

let initialized = false

export function initializeConsoleLogger() {
  if (initialized) return
  initialized = true

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  // Intercept console.log
  console.log = function (...args: any[]) {
    originalLog.apply(console, args)
    captureLog("info", args)
  }

  // Intercept console.warn
  console.warn = function (...args: any[]) {
    originalWarn.apply(console, args)
    captureLog("warn", args)
  }

  // Intercept console.error
  console.error = function (...args: any[]) {
    originalError.apply(console, args)
    captureLog("error", args)
  }
}

async function captureLog(level: "info" | "warn" | "error", args: any[]) {
  try {
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        }
        return String(arg)
      })
      .join(" ")

    // Extract category from message (e.g., "[v0] [Category] ...")
    let category = "app"
    const categoryMatch = message.match(/\[v0\]\s*\[([^\]]+)\]/)
    if (categoryMatch) {
      category = categoryMatch[1].toLowerCase().replace(/\s+/g, "_")
    }

    // Only capture logs that start with [v0] to avoid noise
    if (!message.includes("[v0]")) {
      return
    }

    const client = getRedisClient()
    const logId = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`

    const logEntry = {
      id: logId,
      timestamp: new Date().toISOString(),
      level,
      category,
      message: message.substring(0, 1000), // Limit message length
      metadata: "",
    }

    // Store in Redis with bounded lists (not unbounded sets) to prevent endless growth
    await client.hset(logId, logEntry)
    await client.lpush("logs:all:list", logId)
    await client.ltrim("logs:all:list", 0, 4999) // Keep max 5000
    await client.lpush(`logs:${category}:list`, logId)
    await client.ltrim(`logs:${category}:list`, 0, 999) // Keep max 1000 per category
    await client.expire(logId, 604800) // 7 days TTL
  } catch (error) {
    // Silently fail to avoid infinite loops
  }
}
