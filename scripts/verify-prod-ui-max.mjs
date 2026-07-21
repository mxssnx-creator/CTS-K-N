#!/usr/bin/env node

/**
 * Replays the production QuickStart UI workflow at its 32-symbol maximum.
 *
 * Safety: the live toggle is forced off before and during QuickStart, and the
 * verifier fails if the API exposes any real exchange position.
 */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3102}`
const UI_MAX_SYMBOLS = 32
const QUICKSTART_UI_TIMEOUT_MS = 35_000
const PROGRESSION_TIMEOUT_MS = Math.max(30_000, Number(process.env.PROD_UI_PROGRESSION_TIMEOUT_MS || 90_000))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(pathname, { method = "GET", body, timeoutMs = 20_000, parse = "json" } = {}) {
  const startedAt = Date.now()
  const response = await fetch(new URL(pathname, BASE_URL), {
    method,
    headers: {
      Accept: parse === "text" ? "text/html" : "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${pathname} HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  return {
    data: parse === "text" ? text : (text ? JSON.parse(text) : {}),
    latencyMs: Date.now() - startedAt,
    contentType: response.headers.get("content-type") || "",
  }
}

function connectionList(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.connections) ? payload.connections : [])
}

function engineFor(payload, connectionId) {
  return Array.isArray(payload?.engines)
    ? payload.engines.find((entry) => String(entry?.connectionId) === connectionId)
    : null
}

function activeSymbols(engine) {
  return Array.isArray(engine?.engineStatus?.symbols) ? engine.engineStatus.symbols.map(String) : []
}

function cycleTotal(stats) {
  const counters = stats?.realtime?.cycleCounters || {}
  return [counters.indication, counters.strategy, counters.realtime]
    .map((value) => Number(value || 0))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
}

function assertBoundedPercentage(label, value) {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new Error(`${label} is outside 0..100: ${String(value)}`)
  }
}

function assertStatsRelationships(stats) {
  for (const [stage, value] of Object.entries(stats?.stageEvalPercent || {})) {
    assertBoundedPercentage(`stageEvalPercent.${stage}`, value)
  }
  for (const stage of ["base", "main", "real", "live"]) {
    const detail = stats?.strategyDetail?.[stage] || {}
    assertBoundedPercentage(`strategyDetail.${stage}.passRatio`, detail.passRatio)
    const evaluated = Number(detail.evaluated || 0)
    const passed = Number(detail.passed || 0)
    if (evaluated < 0 || passed < 0 || passed > evaluated) {
      throw new Error(`Invalid ${stage} evaluated/passed relation: ${evaluated}/${passed}`)
    }
  }
  assertBoundedPercentage("liveExecution.fillRate", stats?.liveExecution?.fillRate)
  assertBoundedPercentage("liveExecution.winRate", stats?.liveExecution?.winRate)
  const real = Number(stats?.breakdown?.strategies?.real || 0)
  const live = Number(stats?.breakdown?.strategies?.live || 0)
  if (live > real) throw new Error(`Live strategy count exceeds Real (${live} > ${real})`)
}

async function waitFor(label, read, accept, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (accept(latest)) return latest
    await sleep(250)
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(latest).slice(0, 500)}`)
}

