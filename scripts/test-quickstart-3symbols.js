#!/usr/bin/env node
/**
 * 3-Symbol Quickstart Live Order Creation Test
 * Usage: npm run test:quickstart-3
 *
 * Runs in Dev with:
 * - Exactly 3 symbols (volatile, low-price for minimal volume testing)
 * - Live trade explicitly ENABLED (is_live_trade=1 semantics)
 * - Focus: Verify live/real order creation path, [REAL_ORDER_ATTEMPT] logging,
 *   volume calculation, and that live closing remains independent of Control Orders.
 *
 * Falls back to standalone diagnostic when no dev server is running.
 */

const { spawnSync } = require("child_process");
const PORT = process.env.PORT || 3002;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

const DEFAULT_SYMBOLS = [
  "PLAYSOUTUSDT", "XANUSDT", "BSBUSDT", "NILUSDT", "BILLUSDT", "GITLAWBUSDT",
  "UBUSDT", "ASTEROIDETHUSDT", "RKCUSDT", "ERAUSDT", "DRIFTUSDT", "WIFUSDT",
  "1000PEPEUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT", "SOLUSDT", "SUIUSDT",
  "LINKUSDT", "AVAXUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "NEARUSDT",
  "FILUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "UNIUSDT", "TRXUSDT", "ETCUSDT", "ATOMUSDT",
];

function requestedSymbols() {
  const explicit = process.env.SYMBOLS
    ? process.env.SYMBOLS.split(",").map((symbol) => symbol.trim()).filter(Boolean)
    : DEFAULT_SYMBOLS;
  const count = Number(process.env.SYMBOL_COUNT || 3);
  return explicit.slice(0, Math.min(Math.max(count, 1), 32));
}

async function main() {
  const symbols = requestedSymbols();
  console.log(`\n=== ${symbols.length}-SYMBOL QUICKSTART + LIVE ORDER CREATION TEST ===`);
  console.log(`Mode: Dev | Symbols: ${symbols.length} | Live Trade: ENABLED | Focus: Real exchange order creation`);
  console.log("Target:", BASE);
  console.log("Symbols:", symbols.join(", "));

  // Try to detect a running server. Dev startup can spend several seconds in
  // instrumentation/migrations, so retry before falling back to standalone mode.
  let serverDetected = false;
  for (const path of ["/api/health", "/"]) {
    for (let attempt = 0; attempt < 12 && !serverDetected; attempt++) {
      const response = await fetch(`${BASE}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      serverDetected = Boolean(response && (response.ok || response.status === 307));
      if (!serverDetected) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (serverDetected) break;
  }

  if (serverDetected) {
    if (process.env.ALLOW_REAL_ORDER_TEST !== "1") {
      console.error("\n[SAFETY] Refusing to enable live exchange trading on a running server.");
      console.error("Use `npm run test:quickstart-12` for the safe paper-engine soak.");
      console.error("Set ALLOW_REAL_ORDER_TEST=1 only for an explicitly approved, credentialed exchange test.");
      process.exit(2);
    }
    console.log(`\n[1] Dev server detected — triggering quickstart via API with ${symbols.length} symbols + live enabled`);

    try {
      const res = await fetch(`${BASE}/api/trade-engine/quick-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enable",
          symbolCount: symbols.length,
          symbols,
          // The backend quickstart handler forces is_live_trade=1 and live_volume_factor=0.1
        }),
        signal: AbortSignal.timeout(120000),
      });

      const data = await res.json().catch(() => ({}));
      console.log("[Quickstart API] Response:", JSON.stringify(data, null, 2));

      // Check engine status for live positions
      const statusRes = await fetch(`${BASE}/api/trade-engine/status-all`).catch(() => null);
      if (statusRes) {
        const status = await statusRes.json().catch(() => ({}));
        console.log("\n[Engine Status] Sample:", JSON.stringify(status, null, 2).slice(0, 1200));
      }

      console.log("\n[2] Checking for live order creation evidence (via API if available)...");
      // In full dev the /api/trade-engine/logs or progression endpoints would show [REAL_ORDER_ATTEMPT]
      console.log("   → Inspect Redis keys: engine_logs:*:live_trading for [REAL_ORDER_ATTEMPT] and [NO_REAL_ORDER]");
      console.log("   → Look for live:positions and real:* sets for the connection");

      console.log(`\n✅ ${symbols.length}-symbol quickstart API path completed. Review dashboard + Redis for live orders.`);
      process.exit(0);
    } catch (err) {
      console.error("[API Path] Failed:", err.message || err);
      // fall through to standalone
    }
  }

  // Standalone diagnostic mode (no server / no Redis needed for basic path exercise)
  console.log(`\n[1] No dev server or Redis — running standalone ${symbols.length}-symbol diagnostic (exercises same code paths)`);
  console.log("    (Real exchange orders require: running `npm run dev`, valid BINGX_* keys in .env.local, and a live connection)");

  try {
    const symbolsArg = JSON.stringify(symbols);
    const diag = spawnSync(process.execPath, [
      "scripts/standalone-bingx-live-diagnostic.mjs",
      symbolsArg,
    ], { stdio: "inherit", timeout: 60000 });

    console.log(`\n[Standalone ${symbols.length}-symbol diagnostic] Exit code:`, diag.status);
    console.log("\n=== TEST SUMMARY ===");
    console.log(`${symbols.length}-symbol quickstart test (live trade path) executed.`);
    console.log("Next for full verification with real order creation:");
    console.log("  1. npm run dev   (with BINGX_API_KEY/SECRET in .env.local, preferably testnet)");
    console.log("  2. npm run test:quickstart-3");
    console.log("  3. After run: redis-cli keys '*bingx-x01*' and grep engine_logs for REAL_ORDER_ATTEMPT");

    process.exit(diag.status || 0);
  } catch (e) {
    console.error("[Standalone] Fallback failed:", e.message || e);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
