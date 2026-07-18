#!/usr/bin/env node

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

const port = Number(process.env.KILO_PREVIEW_PORT || 8787)
const inspectorPort = Number(process.env.KILO_PREVIEW_INSPECTOR_PORT || 9230)
const baseUrl = `http://127.0.0.1:${port}`
const cronSecret = "kilo-runtime-test-cron-secret-000000000000"
const adminSecret = "kilo-runtime-test-admin-secret-00000000000"
const encryptionKey = "kilo-runtime-test-encryption-key-000000000"
const jwtSecret = "kilo-runtime-test-jwt-secret-000000000000"
let output = ""

function appendOutput(chunk) {
  output += chunk.toString()
  if (output.length > 128 * 1024) output = `[earlier output truncated]\n${output.slice(-128 * 1024)}`
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function json(pathname, timeoutMs = 30_000) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

async function waitForHealth(child) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before readiness (${child.exitCode})`)
    try {
      const health = await json("/api/health", 5_000)
      if (health?.status === "healthy") return health
    } catch {
      // Workerd or the initial schema migration is still warming.
    }
    await sleep(1_000)
  }
  throw new Error("Kilo workerd preview did not become healthy within 60 seconds")
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000).then(() => child.kill("SIGKILL")),
  ])
}

async function main() {
  assert(Number.isInteger(port) && port > 0 && port <= 65_535, "KILO_PREVIEW_PORT is invalid")
  assert(Number.isInteger(inspectorPort) && inspectorPort > 0 && inspectorPort <= 65_535, "KILO_PREVIEW_INSPECTOR_PORT is invalid")
  const workDir = await mkdtemp(path.join(tmpdir(), "cts-kilo-runtime-"))
  const wrangler = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler")
  const child = spawn(wrangler, [
    "dev",
    "--local",
    "--test-scheduled",
    "--ip", "127.0.0.1",
    "--inspector-ip", "127.0.0.1",
    "--port", String(port),
    "--inspector-port", String(inspectorPort),
    "--show-interactive-dev-session=false",
    "--var", "ALLOW_PROD_INLINE_REDIS:1",
    "--var", "ALLOW_INLINE_REDIS_LIVE_TRADING:0",
    "--var", `CRON_SECRET:${cronSecret}`,
    "--var", `ADMIN_SECRET:${adminSecret}`,
    "--var", `ENCRYPTION_KEY:${encryptionKey}`,
    "--var", `JWT_SECRET:${jwtSecret}`,
    "--var", `NEXT_PUBLIC_APP_URL:${baseUrl}`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: workDir,
      XDG_CONFIG_HOME: path.join(workDir, "config"),
      XDG_CACHE_HOME: path.join(workDir, "cache"),
      WRANGLER_SEND_METRICS: "false",
      CI: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", appendOutput)
  child.stderr.on("data", appendOutput)

  try {
    const health = await waitForHealth(child)
    const init = await json("/api/system/init-status", 60_000)
    assert(init?.ready === true, "Kilo preview startup is not ready")
    assert(init?.migrations?.current_version === 81 && init?.migrations?.latest_version === 81, "Kilo preview schema is not v81")
    assert(init?.system?.deployment_runtime === "kilo-deploy", "Kilo deployment runtime was not detected")
    assert(init?.system?.engine_owner === "external-long-lived-required", "Kilo request worker incorrectly claims engine ownership")

    // Exercise the actual bundled remote-install route inside Workerd. The
    // module contains the long-lived Node SSH implementation, but Kilo must be
    // able to load it safely, enforce admin auth, and select only the secured
    // owner-proxy branch. No owner is configured in this isolated preview, so
    // an authenticated request must fail closed before any outbound request.
    const unauthenticatedRemote = await fetch(new URL("/api/install/remote-postgres", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preflight", host: "example.test", username: "deploy" }),
      signal: AbortSignal.timeout(30_000),
    })
    assert(unauthenticatedRemote.status === 401, `Kilo remote install without admin auth returned ${unauthenticatedRemote.status}`)
    const noOwnerRemote = await fetch(new URL("/api/install/remote-postgres", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({ mode: "preflight", host: "example.test", username: "deploy" }),
      signal: AbortSignal.timeout(30_000),
    })
    const noOwnerPayload = await noOwnerRemote.json().catch(() => ({}))
    assert(noOwnerRemote.status === 503, `Kilo remote install without owner returned ${noOwnerRemote.status}`)
    assert(String(noOwnerPayload?.error || "").includes("REMOTE_INSTALL_OWNER_URL"), "Kilo owner blocker is not explicit")

    const scheduled = await fetch(new URL("/__scheduled", baseUrl), {
      signal: AbortSignal.timeout(120_000),
    })
    assert(scheduled.ok, `Scheduled handler returned HTTP ${scheduled.status}: ${(await scheduled.text()).slice(0, 300)}`)

    let continuity = null
    for (let attempt = 1; attempt <= 20; attempt++) {
      continuity = (await json("/api/system/init-status", 30_000))?.system?.continuity
      if (continuity?.last_tick_fresh === true && continuity?.live_recovery?.last_tick_fresh === true) break
      await sleep(500)
    }
    assert(continuity?.last_tick_fresh === true, "Cloudflare scheduled continuity tick is not fresh")
    assert(continuity?.live_recovery?.last_tick_fresh === true, "Cloudflare live-recovery tick is not fresh")
    assert(continuity?.last_tick_source === "cloudflare-scheduled", "Unexpected continuity tick source")

    console.log(JSON.stringify({
      success: true,
      health: health.status,
      schemaVersion: init.migrations.current_version,
      deploymentRuntime: init.system.deployment_runtime,
      remoteInstallRouteFailClosed: true,
      scheduledContinuityFresh: true,
      scheduledLiveRecoveryFresh: true,
    }, null, 2))
  } catch (error) {
    console.error(output.slice(-32 * 1024))
    throw error
  } finally {
    await stop(child)
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[Kilo Runtime Test] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
