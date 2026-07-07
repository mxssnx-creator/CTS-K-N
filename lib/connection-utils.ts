/**
 * CONNECTION HIERARCHY:
 * 1. PREDEFINED TEMPLATES (11 total): All connections seeded by migrations
 * 2. BASE CONNECTIONS (4): Primary exchanges with is_inserted=1, is_enabled=1
 *    - These are the working base connections that appear in Settings and Dashboard
 * 3. TEMPLATE-ONLY (5): Secondary exchanges (gateio, kucoin, mexc, bitget, huobi)
 *    - Just informational templates, not active unless user explicitly enables them
 * 4. ACTIVE CONNECTIONS: Connections with is_enabled_dashboard=1
 *    - INDEPENDENT status from Settings is_enabled
 *    - Trade engine processes ONLY active connections
 */

// The 4 primary/base exchanges that are inserted in Settings by default.
// Dashboard activation remains OFF until explicitly enabled.
// Main/default exchange set for dashboard assignment handling.
// Keep this limited to bybit + bingx to avoid auto-reassignment drift.
export const BASE_EXCHANGES = ["bybit", "bingx"]

// All known exchanges (base + templates)
export const ALL_EXCHANGES = ["bybit", "bingx", "binance", "okx", "pionex", "orangex", "gateio", "kucoin", "mexc", "bitget", "huobi"]

/**
 * Check if a connection is a BASE connection (one of the 4 primary exchanges)
 * Uses the `exchange` field for reliable matching regardless of is_inserted state
 */
export function isBaseConnection(connection: any): boolean {
  if (!connection) return false
  const exchange = (connection.exchange || "").toLowerCase().trim()
  return BASE_EXCHANGES.includes(exchange)
}

/**
 * Check if a connection is a template-only connection (NOT a base connection)
 */
export function isTemplateOnlyConnection(connection: any): boolean {
  if (!connection) return true
  return !isBaseConnection(connection)
}

/**
 * Check if a connection is enabled in Settings (base connection level)
 * Fallback: base connections are enabled by default
 */
export function isConnectionEnabled(connection: any): boolean {
  if (!connection) return false
  // Check explicit is_enabled field
  const isEnabled = connection.is_enabled === true || connection.is_enabled === "1" || connection.is_enabled === "true"
  // Fallback: base connections are enabled by default even if field is missing/corrupted
  if (!isEnabled && isBaseConnection(connection)) {
    // If is_enabled was never set or was corrupted, base connections default to enabled
    return connection.is_enabled === undefined || connection.is_enabled === null
  }
  return isEnabled
}

/**
 * Check if a connection is active on the Dashboard
 */
export function isConnectionActiveDashboard(connection: any): boolean {
  if (!connection) return false
  return connection.is_enabled_dashboard === true || connection.is_enabled_dashboard === "1" || connection.is_enabled_dashboard === "true"
}

/**
 * Filter connections to only base connections (the 4 primary exchanges)
 */
export function filterBaseConnections(connections: any[]): any[] {
  return connections.filter(isBaseConnection)
}

/**
 * Filter connections to only template-only connections
 */
export function filterTemplateConnections(connections: any[]): any[] {
  return connections.filter(isTemplateOnlyConnection)
}

/**
 * Filter connections to base connections that are enabled (for Active Connections listing)
 */
export function filterEnabledBaseConnections(connections: any[]): any[] {
  return connections.filter(c => isBaseConnection(c) && isConnectionEnabled(c))
}

/**
 * Filter connections to dashboard-active connections (for trade engine processing)
 */
export function filterDashboardActiveConnections(connections: any[]): any[] {
  return connections.filter(isConnectionActiveDashboard)
}
