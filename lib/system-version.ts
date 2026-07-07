// System version tracking - increment on each major change/merge
// Format: YYYY.MM.DD.vN.mN (year.month.day.major.minor)
// Update minor version on every merge, major on significant architectural changes
export const SYSTEM_VERSION = "2026.02.26.v4.5"

// Component versions - track UI code changes
// Increment on component modifications that require browser cache refresh
export const COMPONENT_VERSIONS = {
  dashboardManager: "v5", // Dashboard active connections manager - v5: fixed dashboard state fields
  statisticsOverview: "v4", // Statistics overview widget - v4: separated indications from strategies
  systemInitializer: "v3", // System initialization - v3: added comprehensive version logging
  connectionState: "v2", // Connection state management
  globalControls: "v2", // Global trade engine controls
  addConnectionDialog: "v2", // Add connection dialog
} as const

// API versions - track backend changes
// Increment on API logic changes or data structure modifications
export const API_VERSIONS = {
  connections: "v4", // Settings connections API - v4: added version tracking and cache-bust headers
  tradeEngine: "v2", // Trade engine APIs
  systemStats: "v3", // System statistics
  indicationsStats: "v2", // Indications stats - v2: separated from strategies
  strategiesEvaluation: "v2", // Strategies evaluation - v2: fixed base/main/real/live types
  startup: "v1", // Startup initialization API
} as const

// Get current system version info with changelog
export function getSystemVersionInfo() {
  return {
    system: SYSTEM_VERSION,
    components: COMPONENT_VERSIONS,
    apis: API_VERSIONS,
    timestamp: new Date().toISOString(),
    buildTime: new Date().getTime(),
    changelog: {
      "2026.02.26.v4.5": [
        "Incremented all component and API versions for browser cache refresh",
        "DashboardManager v5: Fixed is_dashboard_inserted field validation",
        "StatisticsOverview v4: Separated indications (direction/move/active/optimal) from strategies (base/main/real/live)",
        "SystemInitializer v3: Added comprehensive version logging on startup",
        "ConnectionsAPI v4: Added X-API-Version header and version tracking",
        "IndicationsStats v2: Independent from strategies architecture",
        "StrategiesEvaluation v2: Fixed strategy type categorization",
      ],
      "2026.02.26.v4.4": [
        "Initial system version tracking implementation",
        "Added cache-bust parameters to API calls",
        "Implemented version headers in all API responses",
      ],
    },
  }
}
