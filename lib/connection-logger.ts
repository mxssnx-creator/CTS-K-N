/**
 * Connection Logger Service
 * Tracks connection-specific logs, errors, and warnings
 */

interface LogEntry {
  timestamp: string
  level: "info" | "error" | "warning" | "debug"
  message: string
  connectionId: string
}

const logStore = new Map<string, LogEntry[]>()
const maxLogsPerConnection = 100

export const ConnectionLogger = {
  log(connectionId: string, level: "info" | "error" | "warning" | "debug", message: string) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      connectionId,
    }

    if (!logStore.has(connectionId)) {
      logStore.set(connectionId, [])
    }

    const logs = logStore.get(connectionId)!
    logs.push(entry)

    // Keep only the last N logs
    if (logs.length > maxLogsPerConnection) {
      logs.shift()
    }

    // Log to console as well
    console.log(`[v0] [${connectionId}] [${level.toUpperCase()}] ${message}`)
  },

  getLogs(connectionId: string, limit?: number): LogEntry[] {
    const logs = logStore.get(connectionId) || []
    if (limit) {
      return logs.slice(-limit)
    }
    return logs
  },

  getErrors(connectionId: string): string[] {
    return (logStore.get(connectionId) || [])
      .filter((log) => log.level === "error")
      .map((log) => log.message)
  },

  getWarnings(connectionId: string): string[] {
    return (logStore.get(connectionId) || [])
      .filter((log) => log.level === "warning")
      .map((log) => log.message)
  },

  clearLogs(connectionId: string) {
    logStore.delete(connectionId)
  },

  clearAllLogs() {
    logStore.clear()
  },
}
