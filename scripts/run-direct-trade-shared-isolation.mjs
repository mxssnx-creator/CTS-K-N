#!/usr/bin/env node

/**
 * Production Direct-Trade multi-connection isolation/recovery verifier.
 *
 * The harness runs the real standalone app, a real shared Redis server and
 * the shipped Direct-Trade supervisor.  Two BingX connection scopes calculate
 * and tick concurrently, while all exchange credentials and live-order gates
 * remain disabled.  It proves that Stop/Start and settings changes cannot
 * steal another connection's lease, counters or configuration.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import process from "node:process"
import { startPreviewRedisHarness } from "./preview-redis-harness.mjs"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_SHARED_PORT) || 3138))
const baseUrl = `http://127.0.0.1:${port}`
const distDir = process.env.NEXT_DIST_DIR || ".next-prod"
const processorToken = `shared-isolation-${process.pid}-${Date.now()}`
const targetIds = ["bingx-x01", "bingx-x02"]
let outputTail = ""

function keepTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-32_000)
  if (process.env.DIRECT_TRADE_SHARED_LOGS === "1") process.stderr.write(chunk)
}

async function request(pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    cache: "no-store",
    signal: AbortSignal.timeout(Number(options.timeoutMs || 180_000)),
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body,
  })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = { raw: text.slice(0, 500) } }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} returned ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

async function waitFor(label, read, accept, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    try {
      latest = await read()
      if (accept(latest)) return latest
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(latest)}`)
}

function signalGroup(child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

async function stopChild(child) {
  if (!child?.pid) return
  signalGroup(child, "SIGTERM")
  if (child.exitCode == null && child.signalCode == null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ])
  }
  signalGroup(child, "SIGKILL")
}

function scoped(pathname, connectionId) {
  const joiner = pathname.includes("?") ? "&" : "?"
  return `${pathname}${joiner}connectionId=${encodeURIComponent(connectionId)}`
}

async function directInventory() {
  return request("/api/trade-engine/direct-trade?view=connections")
}

function inventoryEntry(payload, connectionId) {
  return Array.isArray(payload?.connections)
    ? payload.connections.find((entry) => String(entry?.connectionId) === connectionId)
    : null
}

async function setDirectState(connectionId, action, extra = {}) {
  return request("/api/trade-engine/direct-trade", {
    method: "POST",
    body: { action, connectionId, ...extra },
  })
}

async function main() {
  if (!existsSync(`${distDir}/BUILD_ID`)) {
    throw new Error(`Production build not found in ${distDir}`)
  }
  const redis = await startPreviewRedisHarness({ required: true, label: "Direct-Trade shared isolation" })
  const runtimeEnvironment = {
    ...process.env,
    ...redis.environment,
    NODE_ENV: "production",
    NEXT_DIST_DIR: distDir,
    HOST: "127.0.0.1",
    PORT: String(port),
    FORCE_SIMULATED: "1",
    FORCE_LIVE: "0",
    ALLOW_PROD_SIMULATED: "1",
    ALLOW_PROD_INLINE_REDIS: "0",
    ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
    DIRECT_TRADE_SYNTHETIC_MARKET_DATA: "1",
    DIRECT_TRADE_PROCESSOR_TOKEN: processorToken,
    DISABLE_TRADE_ENGINE_AUTOSTART: "1",
    DISABLE_TRADE_ENGINE_IN_PROCESS: "1",
    DISABLE_IN_PROCESS_CONTINUITY: "1",
    BINGX_API_KEY: "",
    BINGX_API_SECRET: "",
    BINGX_X01_API_KEY: "",
    BINGX_X01_API_SECRET: "",
    BINGX_X02_API_KEY: "",
    BINGX_X02_API_SECRET: "",
    BYBIT_API_KEY: "",
    BYBIT_API_SECRET: "",
    CTS_NODE_HEAP_MB: process.env.DIRECT_TRADE_SHARED_APP_HEAP_MB || "3072",
  }
  let server
  let supervisor
  try {
    server = spawn(process.execPath, ["scripts/start-production.mjs"], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: runtimeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout?.on("data", keepTail)
    server.stderr?.on("data", keepTail)
    await waitFor(
      "production server readiness",
      () => request("/api/health/liveness", { timeoutMs: 3_000 }),
      (payload) => Boolean(payload),
      90_000,
    )

    const connections = await request("/api/connections")
    const available = new Set((connections?.connections || []).map((entry) => String(entry?.id || "")))
    for (const connectionId of targetIds) {
      if (!available.has(connectionId)) throw new Error(`Required test connection ${connectionId} is missing`)
      await setDirectState(connectionId, "start", {
        liveMode: false,
        symbolCount: 1,
        historyHours: 48,
        timeframes: ["5m"],
        strategyTypes: [
          "standard", "trailing_fixed", "trailing_auto", "combination",
          "inverse", "high_protection", "dca",
        ],
        entryTactics: ["relative"],
        exitTactics: ["bracket"],
        takeProfitRatioRange: [5, 5],
        takeProfitRatioStep: 1,
        blockRange: [1, 2],
        maxTotalPositions: 4,
        maxPositionsPerSymbol: 2,
        maxPositionsPerDirection: 1,
        minProfitFactor: 1.1,
        minRecentProfitFactor: 1.1,
        trailingEnabled: true,
      })
    }

    supervisor = spawn(process.execPath, ["scripts/direct-trade-supervisor.mjs", "--port", String(port)], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: {
        ...runtimeEnvironment,
        CTS_DIRECT_TRADE_MAX_CONNECTION_WORKERS: "2",
        CTS_DIRECT_TRADE_SUPERVISOR_POLL_MS: "1000",
        CTS_DIRECT_TRADE_WORKER_HEAP_MB: process.env.DIRECT_TRADE_SHARED_WORKER_HEAP_MB || "512",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    supervisor.stdout?.on("data", keepTail)
    supervisor.stderr?.on("data", keepTail)

    const initialInventory = await waitFor(
      "two independent Direct-Trade workers",
      directInventory,
      (payload) => targetIds.every((connectionId) => {
        const entry = inventoryEntry(payload, connectionId)
        return entry?.enabled === true
          && Number(entry?.processor?.tickCount || 0) >= 3
          && Boolean(entry?.processor?.instanceId)
      }),
      240_000,
    )
    const initial = Object.fromEntries(targetIds.map((connectionId) => {
      const processor = inventoryEntry(initialInventory, connectionId).processor
      return [connectionId, {
        instanceId: String(processor.instanceId),
        tickCount: Number(processor.tickCount || 0),
      }]
    }))
    if (initial[targetIds[0]].instanceId === initial[targetIds[1]].instanceId) {
      throw new Error("Two connection scopes published the same processor identity")
    }

    await setDirectState("bingx-x02", "update-config", { minVolFactor: 0.37 })
    const [x01State, x02State] = await Promise.all([
      request(scoped("/api/trade-engine/direct-trade", "bingx-x01")),
      request(scoped("/api/trade-engine/direct-trade", "bingx-x02")),
    ])
    if (Number(x01State?.state?.minVolFactor) === 0.37 || Number(x02State?.state?.minVolFactor) !== 0.37) {
      throw new Error("Connection-specific Direct-Trade settings leaked between X01 and X02")
    }

    await setDirectState("bingx-x01", "stop")
    const x02AfterStop = await waitFor(
      "X02 continuation while X01 is stopped",
      directInventory,
      (payload) => {
        const x01 = inventoryEntry(payload, "bingx-x01")
        const x02 = inventoryEntry(payload, "bingx-x02")
        return x01?.enabled === false && Number(x02?.processor?.tickCount || 0) > initial["bingx-x02"].tickCount
      },
      30_000,
    )
    const x02TickAfterSiblingStop = Number(inventoryEntry(x02AfterStop, "bingx-x02")?.processor?.tickCount || 0)

    // Exercise rapid operator toggles. The supervisor keeps the old child in
    // its map until the real exit event, so this sequence must end with one
    // fresh owner rather than two overlapping processors.
    await setDirectState("bingx-x01", "start", { liveMode: false })
    await setDirectState("bingx-x01", "stop")
    await setDirectState("bingx-x01", "start", { liveMode: false })
    const restartedInventory = await waitFor(
      "X01 worker recovery after rapid toggles",
      directInventory,
      (payload) => {
        const x01 = inventoryEntry(payload, "bingx-x01")
        const x02 = inventoryEntry(payload, "bingx-x02")
        return x01?.enabled === true
          && Boolean(x01?.processor?.instanceId)
          && String(x01.processor.instanceId) !== initial["bingx-x01"].instanceId
          && Number(x01.processor.tickCount || 0) >= 2
          && Number(x02?.processor?.tickCount || 0) > x02TickAfterSiblingStop
      },
      60_000,
    )

    const statuses = await Promise.all(targetIds.map((connectionId) => request(scoped(
      "/api/trade-engine/direct-trade/status",
      connectionId,
    ))))
    if (statuses.some((status) => status?.processorRequired !== true || status?.processorHealthy !== true)) {
      throw new Error(`Scoped processor health is inconsistent: ${JSON.stringify(statuses)}`)
    }
    if (statuses.some((status) => status?.state?.liveMode === true)) {
      throw new Error("Shared isolation harness left safe paper mode")
    }

    await Promise.all(targetIds.map((connectionId) => setDirectState(connectionId, "stop")))
    const finalInventory = await directInventory()
    console.log(JSON.stringify({
      success: true,
      test: "direct-trade-shared-connection-isolation",
      redisBackend: redis.kind,
      productionStandalone: true,
      connectionIds: targetIds,
      independentProcessorIds: initial[targetIds[0]].instanceId !== initial[targetIds[1]].instanceId,
      x02TickedWhileX01Stopped: true,
      settingsIsolationVerified: true,
      rapidToggleRecoveryVerified: true,
      processors: Object.fromEntries(targetIds.map((connectionId) => {
        const entry = inventoryEntry(restartedInventory, connectionId)
        return [connectionId, {
          instanceId: entry?.processor?.instanceId || null,
          tickCount: Number(entry?.processor?.tickCount || 0),
        }]
      })),
      finalEnabled: Object.fromEntries(targetIds.map((connectionId) => [
        connectionId,
        inventoryEntry(finalInventory, connectionId)?.enabled === true,
      ])),
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    if (supervisor) await stopChild(supervisor)
    if (server) await stopChild(server)
    await redis.stop()
  }
}

main().catch((error) => {
  console.error("[direct-trade-shared-isolation]", error instanceof Error ? error.message : String(error))
  if (outputTail) console.error(`[direct-trade-shared-isolation] runtime tail:\n${outputTail}`)
  process.exitCode = 1
})
