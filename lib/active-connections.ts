/**
 * Active Connections Manager
 * Handles connections actively in use for trading (INDEPENDENT from Settings)
 * Uses Redis as single source of truth (via is_enabled_dashboard field)
 *
 * TERMINOLOGY:
 * - These are called "Active Connections" or "Actively Using" connections
 * - NOT called "Dashboard Connections" to avoid confusion
 *
 * INDEPENDENCE GUARANTEE:
 * - Toggling an Active connection does NOT affect Settings connections
 * - Settings connections status (is_enabled) is COMPLETELY INDEPENDENT
 * - Each has its own toggle/state system managed separately
 */

import { initRedis, getAllConnections, getConnection, updateConnection } from "@/lib/redis-db"
import { BASE_EXCHANGES } from "@/lib/connection-utils"

export interface ActiveConnection {
  id: string
  connectionId: string
  exchangeName: string
  isActive: boolean       // Maps to is_enabled_dashboard (Active/Dashboard toggle, INDEPENDENT)
  isBaseEnabled: boolean  // Maps to is_enabled (Settings base enabled, read-only here)
  addedAt: string
}

/**
 * Load connections for the Active Connections list on the Dashboard.
 * Shows:
 * - ALL inserted base connections (is_inserted=1) -- always visible as cards
 * - ANY connection with is_enabled_dashboard=1 -- user-activated connections
 * isActive = is_enabled_dashboard (the active toggle, independent from Settings)
 */
// Only bingx is shown in main connections by default.
// Bybit can still be added manually but is no longer auto-default.
const MAIN_DEFAULT_EXCHANGES = ["bingx"]

export async function loadActiveConnections(): Promise<ActiveConnection[]> {
  try {
    await initRedis()
    const allConnections = await getAllConnections()

    const activeConnections: ActiveConnection[] = []
    const seenIds = new Set<string>()

    for (const conn of allConnections) {
      const exchange = (conn.exchange || "").toLowerCase().trim()
      const isInserted = conn.is_inserted === true || conn.is_inserted === "1" || conn.is_inserted === "true"
      const isDashboardActive = conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "1" || conn.is_enabled_dashboard === "true"
      const isSettingsEnabled = conn.is_enabled === true || conn.is_enabled === "1" || conn.is_enabled === "true"
      const isBase = BASE_EXCHANGES.includes(exchange)
      const isMainDefault = MAIN_DEFAULT_EXCHANGES.includes(exchange)

      // Show if: it's a main default exchange (bingx), OR it's dashboard-active (user added)
      if ((isBase && isMainDefault) || isDashboardActive) {
        const canonId = conn.id.replace(/^conn-/, "")
        if (seenIds.has(canonId)) continue
        seenIds.add(canonId)

        activeConnections.push({
          id: `active-${canonId}`,
          // Always expose the canonical id used by progression/status APIs.
          // Legacy `conn-*` aliases do not have matching progression hashes.
          connectionId: canonId,
          exchangeName: conn.exchange.charAt(0).toUpperCase() + conn.exchange.slice(1),
          isActive: isDashboardActive,
          isBaseEnabled: isSettingsEnabled,
          addedAt: conn.created_at || new Date().toISOString(),
        })
      }
    }

    console.log(`[v0] [ActiveConnections] Loaded ${activeConnections.length} connections (${activeConnections.filter(c => c.isActive).length} active)`)
    return activeConnections
  } catch (error) {
    console.error("[v0] Error loading active connections from Redis:", error)
    return getDefaultActiveConnections()
  }
}

export async function saveActiveConnections(connections: ActiveConnection[]): Promise<void> {
  try {
    await initRedis()

    for (const ac of connections) {
      try {
        const connection = await getConnection(ac.connectionId)
        if (connection) {
          // Save is_enabled_dashboard (Dashboard active state) - NOT is_enabled
          await updateConnection(ac.connectionId, { is_enabled_dashboard: ac.isActive ? "1" : "0" })
        }
      } catch (e) {
        console.warn(`[v0] [ActiveConnections] Could not update ${ac.connectionId}:`, e)
      }
    }
  } catch (error) {
    console.error("[v0] Error saving active connections to Redis:", error)
  }
}

export async function addActiveConnection(connectionId: string, exchangeName: string): Promise<ActiveConnection> {
  try {
    await initRedis()

    console.log(`[v0] [ActiveConnections] Adding connection ${connectionId} (${exchangeName}) to active list`)

    // Use getAllConnections (which is proven reliable) instead of getConnection
    let connection = null
    
    // First try getConnection directly
    connection = await getConnection(connectionId)
    
    // Fallback: search through getAllConnections if direct lookup fails
    if (!connection) {
      console.log(`[v0] [ActiveConnections] Direct lookup failed for ${connectionId}, falling back to getAllConnections`)
      const allConnections = await getAllConnections()
      console.log(`[v0] [ActiveConnections] getAllConnections returned ${allConnections.length} connections`)
      connection = allConnections.find((c: any) => c.id === connectionId)
      
      if (connection) {
        console.log(`[v0] [ActiveConnections] Found ${connectionId} via getAllConnections fallback`)
      }
    }
    
    if (!connection) {
      console.error(`[v0] [ActiveConnections] Connection ${connectionId} not found in Redis at all`)
      throw new Error(`Connection ${connectionId} not found in database`)
    }

    console.log(`[v0] [ActiveConnections] Setting is_enabled_dashboard=1 for ${connectionId}`)
    await updateConnection(connectionId, { is_enabled_dashboard: "1" })
    console.log(`[v0] [ActiveConnections] Successfully added ${connectionId} to active list`)

    return {
      id: `active-${connectionId}`,
      connectionId,
      exchangeName,
      isActive: true, // We just set is_enabled_dashboard = "1"
      isBaseEnabled: connection.is_enabled === true || connection.is_enabled === "1" || connection.is_enabled === "true",
      addedAt: connection.created_at || new Date().toISOString(),
    }
  } catch (error) {
    console.error("[v0] Error adding active connection:", error)
    throw error
  }
}

export async function removeActiveConnection(connectionId: string): Promise<void> {
  try {
    await initRedis()

    let connection = await getConnection(connectionId)
    if (!connection) {
      const all = await getAllConnections()
      connection = all.find((c: any) => c.id === connectionId)
    }
    if (connection) {
      await updateConnection(connectionId, { is_enabled_dashboard: "0" })
    }
  } catch (error) {
    console.error("[v0] Error removing active connection:", error)
    throw error
  }
}

/**
 * Toggle is_enabled_dashboard (Active/Dashboard toggle) - INDEPENDENT from Settings is_enabled
 */
export async function toggleActiveConnection(connectionId: string, isActive: boolean): Promise<void> {
  try {
    await initRedis()

    let connection = await getConnection(connectionId)
    if (!connection) {
      const all = await getAllConnections()
      connection = all.find((c: any) => c.id === connectionId)
    }
    if (connection) {
      // Toggle is_enabled_dashboard (Dashboard active state) - NOT is_enabled (Settings state)
      await updateConnection(connectionId, { is_enabled_dashboard: isActive ? "1" : "0" })
      console.log(`[v0] [ActiveConnections] Toggled ${connectionId} active: ${isActive}`)
    }
  } catch (error) {
    console.error("[v0] Error toggling active connection:", error)
    throw error
  }
}

function getDefaultActiveConnections(): ActiveConnection[] {
  const now = new Date().toISOString()
  return [
    { id: "active-bingx-x01", connectionId: "bingx-x01", exchangeName: "BingX", isActive: false, isBaseEnabled: true, addedAt: now },
  ]
}
