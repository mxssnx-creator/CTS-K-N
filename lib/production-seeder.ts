/**
 * Production Seeder
 * Seeds essential data for production mode: settings, connections, market data
 */

import { saveSettings } from "@/lib/settings-storage"
import { saveConnection } from "@/lib/redis-db"
import { loadMarketDataForEngine } from "@/lib/market-data-loader"
import { getPredefinedAsExchangeConnections } from "@/lib/connection-predefinitions"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { setSettings } from "@/lib/redis-db"

export interface ProductionSeedOptions {
  seedSettings?: boolean
  seedConnections?: boolean
  seedMarketData?: boolean
  seedProgression?: boolean
  symbols?: string[]
}

/**
 * Seed all essential production data
 */
export async function seedProductionData(options: ProductionSeedOptions = {}): Promise<void> {
  console.log("[v0] [ProductionSeeder] Starting production data seeding...")
   
  try {
    await initRedis()
    
    // Seed default settings if none exist
    if (options.seedSettings !== false) {
      await seedDefaultSettings()
    }
    
    // Seed predefined connections if none exist
    if (options.seedConnections !== false) {
      await seedPredefinedConnections()
    }
    
    // Seed market data for trading
    if (options.seedMarketData !== false) {
      await seedMarketData(options.symbols)
    }
    
    // Seed progression state
    if (options.seedProgression !== false) {
      await seedProgressionState()
    }
    
    console.log("[v0] [ProductionSeeder] ✅ Production data seeding completed")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed production data:", error)
    throw error
  }
}

/**
 * Seed default application settings
 */
async function seedDefaultSettings(): Promise<void> {
  try {
    // Check if settings already exist via getAppSettings (canonical source)
    const { getAppSettings } = await import("@/lib/redis-db")
    const existingSettings = await getAppSettings()
    if (Object.keys(existingSettings).length > 0) {
      console.log("[v0] [ProductionSeeder] Settings already exist, skipping...")
      return
    }
    
    // Default production settings
    const defaultSettings = {
      cyclePauseMs: 50,
      mainEngineIntervalMs: 700,
      presetEngineIntervalMs: 120000,
      strategyUpdateIntervalMs: 10000,
      realtimeIntervalMs: 300,
      mainEngineEnabled: true,
      presetEngineEnabled: true,
      minimum_connect_interval: 200,
      theme: "dark",
      language: "en",
      notifications_enabled: true,
      default_leverage: 0, // 0 = resolved from exchange predefinition at order time
      useMaximalLeverage: true,
      leveragePercentage: 100,
      default_volume: 100,
      max_open_positions: 10,
      max_drawdown_percent: 20,
      daily_loss_limit: 1000,
      main_symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
      forced_symbols: [],
      database_type: "redis",
      restApiDelayMs: 50,
      publicRequestDelayMs: 20,
      privateRequestDelayMs: 100,
      websocketTimeoutMs: 30000,
      strategyMainMaxPseudoPositionsLong: 1,
      strategyMainMaxPseudoPositionsShort: 1,
      databaseLimitPerSecond: 10000,
      databaseLimitPerMinute: 500000,
      databaseLimitPerDay: 0,
    }
    
    // Save to Redis (canonical location for engine reads)
    await setSettings("app_settings", defaultSettings)
    // Also save to file-based storage for backward compatibility
    saveSettings(defaultSettings)
    console.log("[v0] [ProductionSeeder] ✅ Default settings seeded")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed settings:", error)
    throw error
  }
}

/**
 * Seed predefined exchange connections
 */
async function seedPredefinedConnections(): Promise<void> {
  try {
    const client = getRedisClient()
    const connectionsKey = "all_connections"

    // ALWAYS skip when connections already exist — in EVERY environment.
    // AUTO-START DISABLED: this function previously re-ran unconditionally in
    // production ("no early skip") and force-wrote is_enabled_dashboard=1 /
    // is_active=1 / is_live_trade=1 onto bingx-x01 on EVERY call. Because
    // /api/system/initialize is invoked from EngineAutoInitializer on every
    // dashboard mount, that re-enabled (and auto-started) the connection
    // after every operator disable. Seeding is now strictly first-boot-only.
    const existingConnections = await client.get(connectionsKey)
    if (existingConnections) {
      console.log("[v0] [ProductionSeeder] Connections already exist, skipping (never overwrite)")
      return
    }

    // Migration-created / operator-created connection hashes are also an
    // existing state. Rebuild the list cache instead of reseeding defaults;
    // otherwise a page-triggered /api/system/initialize can overwrite live
    // operator connection flags when all_connections is missing/stale.
    const existingConnectionKeys = ((await client.keys("connection:*").catch(() => [])) || [])
      .filter((key: string) =>
        !key.includes(":settings:") &&
        !key.includes(":stats:") &&
        !key.includes(":logs:")
      )

    if (existingConnectionKeys.length > 0) {
      const existingRows = []
      for (const key of existingConnectionKeys) {
        const row = await client.hgetall(key).catch(() => null)
        if (row && Object.keys(row).length > 0) {
          const id = row.id || key.replace(/^connection:/, "")
          existingRows.push({ ...row, id })
          await client.sadd("connections", id).catch(() => {})
        }
      }
      if (existingRows.length > 0) {
        await client.set(connectionsKey, JSON.stringify(existingRows))
        console.log(`[v0] [ProductionSeeder] Rebuilt all_connections from ${existingRows.length} existing connection hashes; skipping reseed`)
        return
      }
    }

    // Get predefined connections
    const predefinedConnections = getPredefinedAsExchangeConnections()

    // AUTO-START DISABLED: seed ALL connections fully disabled. The operator
    // must explicitly enable a connection via the dashboard toggle before
    // anything runs. `is_enabled` stays "1" (connection is usable/selectable)
    // but no dashboard/active/live flags are pre-set.
    const seededConnections = predefinedConnections.map((conn) => ({
      ...conn,
      is_enabled: "1",
      is_active: "0",
      is_live_trade: "0",
      is_assigned: "0",
      is_dashboard_inserted: "0",
      is_enabled_dashboard: "0",
      is_inserted: "0",
      // Mark as NOT predefined so quick-start can find it (string "false" for Redis consistency)
      is_predefined: "false",
      active_symbols: "[]",
      live_volume_factor: "1.0",
      preset_volume_factor: "1.0",
      volume_step_ratio: "0.6",
    }))

    // Save individual connections to Redis (connection:{id} hashes)
    for (const conn of seededConnections) {
      await saveConnection(conn)
    }

    // Store the connection list for quick lookup
    await client.set(connectionsKey, JSON.stringify(seededConnections))

    console.log(`[v0] [ProductionSeeder] ✅ Seeded ${seededConnections.length} connections (all disabled — operator must enable explicitly)`)
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed connections:", error)
    throw error
  }
}

