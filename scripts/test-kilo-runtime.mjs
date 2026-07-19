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

async function request(pathname, {
  method = "GET",
  body,
  headers = {},
  timeoutMs = 30_000,
  parse = "json",
  allowError = false,
} = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      Accept: parse === "text" ? "text/html,*/*" : "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let data = text
  if (parse === "json") {
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`${method} ${pathname} returned invalid JSON: ${text.slice(0, 400)}`)
    }
  }
  if (!response.ok && !allowError) {
    throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${text.slice(0, 400)}`)
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    data,
  }
}

async function json(pathname, timeoutMs = 30_000) {
  return (await request(pathname, { timeoutMs })).data
}

function connectionList(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.connections)
      ? payload.connections
      : []
}

function blockProfitFactorOf(payload) {
  const settings = payload?.settings || {}
  const coordination = settings.coordination_settings || settings.coordinationSettings || {}
  return Number(coordination.blockProfitFactorRatio ?? settings.blockProfitFactorRatio)
}

const assetCache = new Map()

async function loadPageAssets(pathname, markers) {
  const page = await request(pathname, { parse: "text", timeoutMs: 60_000 })
  assert(page.contentType.includes("text/html"), `${pathname} did not serve HTML`)
  assert(String(page.data).includes("/_next/static/"), `${pathname} did not reference Next assets`)
  const scriptPaths = Array.from(
    String(page.data).matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g),
    (match) => match[1],
  )
  assert(scriptPaths.length > 0, `${pathname} did not expose any client scripts`)
  const scripts = await Promise.all(scriptPaths.map(async (scriptPath) => {
    if (!assetCache.has(scriptPath)) {
      assetCache.set(scriptPath, request(scriptPath, { parse: "text", timeoutMs: 60_000 }))
    }
    return assetCache.get(scriptPath)
  }))
  const clientSource = scripts.map((script) => String(script.data)).join("\n")
  for (const marker of markers) {
    assert(clientSource.includes(marker), `${pathname} client bundle is missing UI marker: ${marker}`)
  }
  return { scripts: scriptPaths.length }
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
    "--var", "KILO_LOCAL_PREVIEW_INLINE_REDIS:1",
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

    // Verify the actual OpenNext UI bundles served by Workerd. These markers
    // cover the Main Connection dialog and both requested Strategy / Block
    // settings surfaces, including the 0.2..5.0 ProfitFactor control and the
    // independent Block-count selector.
    const dashboardUi = await loadPageAssets("/", [
      "Connection information sections",
      "0.2–5.0",
    ])
    const settingsUi = await loadPageAssets("/settings", [
      "ProfitFactor factor",
      "Independent Block counts",
    ])
    const presetsUi = await loadPageAssets("/presets", [
      "ProfitFactor factor",
      "Independent Block counts",
    ])

    const inventory = await json(`/api/settings/connections?t=${Date.now()}`, 60_000)
    const connection = connectionList(inventory).find((entry) => {
      const exchange = String(entry?.exchange || entry?.exchange_type || "").toLowerCase()
      return exchange.includes("bingx") || String(entry?.id || "").toLowerCase().startsWith("bingx")
    })
    const connectionId = String(connection?.id || "")
    assert(connectionId, "Kilo UI has no selectable BingX connection")
    const originalEnabled = connection?.is_enabled_dashboard === true || connection?.is_enabled_dashboard === "1"

    // Settings changes must be durable and explicitly queued for the external
    // owner. A serverless request worker must never report a local apply when
    // DISABLE_TRADE_ENGINE_IN_PROCESS=1.
    const originalSettingsPayload = await json(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`,
      60_000,
    )
    const originalSettings = originalSettingsPayload?.settings || {}
    const originalCoordination = originalSettings.coordination_settings || originalSettings.coordinationSettings || {}
    const originalBlockProfitFactor = blockProfitFactorOf(originalSettingsPayload)
    assert(
      Number.isFinite(originalBlockProfitFactor) && originalBlockProfitFactor >= 0.2 && originalBlockProfitFactor <= 5,
      `Invalid initial Block ProfitFactor factor: ${String(originalBlockProfitFactor)}`,
    )
    const nextBlockProfitFactor = originalBlockProfitFactor === 1.1 ? 1.2 : 1.1
    const blockUpdate = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings`,
      {
        method: "PATCH",
        body: {
          blockProfitFactorRatio: nextBlockProfitFactor,
          coordination_settings: {
            ...originalCoordination,
            blockProfitFactorRatio: nextBlockProfitFactor,
          },
        },
        timeoutMs: 60_000,
      },
    )).data
    assert(blockUpdate?.success === true, "Kilo Block ProfitFactor settings update failed")
    assert(typeof blockUpdate?.settingsVersion === "string" && blockUpdate.settingsVersion.length > 0, "Kilo settings version is missing")
    assert(blockUpdate?.refreshQueued === true, "Kilo Block setting did not queue a durable owner refresh")
    assert(blockUpdate?.recoordination?.appliedLocally === false, "Kilo request worker falsely reported a local settings apply")
    assert(blockUpdate?.recoordination?.queuedForOwner === true, "Kilo Block setting was not marked queued for the external owner")
    const changedBlockProfitFactor = blockProfitFactorOf(await json(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`,
      60_000,
    ))
    assert(changedBlockProfitFactor === nextBlockProfitFactor, "Kilo Block ProfitFactor read-after-write mismatch")
    const settingsStats = await json(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats?t=${Date.now()}`,
      60_000,
    )
    assert(settingsStats?.success === true, "Kilo progression stats did not load after settings change")
    assert(
      settingsStats?.settingsRecoordination?.requestedVersion === blockUpdate.settingsVersion,
      "Kilo progression stats did not expose the requested Block settings version",
    )

    const originalVolume = await json(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`,
      60_000,
    )
    const originalLiveVolume = Number(originalVolume?.live_volume_factor ?? 0.1)
    const nextLiveVolume = originalLiveVolume === 0.2 ? 0.3 : 0.2
    const volumeUpdate = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume`,
      {
        method: "POST",
        body: { live_volume_factor: nextLiveVolume },
        timeoutMs: 60_000,
      },
    )).data
    assert(volumeUpdate?.success === true, "Kilo volume settings update failed")
    assert(Number(volumeUpdate?.live_volume_factor) === nextLiveVolume, "Kilo volume response did not acknowledge the changed value")
    assert(volumeUpdate?.recoordination?.appliedLocally === false, "Kilo request worker falsely reported a local volume apply")
    assert(volumeUpdate?.recoordination?.queuedForOwner === true, "Kilo volume update was not queued for the external owner")
    const volumeReadback = await json(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`,
      60_000,
    )
    assert(Number(volumeReadback?.live_volume_factor) === nextLiveVolume, "Kilo volume read-after-write mismatch")

    // Reproduce the exact dashboard state switches. The disposable Kilo
    // preview has no external owner, so Enable/Resume must converge to durable
    // running intent + queued/starting diagnostics, never a phantom engine.
    const disabled = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`,
      { method: "POST", body: { is_enabled_dashboard: false }, timeoutMs: 60_000 },
    )).data
    assert(disabled?.success === true, "Kilo dashboard disable failed")
    const disabledState = await json(`/api/connections/${encodeURIComponent(connectionId)}/engine-states?t=${Date.now()}`)
    assert(disabledState?.enabled?.flag === false && disabledState?.engineRunning === false, "Kilo dashboard disable state is inconsistent")

    const enabled = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`,
      { method: "POST", body: { is_enabled_dashboard: true }, timeoutMs: 60_000 },
    )).data
    assert(enabled?.success === true, "Kilo dashboard enable failed")
    assert(enabled?.engine?.status === "queued", `Kilo enable did not queue for the owner: ${JSON.stringify(enabled?.engine)}`)
    const enabledState = await json(`/api/connections/${encodeURIComponent(connectionId)}/engine-states?t=${Date.now()}`)
    assert(enabledState?.enabled?.flag === true, "Kilo enabled flag did not persist")
    assert(enabledState?.engineRunning === false && enabledState?.enabled?.inSync === false, "Kilo request worker exposed a phantom local engine")
    const queuedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(queuedStatus?.operatorIntent === "running", "Kilo enable did not persist global running intent")
    assert(queuedStatus?.actualRuntimeStatus === "starting" && queuedStatus?.workerAttached === false, "Kilo queued runtime status is inaccurate")
    assert(queuedStatus?.diagnostics?.serverless === true, "Kilo status did not identify the serverless request runtime")
    assert(String(queuedStatus?.diagnostics?.hint || "").includes("external engine-owner"), "Kilo status lacks the external-owner handoff diagnostic")

    // A real-trade request in this isolated Workerd preview may persist the UI
    // request, but it must remain ineffective because shared cross-process
    // Redis is absent. This proves the stable requested/effective switch split
    // without allowing any exchange operation.
    const liveEnable = await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/live-trade`,
      {
        method: "POST",
        body: { is_live_trade: true },
        timeoutMs: 60_000,
      },
    )
    assert(liveEnable.status === 200 && liveEnable.data?.success === true, `Kilo blocked live request returned ${liveEnable.status}`)
    assert(liveEnable.data?.live_trade_requested === true, "Kilo did not preserve the requested Live switch state")
    assert(liveEnable.data?.is_live_trade === false, "Kilo enabled effective Live trading without shared Redis")
    assert(liveEnable.data?.live_execution_mode === "blocked", "Kilo live request did not expose blocked execution mode")
    assert(
      ["credentials_missing", "shared_redis_required"].includes(String(liveEnable.data?.live_trade_block_code || "")) &&
        String(liveEnable.data?.live_trade_blocked_reason || "").length > 0,
      "Kilo live toggle did not expose a concrete fail-closed blocker",
    )
    assert(liveEnable.data?.engineStatus === "queued", "Kilo blocked live request was not queued for the external owner")
    const requestedLiveState = await json(`/api/connections/${encodeURIComponent(connectionId)}/engine-states?t=${Date.now()}`)
    assert(
      requestedLiveState?.live?.flag === true && requestedLiveState?.live?.effective === false,
      "Kilo requested/effective Live UI state is inconsistent",
    )
    assert(
      requestedLiveState?.live?.credentialsValid === false && requestedLiveState?.live?.durableCoordinationReady === false,
      "Kilo Live state did not expose both credential and shared-coordination blockers",
    )
    const liveDisable = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/live-trade`,
      { method: "POST", body: { is_live_trade: false }, timeoutMs: 60_000 },
    )).data
    assert(
      liveDisable?.success === true && liveDisable?.live_trade_requested === false && liveDisable?.is_live_trade === false,
      "Kilo Live switch did not return to simulation mode",
    )

    const unauthenticatedSmoke = await request("/api/admin/live-order-smoke", {
      method: "POST",
      body: { connectionId },
      allowError: true,
    })
    assert(unauthenticatedSmoke.status === 401, `Kilo live smoke without admin auth returned ${unauthenticatedSmoke.status}`)
    const placementDisabledSmoke = await request("/api/admin/live-order-smoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSecret}` },
      body: { connectionId },
      allowError: true,
    })
    assert(placementDisabledSmoke.status === 403, `Kilo live smoke without placement gate returned ${placementDisabledSmoke.status}`)
    assert(String(placementDisabledSmoke.data?.error || "").includes("disabled"), "Kilo live-smoke placement gate blocker is not explicit")

    const paused = (await request("/api/trade-engine/pause", { method: "POST", timeoutMs: 60_000 })).data
    assert(paused?.success === true, "Kilo global pause failed")
    const pausedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(pausedStatus?.paused === true && pausedStatus?.actualRuntimeStatus === "paused", "Kilo pause status did not converge")

    const resumed = (await request("/api/trade-engine/resume", { method: "POST", timeoutMs: 60_000 })).data
    assert(resumed?.success === true, "Kilo global resume failed")
    const resumedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(resumedStatus?.paused === false && resumedStatus?.actualRuntimeStatus === "starting", "Kilo resume did not return to queued owner intent")
    assert(resumedStatus?.workerAttached === false, "Kilo resume attached a forbidden request-worker engine")

    const stopped = (await request("/api/trade-engine/stop", { method: "POST", timeoutMs: 60_000 })).data
    assert(stopped?.success === true, "Kilo global stop failed")
    const stoppedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(stoppedStatus?.actualRuntimeStatus === "stopped" && stoppedStatus?.operatorIntent === "stopped", "Kilo global stop status did not converge")

    const started = (await request("/api/trade-engine/start", { method: "POST", timeoutMs: 60_000 })).data
    assert(started?.success === true, "Kilo global start failed")
    assert(started?.coordinator_status === "queued_for_owner", "Kilo global start falsely claimed a local running coordinator")
    assert(started?.workerAttached === false && started?.queuedForOwner === true, "Kilo global start ownership response is inconsistent")
    assert(Array.isArray(started?.queuedConnections) && started.queuedConnections.includes(connectionId), "Kilo global start did not queue the enabled connection")
    const startedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(startedStatus?.actualRuntimeStatus === "starting" && startedStatus?.workerAttached === false, "Kilo global start exposed a phantom local runtime")
    await request("/api/trade-engine/stop", { method: "POST", timeoutMs: 60_000 })
    const finalStoppedStatus = await json(`/api/trade-engine/status?t=${Date.now()}`, 60_000)
    assert(finalStoppedStatus?.actualRuntimeStatus === "stopped", "Kilo final safety stop did not converge")

    const positions = await json(
      `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&t=${Date.now()}`,
      60_000,
    )
    assert(Array.isArray(positions?.realPositions) && positions.realPositions.length === 0, "A real position appeared during the Kilo UI test")
    assert(positions?.dataIntegrity?.liveExecutionMode === "simulation", "Kilo UI test left simulation mode")
    const orders = await json(`/api/orders?connection_id=${encodeURIComponent(connectionId)}&limit=50&t=${Date.now()}`, 60_000)
    assert(orders?.count === 0 && Array.isArray(orders?.data) && orders.data.length === 0, "An order appeared during the Kilo UI test")

    // Restore both settings surfaces and the original connection toggle, then
    // prove their canonical read-back. The preview is disposable, but this
    // keeps the verifier safe when pointed at a reusable local Redis service.
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings`, {
      method: "PATCH",
      body: {
        blockProfitFactorRatio: originalBlockProfitFactor,
        coordination_settings: {
          ...originalCoordination,
          blockProfitFactorRatio: originalBlockProfitFactor,
        },
      },
      timeoutMs: 60_000,
    })
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/volume`, {
      method: "POST",
      body: { live_volume_factor: originalLiveVolume },
      timeoutMs: 60_000,
    })
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`, {
      method: "POST",
      body: { is_enabled_dashboard: originalEnabled },
      timeoutMs: 60_000,
    })
    assert(
      blockProfitFactorOf(await json(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`, 60_000)) === originalBlockProfitFactor,
      "Kilo Block ProfitFactor restore failed",
    )
    assert(
      Number((await json(`/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`, 60_000))?.live_volume_factor) === originalLiveVolume,
      "Kilo volume restore failed",
    )

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
      uiRoutesVerified: ["/", "/settings", "/presets"],
      uiScriptsVerified: dashboardUi.scripts + settingsUi.scripts + presetsUi.scripts,
      connectionId,
      blockProfitFactorSettingsVerified: true,
      volumeSettingsVerified: true,
      stateSwitchesVerified: ["disable", "enable", "live-request-blocked", "live-off", "pause", "resume", "stop", "start", "final-stop"],
      externalOwnerQueueVerified: true,
      liveTradeFailClosedVerified: true,
      realPositions: 0,
      realOrders: 0,
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
