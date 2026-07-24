#!/usr/bin/env node
/**
 * Script to add BingX credentials to the bingx-x01 connection.
 * Credentials are read from environment variables BINGX_API_KEY and BINGX_API_SECRET,
 * which should be set via wrangler.jsonc secrets or .env.local before running.
 * Usage: BINGX_API_KEY=... BINGX_API_SECRET=... node scripts/add-bingx-credentials.js
 */

const { spawnSync } = require("child_process");

function getBingxCredentials() {
  const apiKey = process.env.BINGX_API_KEY || "";
  const apiSecret = process.env.BINGX_API_SECRET || "";
  if (apiKey.length < 10 || apiSecret.length < 10) {
    console.error("[Setup] BINGX_API_KEY and BINGX_API_SECRET must be set in the environment (each at least 10 characters).");
    process.exit(1);
  }
  return { apiKey, apiSecret }
}

async function main() {
  const { apiKey, apiSecret } = getBingxCredentials();
  console.log("[Setup] Adding BingX credentials to bingx-x01 connection...");

  const redisCheck = spawnSync("redis-cli", ["ping"], { encoding: "utf-8" });
  if (redisCheck.status !== 0) {
    console.error("[Setup] Redis is not available. Please start Redis first.");
    process.exit(1);
  }

  console.log("[Setup] Redis is available.");

  const updates = [
    ["HSET", "connection:bingx-x01", "api_key", apiKey],
    ["HSET", "connection:bingx-x01", "api_secret", apiSecret],
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

  const settingsUpdates = [
    ["HSET", "settings:connection_settings:bingx-x01", "api_key", apiKey],
    ["HSET", "settings:connection_settings:bingx-x01", "api_secret", apiSecret],
  ];

  for (const [cmd, key, field, value] of settingsUpdates) {
    const result = spawnSync("redis-cli", [cmd, key, field, value], { encoding: "utf-8" });
    if (result.status === 0) {
      console.log(`[Setup] ${cmd} ${key} ${field}=***`);
    } else {
      console.error(`[Setup] Failed to ${cmd} ${key} ${field}`);
    }
  }

  console.log("\n[Setup] ✅ BingX credentials added to bingx-x01 connection");
}

main().catch((err) => {
  console.error("[Setup] Error:", err);
  process.exit(1);
});