async function main() {
  let connectionId = ""
  let stopAttempted = false

  try {
    const page = await request("/", { parse: "text", timeoutMs: 30_000 })
    if (!page.contentType.includes("text/html") || !page.data.includes("/_next/static/")) {
      throw new Error("Production dashboard HTML/client assets were not served")
    }
    const dashboardScriptPaths = Array.from(
      page.data.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g),
      (match) => match[1],
    )
    const dashboardScripts = await Promise.all(
      dashboardScriptPaths.map((pathname) => request(pathname, { parse: "text", timeoutMs: 30_000 })),
    )
    if (!dashboardScripts.some((script) => script.data.includes("Connection information sections"))) {
      throw new Error("Production dashboard assets do not contain the modern Main Connection information dialog")
    }

    const inventory = (await request(`/api/settings/connections?t=${Date.now()}`)).data
    const connection = connectionList(inventory).find((entry) => {
      const exchange = String(entry?.exchange || entry?.exchange_type || "").toLowerCase()
      return exchange.includes("bingx") || String(entry?.id || "").toLowerCase().startsWith("bingx")
    })
    connectionId = String(connection?.id || "")
    if (!connectionId) throw new Error("The production UI has no selectable BingX connection")

    const disabled = (await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/live-trade`, {
      method: "POST",
      body: { is_live_trade: false },
      timeoutMs: 30_000,
    })).data
    if (disabled?.success === false || disabled?.is_live_trade === true) {
      throw new Error("Could not force the UI workflow into paper mode")
    }

    // This is the same symbol-discovery request emitted by QuickstartSection.
    const top = (await request(
      `/api/exchange/bingx/top-symbols?sort=volatility&limit=${UI_MAX_SYMBOLS}&t=${Date.now()}`,
      { timeoutMs: 15_000 },
    )).data
    const symbols = Array.isArray(top?.symbolList)
      ? top.symbolList.map(String)
      : (Array.isArray(top?.symbols) ? top.symbols.map((entry) => String(entry?.symbol || "")).filter(Boolean) : [])
    if (symbols.length !== UI_MAX_SYMBOLS || new Set(symbols).size !== UI_MAX_SYMBOLS) {
      throw new Error(`UI symbol discovery returned ${symbols.length}/${UI_MAX_SYMBOLS} unique symbols`)
    }

    const beforeStats = (await request(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
      { timeoutMs: 30_000 },
    )).data
    const beforeCycles = cycleTotal(beforeStats)

    // Keep this body in lock-step with components/dashboard/quickstart-section.tsx.
    const enabled = await request("/api/trade-engine/quick-start", {
      method: "POST",
      body: {
        action: "enable",
        connectionId,
        symbols,
        liveTrade: false,
        is_live_trade: false,
      },
      timeoutMs: QUICKSTART_UI_TIMEOUT_MS,
    })
    const configuredSymbols = Array.isArray(enabled.data?.connection?.symbols)
      ? enabled.data.connection.symbols.map(String)
      : []
    if (configuredSymbols.length !== UI_MAX_SYMBOLS || configuredSymbols.some((symbol, index) => symbol !== symbols[index])) {
      throw new Error("QuickStart did not preserve the exact 32-symbol UI selection")
    }
    if (enabled.data?.connection?.liveTradeRequested !== false || enabled.data?.connection?.liveTradeEnabled !== false) {
      throw new Error("Production UI QuickStart unexpectedly enabled real exchange trading")
    }
    if (enabled.latencyMs >= QUICKSTART_UI_TIMEOUT_MS) {
      throw new Error(`QuickStart exceeded the ${QUICKSTART_UI_TIMEOUT_MS}ms UI deadline`)
    }

    let observedCycles = beforeCycles
    let previousCycleSample = null
    let cycleAdvanced = false
    let cycleResetObserved = false
    let coordinatedSymbols = []
    const deadline = Date.now() + PROGRESSION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const [statusResponse, statsResponse] = await Promise.all([
        request("/api/trade-engine/status-all", { timeoutMs: 30_000 }),
        request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`, { timeoutMs: 30_000 }),
      ])
      const status = statusResponse.data
      const engine = engineFor(status, connectionId)
      coordinatedSymbols = activeSymbols(engine)
      observedCycles = cycleTotal(statsResponse.data)
      if (previousCycleSample !== null) {
        if (observedCycles > previousCycleSample) cycleAdvanced = true
        if (observedCycles < previousCycleSample) cycleResetObserved = true
      }
      previousCycleSample = observedCycles
      // QuickStart may intentionally start a new progression epoch. Its
      // cumulative counters then reset even though the engine is healthy, so
      // prove forward movement within the currently observed epoch instead of
      // requiring the new total to exceed a previous run's total.
      if (coordinatedSymbols.length === UI_MAX_SYMBOLS && cycleAdvanced && observedCycles > 0) break
      await sleep(1_000)
    }
    if (coordinatedSymbols.length !== UI_MAX_SYMBOLS) {
      throw new Error(`Engine coordinated ${coordinatedSymbols.length}/${UI_MAX_SYMBOLS} UI symbols`)
    }
    if (!cycleAdvanced) {
      throw new Error(`Production engine cycles did not advance within the active epoch (${beforeCycles} → ${observedCycles})`)
    }

    // Main Connection status must agree across the exact endpoints consumed by
    // the card and global controls. Paper intent remains authoritative.
    const initialEngineStates = (await request(
      `/api/connections/${encodeURIComponent(connectionId)}/engine-states`,
    )).data
    if (
      initialEngineStates?.enabled?.flag !== true ||
      initialEngineStates?.live?.flag !== false ||
      initialEngineStates?.live?.effective !== false
    ) {
      throw new Error(`Main Connection state is inconsistent: ${JSON.stringify(initialEngineStates)}`)
    }

    // The information dialog hydrates six independent read-only surfaces. A
    // partial failure is rendered explicitly, but a healthy production test
    // expects the complete detailed snapshot and both indication profiles.
    const [infoSettings, infoIndications, infoPreset, infoRuntime, infoProgression, infoStats] = await Promise.all([
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`),
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/active-indications?t=${Date.now()}`),
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/preset-type?t=${Date.now()}`),
      request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states?t=${Date.now()}`),
      request(`/api/connections/progression/${encodeURIComponent(connectionId)}?t=${Date.now()}`, { timeoutMs: 30_000 }),
      request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats?t=${Date.now()}`, { timeoutMs: 30_000 }),
    ])
    if (
      !infoSettings.data?.settings ||
      !infoIndications.data?.channels?.main ||
      !infoIndications.data?.channels?.preset ||
      !("presetType" in infoPreset.data) ||
      infoRuntime.data?.connectionId !== connectionId ||
      infoProgression.data?.success !== true ||
      infoStats.data?.success !== true
    ) {
      throw new Error("Main Connection information dialog snapshot is incomplete")
    }

    // Exercise the quick-settings hot-reload contract while processing is
    // active. The response must acknowledge one version, persist both adjacent
    // fields, and expose that same generation through progression stats.
    const originalSettingsPayload = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`,
    )).data
    const originalSettings = originalSettingsPayload?.settings || {}
    const originalMinimalStep = Number(originalSettings.minimal_step_count ?? originalSettings.minimalStepCount ?? 3)
    const originalMaxTrades = Number(originalSettings.max_concurrent_trades ?? originalSettings.maxConcurrentTrades ?? 10)
    const nextMinimalStep = originalMinimalStep === 4 ? 5 : 4
    const nextMaxTrades = originalMaxTrades === 11 ? 12 : 11
    const settingsMarker = `ui_main_${Date.now()}`
    const settingsUpdate = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings`,
      {
        method: "PATCH",
        body: {
          ui_main_connections_test_marker: settingsMarker,
          minimal_step_count: nextMinimalStep,
          max_concurrent_trades: nextMaxTrades,
        },
        timeoutMs: 30_000,
      },
    )).data
    if (!settingsUpdate?.success || !settingsUpdate?.settingsVersion || !settingsUpdate?.recoordination?.completedAt) {
      throw new Error(`Settings hot reload did not acknowledge completion: ${JSON.stringify(settingsUpdate)}`)
    }
    const persistedSettings = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`,
    )).data?.settings || {}
    if (
      persistedSettings.ui_main_connections_test_marker !== settingsMarker ||
      Number(persistedSettings.minimal_step_count) !== nextMinimalStep ||
      Number(persistedSettings.max_concurrent_trades) !== nextMaxTrades
    ) {
      throw new Error("Adjacent Main Connection settings did not persist as one coherent update")
    }
    await waitFor(
      "settings recoordination version",
      async () => (await request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)).data,
      (stats) => {
        const state = stats?.settingsRecoordination || {}
        return state.pending === false && (
          state.appliedVersion === settingsUpdate.settingsVersion ||
          state.requestedVersion === settingsUpdate.settingsVersion
        )
      },
      15_000,
    )

    // Volume controls use a separate API but must provide the same versioned
    // recoordination acknowledgement and canonical read-after-write value.
    const originalVolume = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`,
    )).data
    const originalLiveVolume = Number(originalVolume?.live_volume_factor ?? 1)
    const nextLiveVolume = originalLiveVolume === 1.2 ? 1.3 : 1.2
    const volumeUpdate = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume`,
      { method: "POST", body: { live_volume_factor: nextLiveVolume }, timeoutMs: 30_000 },
    )).data
    if (
      !volumeUpdate?.success ||
      !volumeUpdate?.settingsVersion ||
      !volumeUpdate?.recoordination?.completedAt ||
      Number(volumeUpdate.live_volume_factor) !== nextLiveVolume
    ) {
      throw new Error(`Volume hot reload did not acknowledge the applied value: ${JSON.stringify(volumeUpdate)}`)
    }
    const volumeReadback = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`,
    )).data
    if (Number(volumeReadback?.live_volume_factor) !== nextLiveVolume) {
      throw new Error("Volume setting read-after-write mismatch")
    }

    const relationshipStats = (await request(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
      { timeoutMs: 30_000 },
    )).data
    assertStatsRelationships(relationshipStats)

    // Reproduce every Main Connection control transition through the same APIs
    // used by the switches/buttons. Each transition must converge before the
    // next begins, preventing overlapping operator state.
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`, {
      method: "POST",
      body: { is_enabled_dashboard: false },
      timeoutMs: 30_000,
    })
    await waitFor(
      "Main Connection disable",
      async () => (await request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states`)).data,
      (state) => state?.enabled?.flag === false && state?.engineRunning === false,
    )

    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`, {
      method: "POST",
      body: { is_enabled_dashboard: true },
      timeoutMs: 30_000,
    })
    await waitFor(
      "Main Connection enable",
      async () => (await request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states`)).data,
      (state) => state?.enabled?.flag === true && (state?.engineRunning === true || state?.runningHint === true),
    )

    await request("/api/trade-engine/pause", { method: "POST", timeoutMs: 30_000 })
    await waitFor(
      "global pause status",
      async () => (await request("/api/trade-engine/status")).data,
      (status) => status?.paused === true && status?.actualRuntimeStatus === "paused",
    )

    const beforeResumeCycles = cycleTotal((await request(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
    )).data)
    await request("/api/trade-engine/resume", { method: "POST", timeoutMs: 30_000 })
    await waitFor(
      "global resume status",
      async () => (await request("/api/trade-engine/status")).data,
      (status) => status?.paused === false && status?.actualRuntimeStatus === "running",
    )
    await waitFor(
      "cycles after resume",
      async () => (await request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)).data,
      (stats) => cycleTotal(stats) > beforeResumeCycles,
      30_000,
    )

    await request("/api/trade-engine/stop", { method: "POST", timeoutMs: 30_000 })
    await waitFor(
      "global stop status",
      async () => (await request("/api/trade-engine/status")).data,
      (status) => status?.paused === false && status?.actualRuntimeStatus === "stopped",
    )
    await request("/api/trade-engine/start", { method: "POST", timeoutMs: 35_000 })
    await waitFor(
      "global start status",
      async () => (await request("/api/trade-engine/status")).data,
      (status) => status?.paused === false && status?.actualRuntimeStatus === "running",
      35_000,
    )

    // Restore the two settings surfaces before the final stop so this verifier
    // remains isolated even when pointed at a reusable paper environment.
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings`, {
      method: "PATCH",
      body: {
        ui_main_connections_test_marker: String(originalSettings.ui_main_connections_test_marker || ""),
        minimal_step_count: originalMinimalStep,
        max_concurrent_trades: originalMaxTrades,
      },
      timeoutMs: 30_000,
    })
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/volume`, {
      method: "POST",
      body: { live_volume_factor: originalLiveVolume },
      timeoutMs: 30_000,
    })

    const positions = (await request(
      `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}`,
      { timeoutMs: 30_000 },
    )).data
    if (!Array.isArray(positions?.realPositions) || positions.realPositions.length !== 0) {
      throw new Error("A real exchange position appeared during the UI paper test")
    }
    if (positions?.dataIntegrity?.liveExecutionMode !== "simulation" || positions?.dataIntegrity?.liveTradeRequested !== false) {
      throw new Error("The UI workflow left explicit simulation mode")
    }

    await request("/api/trade-engine/stop", { method: "POST", timeoutMs: 30_000 })

    const stopped = (await request("/api/trade-engine/quick-start", {
      method: "POST",
      body: { action: "disable", connectionId },
      timeoutMs: QUICKSTART_UI_TIMEOUT_MS,
    })).data
    stopAttempted = true
    if (stopped?.success !== true) throw new Error("UI stop workflow did not complete")

    console.log(JSON.stringify({
      success: true,
      mode: "production-ui-paper",
      dashboardHtmlVerified: true,
      informationDialogAssetVerified: true,
      informationDialogSnapshotVerified: true,
      connectionId,
      symbols: symbols.length,
      quickStartLatencyMs: enabled.latencyMs,
      engineCyclesBefore: beforeCycles,
      engineCyclesAfter: observedCycles,
      cycleResetObserved,
      settingsHotReloadVerified: true,
      volumeHotReloadVerified: true,
      mainConnectionToggleVerified: true,
      globalControlsVerified: ["pause", "resume", "stop", "start"],
      statusRelationshipsVerified: true,
      realPositions: 0,
      realExchangeOrdersSubmitted: 0,
      stopped: true,
    }, null, 2))
  } finally {
    if (connectionId && !stopAttempted) {
      await request("/api/trade-engine/quick-start", {
        method: "POST",
        body: { action: "disable", connectionId },
        timeoutMs: QUICKSTART_UI_TIMEOUT_MS,
      }).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error("[verify-prod-ui-max] failed:", error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
