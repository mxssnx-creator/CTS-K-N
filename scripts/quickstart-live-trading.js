#!/usr/bin/env node
/**
 * Quickstart Live Trading Test Runner
 * Usage: npm run quickstart
 * 
 * Triggers the full quickstart flow with:
 * - 32 symbols (auto-picked volatile ones)
 * - Minimal exchange volume (live_volume_factor ratio=1 forced by API)
 * - Live trade enabled (is_live_trade=1 forced by API)
 * 
 * This makes "npm run quickstart" actually work instead of failing on missing file.
 * It calls the canonical /api/trade-engine/quick-start endpoint.
 */

const PORT = process.env.PORT || 3002;
const BASE = `http://localhost:${PORT}`;

async function waitForHealth(timeoutMs = 90000) {
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    try {
      const health = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (health.ok) return health;
      lastError = `HTTP ${health.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.warn(`[Quickstart] Dev server health was not ready after ${timeoutMs}ms: ${lastError || "unknown error"}`);
  return null;
}

async function main() {
  console.log("[Quickstart] Starting live trading quickstart test (dev or production server)...");
  console.log(`[Quickstart] Target: ${BASE}`);
  console.log("[Quickstart] Config: 32 symbols, minimal exchange volume (ratio 1), live trade ENABLED");

  try {
    // First check if server is up (dev mode). Next.js dev can spend several
    // seconds compiling instrumentation and /api/health on a cold start; a
    // single 5s probe made the script incorrectly fall back to standalone mode
    // even though `npm run dev` was still booting. Poll for readiness so the
    // quickstart script actually exercises the API path in dev mode.
    const health = await waitForHealth();

    if (!health || !health.ok) {
      console.warn("[Quickstart] No dev server — falling back to standalone diagnostic test (inline Redis) with 32 symbols, min-vol, live-trade semantics.");
      // Fallback: run the comprehensive diagnostic exercising the same 32-symbol quickstart path + live close independence checks.
      try {
        const { spawnSync } = require("child_process");
        const symbols = ["PLAYSOUTUSDT","XANUSDT","BSBUSDT","NILUSDT","BILLUSDT","GITLAWBUSDT","UBUSDT","ASTEROIDETHUSDT","RKCUSDT","ERAUSDT","DRIFTUSDT","WIFUSDT","1000PEPEUSDT","DOGEUSDT","XRPUSDT","ADAUSDT","SOLUSDT","SUIUSDT","LINKUSDT","AVAXUSDT","OPUSDT","ARBUSDT","APTUSDT","NEARUSDT","FILUSDT","DOTUSDT","LTCUSDT","BCHUSDT","UNIUSDT","TRXUSDT","ETCUSDT","ATOMUSDT"]
        const diag = spawnSync(process.execPath, [
          "scripts/standalone-bingx-live-diagnostic.mjs",
          JSON.stringify(symbols),
        ], { stdio: "inherit", timeout: 45000 });
        console.log("[Quickstart] Standalone diagnostic completed with exit", diag.status);
        process.exit(diag.status || 0);
      } catch (e) {
        console.error("[Quickstart] Fallback diagnostic failed:", e.message || e);
        process.exit(1);
      }
    }

    // Trigger quickstart with 32 symbols, live trade, minimal vol (API forces the last two)
    const res = await fetch(`${BASE}/api/trade-engine/quick-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enable",
        symbolCount: 32,           // Request 32 symbols (auto volatile pick)
        // connectionId can be passed if needed; API auto-discovers BingX with creds
      }),
      signal: AbortSignal.timeout(120000),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error("[Quickstart] Quickstart API failed:", res.status, data);
      process.exit(1);
    }

    console.log("[Quickstart] ✅ Quickstart completed successfully");
    console.log("[Quickstart] Response:", JSON.stringify(data, null, 2));

    // Also trigger a quick engine status check
    const statusRes = await fetch(`${BASE}/api/trade-engine/status-all`).catch(() => null);
    if (statusRes) {
      const status = await statusRes.json().catch(() => ({}));
      console.log("[Quickstart] Engine status sample:", JSON.stringify(status, null, 2).slice(0, 800));
    }

    console.log("[Quickstart] Test run complete. Check dashboard /monitoring /strategies for live data.");
    process.exit(0);
  } catch (err) {
    console.error("[Quickstart] FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
