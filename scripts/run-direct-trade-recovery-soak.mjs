#!/usr/bin/env node
/**
 * Runs the Direct-Trade recovery contract against a real paper-only dev API.
 * It intentionally SIGKILLs the dev server between phases, preserving only
 * the inline Redis snapshot; no trade processor or exchange credential exists
 * in this harness.
 */

import { execFileSync, spawn } from "node:child_process"
import { readFileSync, readdirSync, readlinkSync } from "node:fs"
import net from "node:net"
import process from "node:process"

const initialPort = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_RECOVERY_PORT) || 3126))
let port = initialPort
let baseUrl = `http://127.0.0.1:${port}`
const snapshotPath = `/tmp/cts-direct-trade-recovery-${process.pid}.json`
let server = null
let outputTail = ""

function nextServerProcessIds() {
  if (process.platform === "win32") return []
  let entries = []
  try {
    entries = readdirSync("/proc", { withFileTypes: true })
  } catch {
    return []
  }
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const command = readFileSync(`/proc/${entry.name}/comm`, "utf8").trim()
      if (command.startsWith("next-server")) pids.push(Number(entry.name))
    } catch {
      // The process may exit while /proc is being inspected.
    }
  }
  return pids.filter((pid) => Number.isInteger(pid) && pid > 0)
}

function listeningProcessIds(targetPort) {
  if (process.platform === "win32") return []
  const portHex = Number(targetPort).toString(16).toUpperCase().padStart(4, "0")
  const socketInodes = new Set()
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let contents = ""
    try {
      contents = readFileSync(table, "utf8")
    } catch {
      continue
    }
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10 || fields[3] !== "0A") continue
      const localAddress = fields[1] || ""
      if (!localAddress.endsWith(`:${portHex}`)) continue
      socketInodes.add(fields[9])
    }
  }
  if (socketInodes.size === 0) return []
  let entries = []
  try {
    entries = readdirSync("/proc", { withFileTypes: true })
  } catch {
    return []
  }
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    let descriptors = []
    try {
      descriptors = readdirSync(`/proc/${entry.name}/fd`)
    } catch {
      continue
    }
    for (const descriptor of descriptors) {
      try {
        const target = readlinkSync(`/proc/${entry.name}/fd/${descriptor}`)
        const match = /^socket:\[(\d+)\]$/.exec(target)
        if (match && socketInodes.has(match[1])) {
          pids.push(Number(entry.name))
          break
        }
      } catch {
        // A descriptor can disappear while the process exits.
      }
    }
  }
  return pids.filter((pid) => Number.isInteger(pid) && pid > 0)
}

function appendTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-24_000)
}

function serverEnv() {
  return {
    ...process.env,
    FORCE_SIMULATED: "1",
    DIRECT_TRADE_TEST_LEASE_MS: "350",
    FORCE_LIVE: "0",
    DIRECT_TRADE_SYNTHETIC_MARKET_DATA: "1",
    DISABLE_TRADE_ENGINE_AUTOSTART: "1",
    DISABLE_TRADE_ENGINE_IN_PROCESS: "1",
    DISABLE_IN_PROCESS_CONTINUITY: "1",
    BINGX_API_KEY: "",
    BINGX_API_SECRET: "",
    BYBIT_API_KEY: "",
    BYBIT_API_SECRET: "",
    V0_REDIS_SNAPSHOT_PATH: snapshotPath,
    PORT: String(port),
    NODE_OPTIONS: process.env.DIRECT_TRADE_RECOVERY_NODE_OPTIONS || "--max-old-space-size=2048",
  }
}

async function waitForReady() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`Dev server exited ${server.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        const before = server?.nextServerBefore || new Set()
        server.nextServerPids = new Set(nextServerProcessIds().filter((pid) => !before.has(pid)))
        return
      }
    } catch { /* compiling */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dev server did not become ready\n${outputTail}`)
}

function startServer() {
  const nextServerBefore = new Set(nextServerProcessIds())
  const listeningBefore = new Set(listeningProcessIds(port))
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.nextServerBefore = nextServerBefore
  server.nextServerPids = new Set()
  server.listeningBefore = listeningBefore
  server.stdout.on("data", appendTail)
  server.stderr.on("data", appendTail)
}

function childProcessIds(rootPid) {
  if (process.platform === "win32") return []
  const children = []
  const visit = (pid) => {
    let direct = []
    try {
      direct = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    } catch {
      direct = []
    }
    for (const childPid of direct) {
      if (children.includes(childPid)) continue
      children.push(childPid)
      visit(childPid)
    }
  }
  visit(rootPid)
  return children
}

function processGroupId(pid) {
  if (process.platform === "win32") return null
  try {
    // /proc/<pid>/stat fields after the closing command name are:
    // state, ppid, pgrp. Only use a negative-PID signal when pgrp is the
    // exact detached child we created, never for an inherited runner group.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const commandEnd = stat.lastIndexOf(") ")
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    return Number(fields[2]) || null
  } catch {
    return null
  }
}

