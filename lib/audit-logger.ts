/**
 * Audit Logger - Trading Compliance & Security
 * Logs all critical trading operations for compliance and forensic analysis
 */

import { getSettings, setSettings } from "./redis-db"

export interface AuditLog {
  id: string
  timestamp: string
  user_id: string
  action: "order_create" | "order_cancel" | "order_fill" | "position_open" | "position_close" | "strategy_start" | "strategy_stop" | "connection_test"
  entity_type: "order" | "position" | "strategy" | "connection"
  entity_id: string
  details: Record<string, any>
  status: "success" | "failed"
  error?: string
  connection_id?: string
  ip_address?: string
}

class AuditLogger {
  async log(auditLog: Omit<AuditLog, "id" | "timestamp">): Promise<void> {
    try {
      const log: AuditLog = {
        ...auditLog,
        id: `audit:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
      }

      // Get existing logs
      const logs = (await getSettings("audit_logs")) || []

      // Keep last 10,000 logs (rotate)
      if (logs.length >= 10000) {
        logs.shift()
      }

      logs.push(log)
      await setSettings("audit_logs", logs)

      // Also log to console for immediate visibility
      if (auditLog.status === "failed") {
        console.error(
          `[v0] [Audit] ${auditLog.action} by ${auditLog.user_id}: ${auditLog.entity_id} - ${auditLog.status}`
        )
      } else {
        console.info(`[v0] [Audit] ${auditLog.action} by ${auditLog.user_id}: ${auditLog.entity_id} - ${auditLog.status}`)
      }
    } catch (error) {
      console.error("[v0] Failed to write audit log:", error)
    }
  }

  async getLogsForUser(user_id: string, limit: number = 100): Promise<AuditLog[]> {
    try {
      const logs = (await getSettings("audit_logs")) || []
      return logs
        .filter((log: AuditLog) => log.user_id === user_id)
        .slice(-limit)
        .reverse()
    } catch (error) {
      console.error("[v0] Failed to retrieve audit logs:", error)
      return []
    }
  }

  async getLogsForConnection(connection_id: string, limit: number = 100): Promise<AuditLog[]> {
    try {
      const logs = (await getSettings("audit_logs")) || []
      return logs
        .filter((log: AuditLog) => log.connection_id === connection_id)
        .slice(-limit)
        .reverse()
    } catch (error) {
      console.error("[v0] Failed to retrieve connection logs:", error)
      return []
    }
  }

  async exportLogs(filters?: { user_id?: string; start_date?: Date; end_date?: Date }): Promise<AuditLog[]> {
    try {
      let logs = (await getSettings("audit_logs")) || []

      if (filters?.user_id) {
        logs = logs.filter((log: AuditLog) => log.user_id === filters.user_id)
      }

      if (filters?.start_date) {
        const startTime = new Date(filters.start_date).getTime()
        logs = logs.filter((log: AuditLog) => new Date(log.timestamp).getTime() >= startTime)
      }

      if (filters?.end_date) {
        const endTime = new Date(filters.end_date).getTime()
        logs = logs.filter((log: AuditLog) => new Date(log.timestamp).getTime() <= endTime)
      }

      return logs
    } catch (error) {
      console.error("[v0] Failed to export audit logs:", error)
      return []
    }
  }
}

export const auditLogger = new AuditLogger()
