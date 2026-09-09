/**
 * Console Logger - Intercepts console.log, console.warn, console.error
 * and captures them to Redis for the logs viewer
 */
import { SystemLogger } from "./system-logger"
import { serializeLogValue } from "./log-payload"

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
    const message = args.slice(0, 12).map(arg => typeof arg === "string" ? arg.slice(0, 2_000) : serializeLogValue(arg)).join(" ").slice(0, 2_000)

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

    await SystemLogger.logToDatabase({ timestamp: new Date().toISOString(), level, category, message })
  } catch (error) {
    // Silently fail to avoid infinite loops
  }
}