function signalProcessTree(rootPid, signal) {
  const ownProcessGroup = processGroupId(rootPid)
  if (ownProcessGroup === rootPid) {
    try {
      process.kill(-rootPid, signal)
      return [rootPid]
    } catch {
      // Fall back to exact descendant signalling if the runner disallows
      // process-group signalling despite the verified group ownership.
    }
  }
  const pids = [...childProcessIds(rootPid).reverse(), rootPid]
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process can exit between discovery and signalling.
    }
  }
  return pids
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

async function waitForPortFree(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortOpen())) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Port ${port} remained occupied after simulated crash cleanup`)
}

function useRestartPort(restartPort) {
  port = Math.max(1024, Math.floor(Number(restartPort)))
  baseUrl = `http://127.0.0.1:${port}`
}

async function stopServer(signal = "SIGTERM") {
  const child = server
  if (!child?.pid) {
    server = null
    return
  }
  // Do not signal a negative process group here. Some constrained runners
  // place the harness and its child in a shared group, which would turn this
  // deliberately targeted simulated crash into a test-runner crash as well.
  // Next can leave a compiler/server child alive after the direct parent is
  // killed. Discover the exact descendant tree before signalling the parent;
  // this avoids both an orphaned port and an unsafe process-group kill.
  const observedNextServers = new Set([
    ...(child.nextServerPids || []),
    ...nextServerProcessIds().filter((pid) => !(child.nextServerBefore || new Set()).has(pid)),
  ])
  const observedPortProcesses = listeningProcessIds(port)
    .filter((pid) => !(child.listeningBefore || new Set()).has(pid))
  if (process.env.DIRECT_TRADE_RECOVERY_DEBUG === "1") {
    console.log(JSON.stringify({
      recoveryProcessCleanup: true,
      childPid: child.pid,
      childProcessGroup: processGroupId(child.pid),
      nextServerPids: [...observedNextServers],
      portProcessPids: observedPortProcesses,
      allNextServerPids: nextServerProcessIds(),
      allPortProcessPids: listeningProcessIds(port),
    }))
  }
  const treePids = signalProcessTree(child.pid, signal)
  for (const pid of observedNextServers) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process can exit between discovery and signalling.
    }
  }
  for (const pid of observedPortProcesses) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process can exit between discovery and signalling.
    }
  }
  if (child.exitCode == null && child.signalCode == null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ])
  }
  if (treePids.some(processAlive)) signalProcessTree(child.pid, "SIGKILL")
  for (const pid of observedNextServers) {
    if (!processAlive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The process can exit between the liveness check and signalling.
    }
  }
  for (const pid of observedPortProcesses) {
    if (!processAlive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The process can exit between the liveness check and signalling.
    }
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  server = null
}

async function runPhase(phase) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/test-direct-trade-recovery-scenarios.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DIRECT_TRADE_BASE_URL: baseUrl,
        DIRECT_TRADE_RECOVERY_PHASE: phase,
        DIRECT_TRADE_RECOVERY_LEASE_WAIT_MS: "850",
      },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => code === 0
      ? resolve(undefined)
      : reject(new Error(`Recovery phase ${phase} exited code=${code} signal=${signal || "none"}`)))
  })
}

try {
  startServer()
  await waitForReady()
  await runPhase("before-crash")
  // This is deliberately a hard crash, not a graceful Next shutdown.
  console.log("[direct-trade-recovery] simulating server crash")
  await stopServer("SIGKILL")
  try {
    await waitForPortFree()
  } catch (error) {
    const restartPort = Number(process.env.DIRECT_TRADE_RECOVERY_RESTART_PORT)
    if (!Number.isInteger(restartPort) || restartPort < 1024 || restartPort > 65_535) throw error
    useRestartPort(restartPort)
    console.warn(`[direct-trade-recovery] original port did not release in time; using isolated restart port ${port}`)
    await waitForPortFree()
  }
  console.log("[direct-trade-recovery] starting replacement server")
  startServer()
  await waitForReady()
  console.log("[direct-trade-recovery] validating recovered state")
  await runPhase("after-restart")
  console.log(JSON.stringify({
    test: "direct-trade-recovery-soak",
    simulatedOnly: true,
    physicalCrashRestart: true,
    samePortRestart: port === initialPort,
    restartPort: port,
  }, null, 2))
} catch (error) {
  console.error(`[run-direct-trade-recovery-soak] ${error instanceof Error ? error.message : String(error)}`)
  if (outputTail) console.error(`[run-direct-trade-recovery-soak] server tail:\n${outputTail}`)
  process.exitCode = 1
} finally {
  await stopServer()
}
