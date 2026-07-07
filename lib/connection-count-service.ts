/**
 * Connection Count Service
 * Single source of truth for connection counts
 * PHASE 2 FIX: Centralized counting to fix inconsistencies
 */

import { getAllConnections, getSettings } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export interface ConnectionCounts {
  base: {
    total: number
    enabled: number
    working: number
  }
  main: {
    total: number
    enabled: number
    processing: number
  }
  last_updated: string
}

/**
 * Get accurate connection counts across base and main
 * PHASE 2 FIX: Single source of truth for all connection count queries
 */
export async function getConnectionCounts(): Promise<ConnectionCounts> {
  try {
    const allConnections = await getAllConnections()

    // BASE CONNECTIONS (Settings panel)
    // Total: All connections in the system
    const baseTotal = allConnections.length

    // Enabled: Connections that are inserted AND enabled in settings
    const baseEnabled = allConnections.filter((c: any) => {
      const isInserted = c.is_inserted === "1" || c.is_inserted === true
      const isEnabled = c.is_enabled === "1" || c.is_enabled === true
      return isInserted && isEnabled
    }).length

    // Working: Enabled connections with last_test_status === "success"
    const baseWorking = allConnections.filter((c: any) => {
      const isInserted = c.is_inserted === "1" || c.is_inserted === true
      const isEnabled = c.is_enabled === "1" || c.is_enabled === true
      return isInserted && isEnabled && c.last_test_status === "success"
    }).length

    // MAIN CONNECTIONS (Dashboard panel)
    // Total: Connections assigned to main
    const mainAssigned = allConnections.filter((c: any) => {
      return c.is_assigned === "1" || c.is_assigned === true
    })
    const mainTotal = mainAssigned.length

    // Enabled: Connections that are assigned AND dashboard-enabled
    const mainEnabled = mainAssigned.filter((c: any) => {
      const isDashboardEnabled = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
      return isDashboardEnabled
    }).length

    // Processing: Connections that are enabled AND engine is running
    let processing = 0
    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      for (const conn of mainEnabled > 0 ? mainAssigned.filter((c: any) => {
        const isDashboardEnabled = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
        return isDashboardEnabled
      }) : []) {
        if (coordinator.isEngineRunning(conn.id)) {
          processing++
        }
      }
    } catch (e) {
      console.warn("[v0] [ConnectionCountService] Failed to check engine running state:", e)
    }

    return {
      base: {
        total: baseTotal,
        enabled: baseEnabled,
        working: baseWorking,
      },
      main: {
        total: mainTotal,
        enabled: mainEnabled,
        processing,
      },
      last_updated: new Date().toISOString(),
    }
  } catch (error) {
    console.error("[v0] [ConnectionCountService] Error getting counts:", error)

    // Return safe defaults on error
    return {
      base: { total: 0, enabled: 0, working: 0 },
      main: { total: 0, enabled: 0, processing: 0 },
      last_updated: new Date().toISOString(),
    }
  }
}

/**
 * Get main enabled connections (for quick queries)
 */
export async function getMainEnabledConnections() {
  try {
    const allConnections = await getAllConnections()
    return allConnections.filter((c: any) => {
      const isAssigned = c.is_assigned === "1" || c.is_assigned === true
      const isDashboardEnabled = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
      return isAssigned && isDashboardEnabled
    })
  } catch (error) {
    console.error("[v0] [ConnectionCountService] Error getting main enabled connections:", error)
    return []
  }
}

/**
 * Get base enabled connections (for quick queries)
 */
export async function getBaseEnabledConnections() {
  try {
    const allConnections = await getAllConnections()
    return allConnections.filter((c: any) => {
      const isInserted = c.is_inserted === "1" || c.is_inserted === true
      const isEnabled = c.is_enabled === "1" || c.is_enabled === true
      return isInserted && isEnabled
    })
  } catch (error) {
    console.error("[v0] [ConnectionCountService] Error getting base enabled connections:", error)
    return []
  }
}
