#!/usr/bin/env node

/**
 * Single-worker production artifact audit for constrained environments.
 *
 * This intentionally differs from run-prod-preview-check: it is allowed to
 * use InlineLocalRedis only because one standalone server owns the complete
 * process. It proves rendered page availability, selected-connection request
 * isolation, high-scale QuickStart, state write/readback and hot API latency
 * without pretending to validate a multi-worker Redis deployment.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

const port = Math.max(1024, Math.min(65535, Number(process.env.PROD_INLINE_AUDIT_PORT || 3112)))
const baseUrl = `http://127.0.0.1:${port}`
const auditDistDir = process.env.PROD_INLINE_AUDIT_DIST_DIR ||
  (existsSync(".next-prod/BUILD_ID") ? ".next-prod" : ".next")
// The command runners used in CI can give each invocation a low PID such as
// 4. Include a timestamp so an interrupted audit can never make a later run
// accidentally reuse its InlineLocalRedis state.
const snapshotPath = `/tmp/cts-production-inline-ui-audit-${process.pid}-${Date.now()}.json`
const deepUiAuditRequested = process.env.PROD_INLINE_AUDIT_DEEP === "1"
const streamServerLogs = process.env.PROD_INLINE_AUDIT_STREAM_SERVER_LOGS === "1"
const auditHeapMb = Math.max(
  2048,
  Math.min(12288, Number(process.env.PROD_INLINE_AUDIT_HEAP_MB || (deepUiAuditRequested ? 8192 : 4096))),
)
const auditMemoryLimitMb = Math.max(
  auditHeapMb,
  Number(process.env.PROD_INLINE_AUDIT_MEMORY_LIMIT_MB || (deepUiAuditRequested ? 10240 : 6144)),
)
const auditRssSoftLimitMb = Math.max(
  1024,
  Math.min(auditMemoryLimitMb, Number(process.env.PROD_INLINE_AUDIT_RSS_SOFT_LIMIT_MB || (deepUiAuditRequested ? 6400 : 4096))),
)
const auditRssHardLimitMb = Math.max(
  auditRssSoftLimitMb,
  Math.min(auditMemoryLimitMb, Number(process.env.PROD_INLINE_AUDIT_RSS_HARD_LIMIT_MB || (deepUiAuditRequested ? 8192 : 5120))),
)
const HIGH_SCALE_SYMBOL_STRESS_TARGET = 128
const baseSymbols = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
  "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
  "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
  "ICPUSDT", "HBARUSDT",
]
let symbols = baseSymbols
let outputTail = ""
let symbolSource = "exchange"

function deterministicAuditSymbols(count) {
  return Array.from(
    { length: Math.max(0, count) },
    (_, index) => `AUDIT${String(index + 1).padStart(4, "0")}USDT`,
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function appendOutput(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-24_000)
}

async function request(pathname, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const startedAt = performance.now()
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let data = text
  try { data = text ? JSON.parse(text) : {} } catch { /* pages are handled separately */ }
  return {
    status: response.status,
    data,
    text,
    durationMs: performance.now() - startedAt,
  }
}

