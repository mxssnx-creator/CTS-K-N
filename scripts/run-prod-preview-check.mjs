#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import process from "node:process"

const port = Number(process.env.PORT || 3102)
const baseUrl = `http://127.0.0.1:${port}`
const distDir = process.env.NEXT_DIST_DIR || ".next-prod"
let outputTail = ""
const snapshotPath = `/tmp/cts-prod-preview-${process.pid}.json`
const UI_MAX_SYMBOLS = 32
const PREVIEW_CRON_SECRET = "prod-preview-cron-secret-1234567890"
const maxSymbolsRequested = process.argv.includes("--max-symbols")
const uiOnlyRequested = process.argv.includes("--ui-only")
const productionSoakSymbolCount = maxSymbolsRequested || uiOnlyRequested
  ? UI_MAX_SYMBOLS
  : Math.max(1, Math.min(UI_MAX_SYMBOLS, Number(process.env.PROD_SOAK_SYMBOL_COUNT || 12)))
const soakSymbols = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
  "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
  "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
  "ICPUSDT", "HBARUSDT",
].slice(0, productionSoakSymbolCount)

// A prior interrupted invocation can leave the PID-derived snapshot behind.
// Every harness run must begin from a clean database so restart persistence is
// proven within this invocation instead of inheriting yesterday's result.
rmSync(snapshotPath, { force: true })

function keepTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-12_000)
  if (process.env.PROD_PREVIEW_SERVER_LOGS === "1") {
    process.stderr.write(chunk)
  }
}