/**
 * Seed initial market data
 */
async function seedMarketData(symbols: string[] = []): Promise<void> {
  try {
    console.log("[v0] [ProductionSeeder] Seeding initial market data...")
    
    const targetSymbols = symbols.length > 0 ? symbols : [
      "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
      "DOGEUSDT", "LINKUSDT", "LTCUSDT", "THETAUSDT", "AVAXUSDT",
      "MATICUSDT", "SOLUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT"
    ]
    
    // Load market data for engine
    const loaded = await loadMarketDataForEngine(targetSymbols, { connectionId: "bingx-x01" })
    
    if (loaded > 0) {
      console.log(`[v0] [ProductionSeeder] ✅ Market data seeded for ${loaded} symbols`)
    } else {
      console.warn("[v0] [ProductionSeeder] ⚠ No market data loaded")
    }
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed market data:", error)
    throw error
  }
}

/**
 * Seed initial progression state
 */
async function seedProgressionState(): Promise<void> {
  try {
    console.log("[v0] [ProductionSeeder] Seeding progression state...")
    
    const client = getRedisClient()

    // Get all connections to create progression states for
    const connections = await client.get("all_connections")
    if (!connections) {
      console.log("[v0] [ProductionSeeder] No connections found, skipping progression seeding")
      return
    }

    const connectionsArray = JSON.parse(connections)

    // DATA INTEGRITY FIX: never archive/restart an existing progression here.
    // This function previously ran UNCONDITIONALLY in production (no skip) and
    // called archiveAndStartNewProgression for every enabled connection —
    // i.e. every /api/system/initialize call (fired on each dashboard mount)
    // archived the LIVE progression and reset all counters to zero. Now a
    // progression is created only when NONE exists for that connection.
    let created = 0
    for (const conn of connectionsArray) {
      if (conn.is_enabled === "1" && conn.is_active === "1") {
        const existing = await client.hgetall(`progression:${conn.id}`).catch(() => null)
        if (existing && Object.keys(existing).length > 0) {
          continue // live progression present — never touch it
        }
        await ProgressionStateManager.archiveAndStartNewProgression(
          conn.id,
          Date.now()
        )
        created++
      }
    }

    console.log(`[v0] [ProductionSeeder] ✅ Progression state seeded (${created} created, existing untouched)`)
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed progression state:", error)
    throw error
  }
}

/**
 * Force reseed all production data (use with caution)
 */
export async function forceReseedProductionData(): Promise<void> {
  console.log("[v0] [ProductionSeeder] Force reseeding all production data...")
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Clear existing data
    const keysToClear = [
      "app_settings",
      "all_connections",
      ...(await client.keys("market_data:*")),
      ...(await client.keys("progression:*")),
      ...(await client.keys("trade_engine_state:*")),
      ...(await client.keys("settings:*")),
      ...(await client.keys("connection:*")),
    ]
    
    if (keysToClear.length > 0) {
      await client.del(...keysToClear)
      console.log(`[v0] [ProductionSeeder] Cleared ${keysToClear.length} keys`)
    }
    
    // Reseed everything
    await seedProductionData({
      seedSettings: true,
      seedConnections: true,
      seedMarketData: true,
      seedProgression: true
    })
    
    console.log("[v0] [ProductionSeeder] ✅ Force reseeding completed")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Force reseeding failed:", error)
    throw error
  }
}

// Module-load auto-seed REMOVED.
// Previously `seedProductionData()` fired as an import side effect whenever
// NODE_ENV === "production", re-running the seeder on every cold start and
// module re-import. Seeding now happens only via the explicit
// /api/system/initialize endpoint (which itself is first-boot-only).

export default {
  seedProductionData,
  seedDefaultSettings,
  seedPredefinedConnections,
  seedMarketData,
  seedProgressionState,
  forceReseedProductionData
}