async function waitForReady(child) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Production server exited (${child.exitCode})\n${outputTail}`)
    try {
      const health = await request("/api/health/liveness", { timeoutMs: 3_000 })
      if (health.status === 200) return
    } catch { /* startup in progress */ }
    await sleep(250)
  }
  throw new Error(`Production server did not become ready\n${outputTail}`)
}

async function stopServer(child) {
  if (!child?.pid || child.exitCode != null) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
    else child.kill("SIGTERM")
  } catch { return }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5_000)])
  if (child.exitCode == null) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
      else child.kill("SIGKILL")
    } catch { /* process already ended */ }
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}

async function pageCheck(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Accept: "text/html,*/*" },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  const html = await response.text()
  assert(response.ok, `${pathname} returned HTTP ${response.status}`)
  assert(html.includes("/_next/static/"), `${pathname} did not render Next client assets`)
}

async function resolveAuditSymbols() {
  if (symbols.length >= HIGH_SCALE_SYMBOL_STRESS_TARGET) return
  const top = await request(
    `/api/exchange/bingx/top-symbols?sort=volume&limit=${HIGH_SCALE_SYMBOL_STRESS_TARGET}&t=${Date.now()}`,
    { timeoutMs: 30_000 },
  )
  const discovered = Array.isArray(top.data?.symbolList)
    ? top.data.symbolList.map(String)
    : Array.isArray(top.data?.symbols)
      ? top.data.symbols.map((entry) => String(entry?.symbol || "")).filter(Boolean)
      : []
  const uniqueDiscovered = [...new Set(discovered.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
  if (uniqueDiscovered.length >= HIGH_SCALE_SYMBOL_STRESS_TARGET) {
    symbols = uniqueDiscovered.slice(0, HIGH_SCALE_SYMBOL_STRESS_TARGET)
    return
  }

  // This audit is deliberately single-process, forced-simulated and incapable
  // of exchange writes. A CI/network sandbox may block the public ticker
  // endpoint and leave only the resolver's bounded major-symbol fallback. Fill
  // that shortfall deterministically so the 128-symbol coordination, UI and
  // stats paths are still exercised. Remote acceptance does not set this
  // override and must independently prove real exchange discovery.
  if (process.env.PROD_INLINE_AUDIT_REQUIRE_LIVE_DISCOVERY === "1") {
    throw new Error(
      `Inline audit discovery returned ${uniqueDiscovered.length}/${HIGH_SCALE_SYMBOL_STRESS_TARGET} unique symbols`,
    )
  }
  symbols = [...new Set([
    ...uniqueDiscovered,
    ...baseSymbols,
    ...deterministicAuditSymbols(HIGH_SCALE_SYMBOL_STRESS_TARGET),
  ])].slice(0, HIGH_SCALE_SYMBOL_STRESS_TARGET)
  symbolSource = "deterministic-simulated-fallback"
  assert(symbols.length === HIGH_SCALE_SYMBOL_STRESS_TARGET, "Could not construct the simulated audit basket")
}

async function runDeepUiVerifier() {
  await new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-ui-max.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        PORT: String(port),
        PROD_UI_SYMBOLS_JSON: JSON.stringify(symbols),
        PROD_UI_PROGRESSION_TIMEOUT_MS:
          process.env.PROD_INLINE_AUDIT_PROGRESS_TIMEOUT_MS || String(HIGH_SCALE_SYMBOL_STRESS_TARGET * 7_500),
      },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Deep production UI verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

async function main() {
  const child = spawn(process.execPath, ["scripts/start-production.mjs"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_DIST_DIR: auditDistDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      ALLOW_PROD_INLINE_REDIS: "1",
      ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
      ALLOW_LIVE_ORDER_PLACEMENT: "0",
      ALLOW_PROD_SIMULATED: "1",
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "0",
      ENABLE_TRADE_ENGINE_IN_PROCESS: "1",
      ALLOW_API_TRADE_ENGINE_FOREGROUND: "1",
      V0_DEV_SYMBOL_COUNT: String(HIGH_SCALE_SYMBOL_STRESS_TARGET),
      ENGINE_SYMBOL_CONCURRENCY: "2",
      STRATEGY_FLOW_SYMBOL_CONCURRENCY: "2",
      // The global Strategy graph lease is deliberately independent of the
      // two symbol lanes above. Match the Linux production install: work
      // inside a graph may overlap, but only one full graph may be retained
      // while memory is healthy unless an operator explicitly profiles more.
      CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS: "1",
      PREHISTORIC_SYMBOL_CONCURRENCY: "1",
      PREHISTORIC_CONFIG_CONCURRENCY: "2",
      PREHISTORIC_CONFIG_TYPE_CONCURRENCY: "1",
      PREHISTORIC_RANGE_HOURS: "1",
      CTS_NODE_HEAP_MB: String(auditHeapMb),
      CTS_MEMORY_LIMIT_MB: String(auditMemoryLimitMb),
      CTS_RSS_SOFT_LIMIT_MB: String(auditRssSoftLimitMb),
      CTS_RSS_HARD_LIMIT_MB: String(auditRssHardLimitMb),
      NODE_OPTIONS: `--max-old-space-size=${auditHeapMb} --max-semi-space-size=128 --expose-gc`,
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      // Non-secret sentinels exercise the X02 masked credential UI contract.
      // FORCE_SIMULATED and ALLOW_LIVE_ORDER_PLACEMENT=0 keep this audit
      // incapable of submitting an exchange order.
      BINGX_X02_API_KEY: "test_x02_audit_key",
      BINGX_X02_API_SECRET: "test_x02_audit_secret",
    },
    stdio: streamServerLogs ? "inherit" : ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", appendOutput)
  child.stderr?.on("data", appendOutput)

  try {
    await waitForReady(child)
    await resolveAuditSymbols()
    if (deepUiAuditRequested) await runDeepUiVerifier()
    const connectionsResponse = await request("/api/connections")
    assert(connectionsResponse.status === 200, "Could not load production connections")
    const connections = Array.isArray(connectionsResponse.data?.connections)
      ? connectionsResponse.data.connections
      : []
    const x01 = connections.find((connection) => String(connection?.id) === "bingx-x01")
    const x02 = connections.find((connection) => String(connection?.id) === "bingx-x02")
    assert(x01 && x02, "Production audit requires the X01 and X02 connection fixtures")

    for (const pathname of [
      "/api/trading/live-positions",
      "/api/trade-engine/pnl-stats",
      "/api/exchange-positions/symbols-stats",
    ]) {
      const response = await request(pathname)
      assert(response.status === 400, `${pathname} silently accepted a missing connection scope`)
    }

    for (const connectionId of [x01.id, x02.id]) {
      const encoded = encodeURIComponent(connectionId)
      const scopedResponses = await Promise.all([
        request(`/api/trading/live-positions?connection_id=${encoded}`),
        request(`/api/trade-engine/pnl-stats?connection_id=${encoded}`),
        request(`/api/exchange-positions/symbols-stats?connection_id=${encoded}`),
        request(`/api/trading/stats?connection_id=${encoded}`),
        request(`/api/data/positions?connectionId=${encoded}`),
        request(`/api/settings/connections/${encoded}/settings`),
      ])
      for (const response of scopedResponses) {
        assert(response.status >= 200 && response.status < 300, `Scoped endpoint failed for ${connectionId}: HTTP ${response.status}`)
      }
      const pnl = scopedResponses[1].data
      assert(pnl?.connectionId === connectionId, `PnL stats crossed connection scope for ${connectionId}`)
    }

    for (const pathname of ["/", "/statistics", "/settings", "/testing/orders"]) {
      await pageCheck(pathname)
    }

    const marker = `inline_audit_${Date.now()}`
    const settingWrite = await request(`/api/settings/connections/${encodeURIComponent(x02.id)}/settings`, {
      method: "PATCH",
      body: { continuity_test_marker: marker },
    })
    assert(settingWrite.status === 200 && settingWrite.data?.success, "Scoped X02 settings write failed")
    const x02Settings = await request(`/api/settings/connections/${encodeURIComponent(x02.id)}/settings`)
    const x01Settings = await request(`/api/settings/connections/${encodeURIComponent(x01.id)}/settings`)
    assert(x02Settings.data?.settings?.continuity_test_marker === marker, "X02 setting did not persist")
    assert(x01Settings.data?.settings?.continuity_test_marker !== marker, "X02 setting leaked into X01")

    const quickStart = await request("/api/trade-engine/quick-start", {
      method: "POST",
      timeoutMs: 120_000,
      body: {
        action: "enable",
        connectionId: x02.id,
        symbols,
        symbolCount: symbols.length,
        liveTrade: false,
        is_live_trade: false,
        baseProfitFactor: 1,
        mainProfitFactor: 1,
        realProfitFactor: 1,
        prevPosMinCount: 1,
        mainEvalPosCount: 1,
        realEvalPosCount: 1,
      },
    })
    assert(quickStart.status === 200, `High-scale QuickStart failed: HTTP ${quickStart.status}`)
    const configuredSymbols = Array.isArray(quickStart.data?.connection?.symbols)
      ? quickStart.data.connection.symbols.map(String)
      : []
    assert(configuredSymbols.length === symbols.length, `QuickStart did not preserve all ${symbols.length} symbols`)
    assert(quickStart.data?.connection?.liveTradeRequested === false, "Safe production audit enabled live trade")
    assert(quickStart.data?.connection?.liveTradeEnabled === false, "Safe production audit enabled live execution")

    const progressionSamples = []
    const latencySamples = []
    const hotPaths = [
      `/api/system/monitoring`,
      `/api/connections/progression/${encodeURIComponent(x02.id)}/stats?view=runtime`,
      `/api/trading/live-positions?connection_id=${encodeURIComponent(x02.id)}`,
      `/api/trade-engine/pnl-stats?connection_id=${encodeURIComponent(x02.id)}`,
      `/api/exchange-positions/symbols-stats?connection_id=${encodeURIComponent(x02.id)}`,
    ]
    for (let round = 0; round < 4; round++) {
      const responses = []
      for (const pathname of hotPaths) responses.push(await request(pathname, { timeoutMs: 60_000 }))
      for (const response of responses) {
        assert(response.status >= 200 && response.status < 300, `Hot API failed: HTTP ${response.status}`)
        latencySamples.push(response.durationMs)
      }
      progressionSamples.push(responses[1].data)
      await sleep(1_500)
    }

    // Wait one telemetry interval so EventLoopUtilization is an interval
    // measurement rather than the documented zero-value first observation.
    await sleep(5_100)
    const freshStats = await request(
      `/api/connections/progression/${encodeURIComponent(x02.id)}/stats?view=runtime`,
      { timeoutMs: 60_000 },
    )
    assert(freshStats.status >= 200 && freshStats.status < 300, "Fresh runtime stats sample failed")
    const monitoring = freshStats.data?.runtime || progressionSamples.at(-1)?.runtime || (await request("/api/system/monitoring")).data
    console.log(JSON.stringify({
      success: true,
      mode: "production-inline-single-worker-simulated",
      symbols: symbols.length,
      symbolSource,
      connectionIsolation: true,
      scopedSettingsReadback: true,
      liveExecution: false,
      realExchangeOrdersSubmitted: 0,
      apiLatencyMs: {
        samples: latencySamples.length,
        p50: Number(percentile(latencySamples, 0.5).toFixed(2)),
        p95: Number(percentile(latencySamples, 0.95).toFixed(2)),
        max: Number(Math.max(...latencySamples).toFixed(2)),
      },
      runtime: monitoring,
    }, null, 2))
  } finally {
    await stopServer(child)
    await rm(snapshotPath, { force: true })
    await rm(`${snapshotPath}.live-wal`, { force: true })
  }
}

main().catch((error) => {
  console.error("[run-production-inline-ui-audit] failed:", error instanceof Error ? error.message : String(error))
  if (outputTail) {
    // Keep failures actionable without allowing verbose production logs to
    // drown out the audit result in constrained CI/agent terminals.
    console.error(`[run-production-inline-ui-audit] server tail:\n${outputTail.slice(-4_000)}`)
  }
  process.exitCode = 1
})
