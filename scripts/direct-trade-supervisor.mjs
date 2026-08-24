#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const portIndex = args.indexOf("--port")
const port = String(process.env.PORT || (portIndex >= 0 ? args[portIndex + 1] : "3002") || "3002")
const base = `http://127.0.0.1:${port}`
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const processorPath = path.join(scriptDir, "direct-trade-processor.mjs")
const maximumWorkers = Math.max(1, Math.min(32, Number(process.env.CTS_DIRECT_TRADE_MAX_CONNECTION_WORKERS) || 8))
const pollMs = Math.max(1_000, Math.min(15_000, Number(process.env.CTS_DIRECT_TRADE_SUPERVISOR_POLL_MS) || 2_000))
const workerHeapMb = Math.max(128, Math.min(2_048, Number(process.env.CTS_DIRECT_TRADE_WORKER_HEAP_MB) || 256))
const children = new Map()
let stopping = false

function log(message) {
  console.log(`[${new Date().toISOString()}] [Direct-Trade Supervisor] ${message}`)
}

function validConnectionId(value) {
  const id = typeof value === "string" ? value.trim() : ""
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : null
}

function startWorker(connectionId) {
  if (children.has(connectionId) || stopping) return
  const child = spawn(process.execPath, [processorPath, "--port", port, "--connection-id", connectionId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIRECT_TRADE_CONNECTION_ID: connectionId,
      // MemoryMax belongs to the entire systemd/PM2 Direct-Trade service,
      // not to each child. Give every connection worker its calculated slice
      // so parallel X01/X02/Bybit scopes cannot collectively overcommit it.
      NODE_OPTIONS: `--max-old-space-size=${workerHeapMb} --max-semi-space-size=64`,
    },
    stdio: "inherit",
  })
  const entry = { child, stopping: false, killTimer: null }
  children.set(connectionId, entry)
  log(`started connection worker ${connectionId} (pid ${child.pid || "pending"})`)
  child.once("exit", (code, signal) => {
    if (entry.killTimer) clearTimeout(entry.killTimer)
    if (children.get(connectionId) === entry) children.delete(connectionId)
    log(`connection worker ${connectionId} exited (${signal || code || 0})`)
  })
}

function stopWorker(connectionId, signal = "SIGTERM") {
  const entry = children.get(connectionId)
  if (!entry || entry.stopping) return
  entry.stopping = true
  if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill(signal)
  entry.killTimer = setTimeout(() => {
    if (children.get(connectionId) === entry) {
      entry.child.kill("SIGKILL")
      log(`force-stopped connection worker ${connectionId} after timeout`)
    }
  }, 10_000)
  entry.killTimer.unref?.()
  log(`stopping idle connection worker ${connectionId}`)
}

async function desiredConnections() {
  const response = await fetch(`${base}/api/trade-engine/direct-trade?view=connections`, {
    signal: AbortSignal.timeout(5_000),
    headers: { "Cache-Control": "no-cache" },
  })
  if (!response.ok) throw new Error(`connection inventory returned ${response.status}`)
  const payload = await response.json()
  const desired = []
  for (const entry of Array.isArray(payload?.connections) ? payload.connections : []) {
    const connectionId = validConnectionId(entry?.connectionId)
    if (!connectionId) continue
    const openPositions = Math.max(0, Number(entry?.openPositions || 0) || 0)
    const accountingPending = Math.max(0, Number(entry?.accountingPending || 0) || 0)
    if (entry?.enabled === true || openPositions > 0 || accountingPending > 0) {
      desired.push({
        connectionId,
        enabled: entry?.enabled === true,
        openPositions,
        accountingPending,
        managedCount: openPositions + accountingPending,
      })
    }
  }
  const unique = new Map()
  for (const entry of desired) unique.set(entry.connectionId, entry)
  return [...unique.values()].sort((left, right) =>
    Number(right.managedCount > 0) - Number(left.managedCount > 0)
      || right.managedCount - left.managedCount
      || left.connectionId.localeCompare(right.connectionId),
  )
}

async function reconcile() {
  const desired = await desiredConnections()
  // Recovery owns priority. Every scope with non-terminal positions gets a
  // worker, as does a terminal live row whose exact exchange settlement is
  // pending. This remains reconcile-only when that scope is disabled.
  const recovery = desired.filter((entry) => entry.managedCount > 0)
  const selectedEntries = [...recovery]
  for (const entry of desired) {
    if (selectedEntries.some((selected) => selected.connectionId === entry.connectionId)) continue
    if (selectedEntries.length >= Math.max(maximumWorkers, recovery.length)) break
    selectedEntries.push(entry)
  }
  const selected = new Set(selectedEntries.map((entry) => entry.connectionId))
  if (desired.length > selected.size) {
    log(`worker limit ${maximumWorkers} reached; ${desired.length - selected.size} idle connection(s) remain queued`)
  }
  for (const connectionId of selected) startWorker(connectionId)
  for (const connectionId of [...children.keys()]) {
    if (!selected.has(connectionId)) stopWorker(connectionId)
  }
}

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`received ${signal}; stopping ${children.size} connection worker(s)`)
  for (const connectionId of [...children.keys()]) stopWorker(connectionId)
  const deadline = Date.now() + 10_000
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  for (const entry of children.values()) {
    entry.child.kill("SIGKILL")
  }
  process.exit(0)
}

process.on("SIGTERM", () => { void shutdown("SIGTERM") })
process.on("SIGINT", () => { void shutdown("SIGINT") })

log(`starting for ${base}; max workers=${maximumWorkers}; worker heap=${workerHeapMb} MiB`)
while (!stopping) {
  try {
    await reconcile()
  } catch (error) {
    log(`inventory failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs))
}
