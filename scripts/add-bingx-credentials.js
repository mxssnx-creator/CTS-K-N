#!/usr/bin/env node
/**
 * Script to add BingX credentials to the bingx-x01 connection
 * Usage: node scripts/add-bingx-credentials.js
 */

const { spawnSync } = require("child_process");

const BINGX_API_KEY = "0HTardBdI36NCTGLu0EA6A91IjwdObw7gpxyvdKn8bgA3abe19X7ZKTN3sUy3rOHuKBSA2YQKdg9AuBONQ";
const BINGX_API_SECRET = "XsuPgjzQtFY5YzZYuaPlAxFwt6Ljq6jf8PmFD76TVhSD6v82KtzdWszI3nFBm5pePufhSQGuHj23UM48ZqYKQ";

async function main() {
  console.log("[Setup] Adding BingX credentials to bingx-x01 connection...");
  
  // Check if Redis is available
  const redisCheck = spawnSync("redis-cli", ["ping"], { encoding: "utf-8" });
  if (redisCheck.status !== 0) {
    console.error("[Setup] Redis is not available. Please start Redis first.");
    process.exit(1);
  }
  
  console.log("[Setup] Redis is available.");
  
  // Update the connection with credentials
  const updates = [
    ["HSET", "connection:bingx-x01", "api_key", BINGX_API_KEY],
    ["HSET", "connection:bingx-x01", "api_secret", BINGX_API_SECRET],
    ["HSET", "connection:bingx-x01", "is_live_trade", "1"],
    ["HSET", "connection:bingx-x01", "live_trade_enabled", "1"],
    ["HSET", "connection:bingx-x01", "is_assigned", "1"],
    ["HSET", "connection:bingx-x01", "is_enabled_dashboard", "1"],
    ["HSET", "connection:bingx-x01", "is_active_inserted", "1"],
    ["HSET", "connection:bingx-x01", "is_active", "1"],
    ["HSET", "connection:bingx-x01", "live_trade_requested", "1"],
  ];
  
  for (const [cmd, key, field, value] of updates) {
    const result = spawnSync("redis-cli", [cmd, key, field, value], { encoding: "utf-8" });
    if (result.status === 0) {
      console.log(`[Setup] ${cmd} ${key} ${field}=***`);
    } else {
      console.error(`[Setup] Failed to ${cmd} ${key} ${field}`);
    }
  }
  
  // Also update settings hash
  const settingsUpdates = [
    ["HSET", "settings:connection_settings:bingx-x01", "api_key", BINGX_API_KEY],
    ["HSET", "settings:connection_settings:bingx-x01", "api_secret", BINGX_API_SECRET],
  ];
  
  for (const [cmd, key, field, value] of settingsUpdates) {
    const result = spawnSync("redis-cli", [cmd, key, field, value], { encoding: "utf-8" });
    if (result.status === 0) {
      console.log(`[Setup] ${cmd} ${key} ${field}=***`);
    } else {
      console.error(`[Setup] Failed to ${cmd} ${key} ${field}`);
    }
  }
  
  // Set environment variables for next restarts
  console.log("\n[Setup] Add these to your .env.local file:");
  console.log(`BINGX_API_KEY=${BINGX_API_KEY}`);
  console.log(`BINGX_API_SECRET=${BINGX_API_SECRET}`);
  
  console.log("\n[Setup] ✅ BingX credentials added to bingx-x01 connection");
}

main().catch((err) => {
  console.error("[Setup] Error:", err);
  process.exit(1);
});