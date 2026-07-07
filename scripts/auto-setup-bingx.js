#!/usr/bin/env node
/**
 * Auto-setup BingX connection with provided credentials and start quickstart
 * This script stores configuration for the next server start
 */

const BINGX_API_KEY = "0HTardBdI36NCTGLu0EA6A91IjwdObw7gpxyvdKn8bgA3abe19X7ZKTN3sUy3rOHuKBSA2YQKdg9AuBONQ"
const BINGX_API_SECRET = "XsuPgjzQtFY5YzZYuaPlAxFwt6Ljq6jf8PmFD76TVhSD6v82KtzdWszI3nFBm5pePufhSQGuHj23UM48ZqYKQ"

function toRedisFlag(val) { return val ? "1" : "0" }

async function main() {
  // Create snapshot data that will be loaded by the Next.js app
  const snapshot = {
    v: 1,
    savedAt: Date.now(),
    strings: [],
    hashes: [
      // Connection data
      ["connection:bingx-x01", {
        id: 'bingx-x01',
        user_id: '1',
        name: 'BingX Live',
        exchange: 'bingx',
        api_type: 'perpetual_futures',
        connection_method: 'rest',
        connection_library: 'rest',
        api_key: BINGX_API_KEY,
        api_secret: BINGX_API_SECRET,
        margin_type: 'cross',
        position_mode: 'hedge',
        is_testnet: '0',
        is_enabled: toRedisFlag(true),
        is_live_trade: toRedisFlag(true),
        is_preset_trade: toRedisFlag(false),
        is_active: toRedisFlag(true),
        is_predefined: toRedisFlag(false),
        is_inserted: toRedisFlag(true),
        is_assigned: toRedisFlag(true),
        is_active_inserted: toRedisFlag(true),
        is_enabled_dashboard: toRedisFlag(true),
        is_dashboard_inserted: toRedisFlag(true),
        volume_factor: '0.1',
        live_volume_factor: '0.1',
        force_symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]),
        updated_at: new Date().toISOString(),
      }],
      // Global coordinator
      ["trade_engine:global", {
        status: 'running',
        desired_status: 'running',
        operator_intent: 'running',
        coordinator_ready: 'true',
        operator_stopped: '0',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      // Connection settings
      ["connection_settings:bingx-x01", {
        volume_factor_live: "0.1",
        live_volume_factor: "0.1",
        symbol_order: "volatility_1h",
        symbol_count: "2",
        base_min_profit_factor: "1.0",
        main_min_profit_factor: "1.2",
        real_min_profit_factor: "1.2",
        variant_trailing: "true",
        variant_block: "true",
        variant_dca: "false",
        control_orders: "true",
        updated_at: new Date().toISOString(),
      }],
      // Trade engine state
      ["trade_engine_state:bingx-x01", {
        connection_id: 'bingx-x01',
        symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]),
        active_symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]),
        status: 'ready',
        updated_at: new Date().toISOString(),
      }],
    ],
    sets: [
      ["idx:connections", ["bingx-x01"]],
      ["idx:connections:active", ["bingx-x01"]],
    ],
    lists: [],
    sorted_sets: [],
    ttl: [],
  }
  
  // Write snapshot to disk for Next.js to load on startup
  const fs = require('fs')
  const path = require('path')
  
  // Create .v0-data directory
  const dataDir = path.join(process.cwd(), '.v0-data')
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch {}
  
  const snapshotPath = path.join(dataDir, 'redis-snapshot.json')
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
  
  console.log("[Auto-Setup] ===== SNAPSHOT CREATED =====")
  console.log("[Auto-Setup] Snapshot path:", snapshotPath)
  console.log("[Auto-Setup] Connection ID: bingx-x01")
  console.log("[Auto-Setup] API Key: ***" + BINGX_API_KEY.slice(-8))
  console.log("[Auto-Setup] Live trading: ENABLED (is_live_trade=1)")
  console.log("[Auto-Setup] Symbols: BTCUSDT, ETHUSDT")
  console.log("[Auto-Setup] Volume factor: 0.1 (minimal)")
  console.log("[Auto-Setup] Flags set: is_enabled=1, is_assigned=1, is_enabled_dashboard=1, is_active_inserted=1")
  console.log("\n[Auto-Setup] Next steps:")
  console.log("  1. Start dev server: bun run dev")
  console.log("  2. Visit /settings?tab=exchange to see BingX X01")
  console.log("  3. Visit /monitoring for live progression metrics")
}

main().catch(e => { 
  console.error("[Auto-Setup] Error:", e.message || e)
  process.exit(1) 
})