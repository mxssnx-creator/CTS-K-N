import { createConnection, deleteConnection, getAllConnections, getConnection, initRedis, updateConnection } from "@/lib/redis-db"
import { getBaseConnectionCredentials, type BaseConnectionId } from "@/lib/base-connection-credentials"

type BaseSeedConfig = {
  id: BaseConnectionId
  exchange: string
  name: string
  apiType: string
  contractType: string
  connectionMethod: string
  connectionLibrary: string
}

// Bybit is intentionally NOT a canonical base connection. Users can add Bybit
// manually as a regular connection — it is no longer auto-seeded.
const CANONICAL_BASE_CONNECTIONS: BaseSeedConfig[] = [
  { id: "bingx-x01", exchange: "bingx", name: "BingX X01", apiType: "perpetual_futures", contractType: "usdt-perpetual", connectionMethod: "library", connectionLibrary: "native" },
  { id: "pionex-x01", exchange: "pionex", name: "Pionex X01", apiType: "perpetual_futures", contractType: "usdt-perpetual", connectionMethod: "library", connectionLibrary: "native" },
  { id: "orangex-x01", exchange: "orangex", name: "OrangeX X01", apiType: "perpetual_futures", contractType: "usdt-perpetual", connectionMethod: "library", connectionLibrary: "native" },
]

const LEGACY_CONNECTION_IDS = [
  "bybit-base",
  "bingx-base",
  "binance-base",
  "okx-base",
  "bybit-default-disabled",
  "bingx-default-disabled",
  // bybit-x03 was previously seeded as a canonical base connection. It is no
  // longer auto-created; existing rows must be removed on the next seed run.
  "bybit-x03",
]

// Module-level flag to prevent re-seeding
let seedingCompleted = false
const SEED_MARKER_KEY = "system:base_connections_seeded_v4"

/**
 * Backward-compatible entrypoint. Ensures canonical base connections only.
 */
export async function seedDefaultExchanges() {
  return ensureDefaultExchangesExist()
}

/**
 * Ensures canonical base connections exist and injects predefined real credentials.
 * Also removes legacy `*-base` / `*-default-disabled` duplicates that caused blank/duplicated entries.
 * Only runs once - subsequent calls return immediately.
 */
export async function ensureDefaultExchangesExist() {
  // Skip if already seeded
  if (seedingCompleted) {
    console.log("[v0] [BaseSeed] Skipping - already seeded")
    return { success: true, skipped: true }
  }
  
  await initRedis()

  try {
    const { getRedisClient } = await import("@/lib/redis-db")
    const client = getRedisClient()
    const alreadySeeded = await client.get(SEED_MARKER_KEY)
    if (alreadySeeded === "1") {
      seedingCompleted = true
      console.log("[v0] [BaseSeed] Skipping - persisted seed marker found")
      return { success: true, skipped: true, marker: true }
    }

    let removedLegacy = 0
    let created = 0
    let updated = 0
      let credentialsApplied = 0

    const allConnections = await getAllConnections()
      const existingIds = new Set((allConnections || []).map((c: any) => c.id as string))

    for (const legacyId of LEGACY_CONNECTION_IDS) {
      if (existingIds.has(legacyId)) {
        await deleteConnection(legacyId)
        removedLegacy++
      }
    }

    for (const cfg of CANONICAL_BASE_CONNECTIONS) {
      const now = new Date().toISOString()
      const existing = await getConnection(cfg.id)

        const { apiKey, apiSecret } = getBaseConnectionCredentials(cfg.id as BaseConnectionId)
        const hasConfiguredCreds = apiKey.length > 0 && apiSecret.length > 0

      const normalizedBase = {
        id: cfg.id,
        name: existing?.name || cfg.name,
        exchange: cfg.exchange,
        // Enforce perpetual_futures for base BingX/Pionex/OrangeX connections - Spot API returns 0 balance for perpetual positions
        api_type: (cfg.exchange === "bingx" || cfg.exchange === "pionex" || cfg.exchange === "orangex") 
          ? "perpetual_futures" 
          : (existing?.api_type || cfg.apiType),
        contract_type: existing?.contract_type || cfg.contractType,
        connection_method: existing?.connection_method || cfg.connectionMethod,
        connection_library: existing?.connection_library || cfg.connectionLibrary,
        margin_type: existing?.margin_type || "cross",
        position_mode: existing?.position_mode || "hedge",
        is_testnet: existing?.is_testnet ?? false,
        is_predefined: existing?.is_predefined ?? true,
        // ONLY bybit and bingx are inserted (shown on Main Connections by default)
        // All others (pionex, orangex) are disabled and hidden
        is_inserted: cfg.exchange === "bybit" || cfg.exchange === "bingx" ? "1" : "0",
        // PRESERVE existing is_active_inserted — only set "1" for brand-new bingx-x01 connections.
        // Bybit should NOT be auto-inserted. Never override user deletions or manual toggles.
        is_active_inserted: existing
          ? (existing.is_active_inserted ?? "0")
          : (cfg.exchange === "bingx" ? "1" : "0"),
        // ONLY bybit and bingx are enabled by default in settings
        is_enabled: cfg.exchange === "bybit" || cfg.exchange === "bingx" ? "1" : "0",
        is_enabled_dashboard: existing?.is_enabled_dashboard ?? "0",
        is_active: existing?.is_active ?? "0",
        created_at: existing?.created_at || now,
        updated_at: now,
      } as Record<string, any>

        // ALWAYS inject real predefined credentials for base connections
        // This ensures canonical base connections (bingx-x01, etc.) have valid credentials on every startup
        if (hasConfiguredCreds) {
          normalizedBase.api_key = apiKey
          normalizedBase.api_secret = apiSecret
          console.log(`[v0] [BaseSeed] ✓ Injected predefined credentials for ${cfg.id}`)
        } else {
          // Should never happen for canonical base connections
          normalizedBase.api_key = existing?.api_key || ""
          normalizedBase.api_secret = existing?.api_secret || ""
          console.warn(`[v0] [BaseSeed] ⚠ No predefined credentials available for ${cfg.id}`)
      }

      if (!existing) {
        await createConnection(normalizedBase)
        created++
      } else {
        await updateConnection(cfg.id, normalizedBase)
        updated++
      }

        if (hasConfiguredCreds) {
          credentialsApplied++
        }
      }

      console.log(
        `[v0] [BaseSeed] canonical ensured created=${created} updated=${updated} legacyRemoved=${removedLegacy} credentialsApplied=${credentialsApplied}`,
      )

    // Mark seeding as completed to prevent re-seeding
    await client.set(SEED_MARKER_KEY, "1")
    seedingCompleted = true

    return {
      success: true,
      created,
      updated,
      removedLegacy,
        credentialsApplied,
    }
  } catch (error) {
    console.error("[v0] [BaseSeed] ensure failed:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * Reset seeding flag (for testing/admin purposes)
 */
export function resetSeedingFlag() {
  seedingCompleted = false
}

/**
 * Returns canonical base connections enabled in Settings and not yet active on dashboard.
 */
export async function getAvailableBaseConnections() {
  await initRedis()
  const allConnections = await getAllConnections()
  const canonicalIds = new Set(CANONICAL_BASE_CONNECTIONS.map((c) => c.id))

  return (allConnections || []).filter((c: any) => {
    if (!canonicalIds.has(c.id)) return false
    const isEnabled = c.is_enabled === true || c.is_enabled === "1" || c.is_enabled === "true"
    const isDashboardInserted = c.is_active_inserted === true || c.is_active_inserted === "1" || c.is_active_inserted === "true"
    return isEnabled && !isDashboardInserted
  })
}