async function waitForReady(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Preview server exited with ${child.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Preview server did not become ready\n${outputTail}`)
}

function runVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-preview.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        PORT: String(port),
        REQUIRE_FRESH_CONTINUITY: "1",
      },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Preview verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

function runPostDeployVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn("bash", ["scripts/post-deploy-verify.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEPLOYMENT_URL: baseUrl,
        CRON_SECRET: PREVIEW_CRON_SECRET,
      },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Post-deploy verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

function runSoakVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        PORT: String(port),
        START_SIMULATED_ENGINE: "1",
        SYMBOL_COUNT: String(productionSoakSymbolCount),
        SOAK_DURATION_MS: process.env.PROD_SOAK_DURATION_MS || (maxSymbolsRequested ? "240000" : "120000"),
        RUNTIME_MODE: "production",
      },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Production soak verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

function runUiMaxVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-ui-max.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, BASE_URL: baseUrl, PORT: String(port) },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Production UI max-symbol verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} returned ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

function startServer({ engines = false } = {}) {
  const child = spawn(process.execPath, ["scripts/start-production.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_DIST_DIR: distDir,
      HOST: "127.0.0.1",
      // The engine soak starts its exact basket through the awaited QuickStart
      // request below. Keep boot auto-start off in this harness so a default
      // migration basket cannot begin a stale prehistoric generation before
      // the test has asserted the explicit 12-symbol/Paper configuration.
      // Production auto-start/healing is exercised by its dedicated unit and
      // restart-state tests; the shipped default remains enabled.
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: engines ? "0" : "1",
      DISABLE_IN_PROCESS_CONTINUITY: engines ? "0" : "1",
      ALLOW_PROD_INLINE_REDIS: "1",
      ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
      ALLOW_PROD_SIMULATED: "1",
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      V0_DEV_SYMBOL_COUNT: engines ? String(productionSoakSymbolCount) : "4",
      ENGINE_SYMBOL_CONCURRENCY: engines ? (process.env.PREVIEW_ENGINE_SYMBOL_CONCURRENCY || "2") : "1",
      STRATEGY_FLOW_SYMBOL_CONCURRENCY: engines ? (process.env.PREVIEW_STRATEGY_SYMBOL_CONCURRENCY || "2") : "1",
      PREHISTORIC_SYMBOL_CONCURRENCY: process.env.PREVIEW_PREHISTORIC_SYMBOL_CONCURRENCY || "1",
      MARKET_DATA_LOAD_CONCURRENCY: "1",
      CRON_SYMBOL_LIMIT: engines ? String(productionSoakSymbolCount) : "4",
      CRON_SECRET: PREVIEW_CRON_SECRET,
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      PIONEX_API_KEY: "",
      PIONEX_API_SECRET: "",
      ORANGEX_API_KEY: "",
      ORANGEX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NODE_OPTIONS: "--max-old-space-size=5632 --max-semi-space-size=256 --expose-gc",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", keepTail)
  child.stderr.on("data", keepTail)
  return child
}

async function readRestartState() {
  const init = await requestJson("/api/system/init-status")
  const connections = await requestJson("/api/connections")
  const connectionId = String(connections?.connections?.[0]?.id || "")
  if (!init?.ready || !init?.system?.site_instance_id || !init?.system?.startup?.boot_id) {
    throw new Error(`Invalid restart state: ${JSON.stringify(init)}`)
  }
  return {
    siteInstanceId: init.system.site_instance_id,
    bootId: init.system.startup.boot_id,
    schemaVersion: Number(init.migrations.current_version),
    latestSchemaVersion: Number(init.migrations.latest_version),
    connectionId,
  }
}

async function verifyDatabaseActivityMetrics() {
  const [monitoring, comprehensive, systemStats] = await Promise.all([
    requestJson("/api/system/monitoring"),
    requestJson("/api/monitoring/comprehensive"),
    requestJson("/api/main/system-stats-v3"),
  ])
  const observedRates = [
    Number(monitoring?.database?.requestsPerSecond || 0),
    Number(comprehensive?.database?.requestsPerSecond || 0),
    Number(systemStats?.database?.requestsPerSecond || 0),
  ]
  if (observedRates.some((rate) => !Number.isFinite(rate) || rate <= 0)) {
    throw new Error(`Production database request-rate metric is inactive: ${JSON.stringify(observedRates)}`)
  }
  if (comprehensive?.database?.connected !== true) {
    throw new Error("Comprehensive production monitoring does not report a connected database")
  }
  return observedRates
}

async function stopServer(child) {
  if (child.exitCode != null || child.signalCode != null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
}

async function crashServer(child) {
  if (child.exitCode != null || child.signalCode != null) return
  // A graceful stop proves service lifecycle, but not recovery from a process
  // crash between position writes and the next reconcile loop. Use SIGKILL in
  // this isolated snapshot harness so the next boot must recover only from
  // durable state.
  child.kill("SIGKILL")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode == null && child.signalCode == null) {
    throw new Error("Production engine did not terminate during crash-recovery verification")
  }
}

function activePositionSnapshot(payload) {
  const rows = Array.isArray(payload?.positions) ? payload.positions : []
  const byId = new Map()
  const active = new Map()
  for (const position of rows) {
    const id = String(position?.id || "").trim()
    if (!id) throw new Error("Live-position recovery response contains a position without a stable id")
    if (byId.has(id)) throw new Error(`Live-position recovery response contains duplicate id ${id}`)
    byId.set(id, position)
    if (!["closed", "rejected", "error"].includes(String(position?.status || "").toLowerCase())) {
      active.set(id, position)
    }
  }
  return { byId, active }
}

async function verifyOpenPositionCrashRecovery(currentEngineServer, connectionId, beforeSiteInstanceId) {
  const beforePayload = await requestJson(`/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&closedLimit=500`)
  const before = activePositionSnapshot(beforePayload)
  if (before.active.size === 0) {
    throw new Error("Crash-recovery verification needs at least one active simulated position")
  }
  if (beforePayload?.dataIntegrity?.liveExecutionMode !== "simulation" || beforePayload?.dataIntegrity?.liveTradeRequested !== false) {
    throw new Error("Crash-recovery verification left safe simulation mode")
  }

  await crashServer(currentEngineServer)
  const recoveredEngineServer = startServer({ engines: true })
  await waitForReady(recoveredEngineServer)

  const restarted = await readRestartState()
  if (restarted.siteInstanceId !== beforeSiteInstanceId) {
    throw new Error("Site identity rotated after an engine crash")
  }

  // Invoke the independent engine-down safety net once. With a live connector
  // this adopts/reconciles venue positions; in this forced-paper run it still
  // proves the authenticated recovery path is callable without issuing orders.
  const recoveryTick = await requestJson("/api/cron/sync-live-positions", {
    headers: { Authorization: `Bearer ${PREVIEW_CRON_SECRET}` },
  })
  if (recoveryTick?.ok !== true) throw new Error(`Authorized live-position recovery tick did not succeed after crash: ${JSON.stringify(recoveryTick)}`)

  await new Promise((resolve) => setTimeout(resolve, 750))
  const afterPayload = await requestJson(`/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&closedLimit=500`)
  const after = activePositionSnapshot(afterPayload)
  for (const [id, position] of before.active) {
    const recovered = after.byId.get(id)
    if (!recovered) throw new Error(`Position ${id} disappeared after crash instead of being reconciled`)
    if (["rejected", "error"].includes(String(recovered?.status || "").toLowerCase())) {
      throw new Error(`Position ${id} became ${recovered.status} after crash recovery`)
    }
    const beforeQuantity = Number(position?.totalExecutedQuantity ?? position?.executedQuantity ?? 0)
    const afterQuantity = Number(recovered?.totalExecutedQuantity ?? recovered?.executedQuantity ?? 0)
    if (Number.isFinite(beforeQuantity) && Number.isFinite(afterQuantity) && afterQuantity + 1e-10 < beforeQuantity) {
      throw new Error(`Position ${id} quantity regressed after crash recovery`)
    }
  }
  if (Number(afterPayload?.counts?.pending || 0) > 0 || Number(afterPayload?.counts?.placed || 0) > 0) {
    throw new Error("Crash recovery left pending or unconfirmed live positions stranded")
  }
  return {
    server: recoveredEngineServer,
    details: {
      crashRecoveredPositions: before.active.size,
      recoveredActivePositions: after.active.size,
      recoveryTickSkipped: recoveryTick?.skipped === true,
    },
  }
}

async function main() {
  if (!existsSync(`${distDir}/BUILD_ID`)) {
    throw new Error(`Production build not found in ${distDir}; run NEXT_DIST_DIR=${distDir} npm run build first`)
  }

  let firstServer
  let secondServer
  let engineServer

  try {
    if (uiOnlyRequested) {
      // Focused production-client workflow for changes to Main Connection UI
      // and settings APIs. It keeps the same forced-simulation/empty-credential
      // safety envelope as the full harness but skips the already-independent
      // restart and four-minute soak phases.
      engineServer = startServer({ engines: true })
      await waitForReady(engineServer)
      await runUiMaxVerifier()
      console.log(JSON.stringify({
        success: true,
        productionUiOnly: true,
        productionUiMaxSymbolsVerified: true,
        simulatedEngineSymbols: UI_MAX_SYMBOLS,
        realExchangeOrdersSubmitted: 0,
      }, null, 2))
      return
    }

    firstServer = startServer()
    await waitForReady(firstServer)
    await runPostDeployVerifier()
    await runVerifier()
    const before = await readRestartState()
    if (!before.connectionId) throw new Error("No connection available for restart persistence check")

    const marker = `restart_${Date.now()}`
    const update = await requestJson(
      `/api/settings/connections/${encodeURIComponent(before.connectionId)}/settings`,
      { method: "PATCH", body: JSON.stringify({ continuity_test_marker: marker }) },
    )
    if (!update?.success) throw new Error("Could not persist restart continuity marker")

    await stopServer(firstServer)
    firstServer = undefined

    secondServer = startServer()
    await waitForReady(secondServer)
    await runVerifier()
    const after = await readRestartState()
    const settings = await requestJson(
      `/api/settings/connections/${encodeURIComponent(after.connectionId)}/settings`,
    )

    if (after.siteInstanceId !== before.siteInstanceId) throw new Error("Site identity rotated across production restart")
    if (after.bootId === before.bootId) throw new Error("Production restart did not create a new process boot identity")
    if (after.schemaVersion !== after.latestSchemaVersion) throw new Error("Migrations are incomplete after production restart")
    if (String(settings?.settings?.continuity_test_marker || "") !== marker) {
      throw new Error("Saved connection settings did not survive production restart")
    }

    // Persist the exact safe soak basket before the real production auto-start
    // boot. Starting with the migration's default 20-symbol/live-requested
    // template and changing it only after auto-start races two expensive
    // prehistoric generations: the stale bootstrap can keep allocating and
    // writing while the newly selected basket is already active. This setup is
    // also a restart-persistence assertion for QuickStart settings: the third
    // process must auto-start directly on this exact paper-only basket.
    const preconfigured = await requestJson("/api/trade-engine/quick-start", {
      method: "POST",
      body: JSON.stringify({
        action: "enable",
        connectionId: after.connectionId,
        symbols: soakSymbols,
        symbolCount: soakSymbols.length,
        liveTrade: false,
        is_live_trade: false,
        baseProfitFactor: 0.75,
        mainProfitFactor: 0.75,
        realProfitFactor: 0.75,
        prevPosMinCount: 1,
        mainEvalPosCount: 1,
        realEvalPosCount: 1,
      }),
    })
    const persistedSymbols = Array.isArray(preconfigured?.connection?.symbols)
      ? preconfigured.connection.symbols.map(String)
      : []
    if (
      persistedSymbols.length !== soakSymbols.length ||
      persistedSymbols.some((symbol, index) => symbol !== soakSymbols[index]) ||
      preconfigured?.connection?.liveTradeRequested !== false ||
      preconfigured?.connection?.liveTradeEnabled !== false
    ) {
      throw new Error("Could not persist the safe production soak basket before auto-start")
    }

    await stopServer(secondServer)
    secondServer = undefined

    // Third boot enables the real production coordinator and in-process minute
    // scheduler, but FORCE_SIMULATED=1 plus empty credentials guarantees that
    // no exchange order can be submitted. The soak races start requests and
    // polls all engine/UI coordination surfaces for more than one minute.
    engineServer = startServer({ engines: true })
    await waitForReady(engineServer)
    const engineBoot = await readRestartState()
    if (engineBoot.siteInstanceId !== before.siteInstanceId) {
      throw new Error("Site identity rotated before simulated engine soak")
    }
    await runSoakVerifier()
    const crashRecovery = await verifyOpenPositionCrashRecovery(engineServer, after.connectionId, before.siteInstanceId)
    engineServer = crashRecovery.server
    const databaseRequestRates = await verifyDatabaseActivityMetrics()
    if (maxSymbolsRequested) await runUiMaxVerifier()

    console.log(JSON.stringify({
      success: true,
      productionRestartVerified: true,
      siteInstanceId: after.siteInstanceId,
      bootIdBefore: before.bootId,
      bootIdAfter: after.bootId,
      schemaVersion: after.schemaVersion,
      settingsPersisted: true,
      simulatedEngineSoakVerified: true,
      crashRecoveryVerified: true,
      ...crashRecovery.details,
      databaseRequestRates,
      simulatedEngineSymbols: productionSoakSymbolCount,
      productionUiMaxSymbolsVerified: maxSymbolsRequested,
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    if (firstServer) await stopServer(firstServer)
    if (secondServer) await stopServer(secondServer)
    if (engineServer) await stopServer(engineServer)
  }
}

main().catch((error) => {
  console.error("[run-prod-preview-check] failed:", error instanceof Error ? error.message : String(error))
  if (outputTail) console.error(`[run-prod-preview-check] server tail:\n${outputTail}`)
  process.exit(1)
})
