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
const UI_PAGE_PATHS = [
  "/", "/active-exchange", "/additional", "/additional/chat-history",
  "/additional/volume-corrections", "/admin/check-tables", "/admin/migrate",
  "/alerts", "/analysis", "/autotest", "/health", "/indications",
  "/live-trading", "/login", "/logistics", "/main", "/main/realtime",
  "/minimal", "/minimal-test", "/monitoring", "/monitoring-advanced",
  "/portfolios", "/portfolios/1", "/presets", "/register", "/sets",
  "/settings", "/settings/connections", "/settings/indications/auto",
  "/settings/indications/common", "/settings/indications/main",
  "/settings/indications/optimal", "/settings/indications/signal", "/simple",
  "/statistics", "/statistics/direct-trade", "/statistics/indications/common",
  "/statistics/indications/signal", "/strategies", "/structure", "/test",
  "/test-layout", "/test-simple", "/testing/connection", "/testing/engine",
  "/testing/orders", "/tracking",
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(pathname, { method = "GET", body, timeoutMs = 20_000, parse = "json" } = {}) {
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(new URL(pathname, BASE_URL), {
      method,
      headers: {
        Accept: parse === "text" ? "text/html" : "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cause = error instanceof Error && error.cause
      ? `; cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
      : ""
    throw new Error(`${method} ${pathname} failed within ${timeoutMs}ms: ${message}${cause}`)
  }
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

function livePositionCycleTotal(stats) {
  return Number(stats?.realtime?.cycleCounters?.livePositions || 0) || 0
}

function historicWorkSnapshot(stats) {
  const work = stats?.historic?.configWork || {}
  return {
    completed: Number(work.completed || 0) || 0,
    total: Number(work.total || 0) || 0,
    failed: Number(work.failed || 0) || 0,
    stage: String(work.currentStage || ""),
    symbol: String(work.currentSymbol || ""),
    isComplete: stats?.historic?.isComplete === true,
  }
}

function assertBoundedPercentage(label, value) {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new Error(`${label} is outside 0..100: ${String(value)}`)
  }
}

function finiteNonNegative(value, label) {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} is invalid: ${String(value)}`)
  }
  return numeric
}

function validServiceBootId(value) {
  const normalized = String(value || "")
  return normalized.length >= 12 && ["boot_", "prod_", "dev_", "dev-preview_"]
    .some((prefix) => normalized.startsWith(prefix))
}

function assertStatsRelationships(stats) {
  for (const type of ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "common", "signal", "trend"]) {
    finiteNonNegative(stats?.indicationsByType?.[type], `indicationsByType.${type}`)
  }
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
  // Do not compare the legacy flat Real/Live totals directly: Real Active is
  // collapsed per Base lineage, while Live dispatches independent
  // Main/Preset/Signal rows plus Block-derived candidates. Validate both totals
  // and use connectionStageOverview/stageEvalPercent for their relationship.
  finiteNonNegative(real, "breakdown.strategies.real")
  finiteNonNegative(live, "breakdown.strategies.live")

  const blockPf = stats?.strategyDetail?.real?.positionStats?.adjustTypes?.block
  if (!blockPf || !Array.isArray(blockPf.countEvaluations) || !Array.isArray(blockPf.scopedEvaluations)) {
    throw new Error("Real Block PF/count/source-scope statistics are missing")
  }
  finiteNonNegative(blockPf.profitFactorWindow, "blockProfitFactor.window")
  finiteNonNegative(blockPf.profitFactorMinimumSampleCount, "blockProfitFactor.minimumSampleCount")

  const overview = stats?.connectionStageOverview
  if (
    !overview ||
    overview?.schemaVersion !== 1 ||
    overview?.pfComparison?.window !== 50 ||
    !Array.isArray(overview?.integrity?.errors)
  ) {
    throw new Error("Connection Stage Overview is missing its exact 50-position integrity contract")
  }
  for (const [label, value] of Object.entries({
    baseTotal: overview?.base?.total,
    baseValid: overview?.base?.valid,
    mainValid: overview?.main?.valid,
    mainOverall: overview?.main?.overall,
    realValid: overview?.real?.valid,
    realActive: overview?.real?.active,
    liveTotal: overview?.live?.total,
    liveOrdersPlaced: overview?.live?.orders?.placed,
    liveOrdersRunning: overview?.live?.orders?.running,
  })) finiteNonNegative(value, `connectionStageOverview.${label}`)
  if (Number(overview.base.valid) > Number(overview.base.total)) {
    throw new Error("Connection Stage Overview Base Valid exceeds Total")
  }
  if (Number(overview.main.overall) < Number(overview.main.valid)) {
    throw new Error("Connection Stage Overview Main Overall is below Valid")
  }
  if (Number(overview.real.active) > Number(overview.real.valid)) {
    throw new Error("Connection Stage Overview Real Active exceeds Valid")
  }
  if (Number(overview.live.long) + Number(overview.live.short) !== Number(overview.live.total)) {
    throw new Error("Connection Stage Overview Live direction counts do not equal Total")
  }
  const ordersByDirection = stats?.liveExecution?.ordersByDirection || {}
  const rows = Array.isArray(stats?.liveExecution?.ordersBySymbol) ? stats.liveExecution.ordersBySymbol : []
  for (const direction of ["long", "short"]) {
    for (const kind of ["placed", "filled", "failed"]) {
      const rowTotal = rows.reduce((sum, row) => sum + Number(row?.[direction]?.[kind] || 0), 0)
      if (rowTotal !== Number(ordersByDirection?.[direction]?.[kind] || 0)) {
        throw new Error(`Live ${direction} ${kind} total is not the sum of its own per-symbol lane`)
      }
    }
  }
}

async function verifyAllPageSurfaces() {
  for (let offset = 0; offset < UI_PAGE_PATHS.length; offset += 4) {
    const batch = UI_PAGE_PATHS.slice(offset, offset + 4)
    await Promise.all(batch.map(async (pathname) => {
      const page = await request(pathname, { parse: "text", timeoutMs: 30_000 })
      if (!page.contentType.includes("text/html") || !page.data.includes("/_next/static/")) {
        throw new Error(`UI page ${pathname} did not serve the application HTML/client assets`)
      }
      if (page.data.includes("NEXT_HTTP_ERROR_FALLBACK;404") || page.data.includes('id="__next_error__"')) {
        throw new Error(`UI page ${pathname} rendered a Next error boundary`)
      }
    }))
  }
}

async function fetchPageScripts(html) {
  const scriptPaths = Array.from(
    html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g),
    (match) => match[1],
  )
  return Promise.all(scriptPaths.map((pathname) => request(pathname, { parse: "text", timeoutMs: 30_000 })))
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
    const dashboardScripts = await fetchPageScripts(page.data)
    if (!dashboardScripts.some((script) => script.data.includes("Connection information sections"))) {
      throw new Error("Production dashboard assets do not contain the modern Main Connection information dialog")
    }
    if (!dashboardScripts.some((script) => script.data.includes("connection-stage-overview") && script.data.includes("Stage Overview"))) {
      throw new Error("Production dashboard assets do not contain the exact Base/Main/Real/Live Stage Overview")
    }

    await verifyAllPageSurfaces()
    const settingsPage = await request("/settings", { parse: "text", timeoutMs: 30_000 })
    const settingsScripts = await fetchPageScripts(settingsPage.data)
    if (!settingsScripts.some((script) => script.data.includes("Prod-VST Demo") && script.data.includes("bingx-x02"))) {
      throw new Error("Production Settings assets do not contain the immutable BingX X02 Prod-VST dialog contract")
    }
    if (!settingsScripts.some((script) => script.data.includes("Configuration backup") && script.data.includes("Save Settings"))) {
      throw new Error("Production Settings assets do not contain verified save/import/export controls")
    }

    const settingsBackup = (await request("/api/settings/export", { timeoutMs: 30_000 })).data
    if (
      settingsBackup?.schema !== "cts-settings-backup" ||
      settingsBackup?.version !== 1 ||
      settingsBackup?.security?.credentialsIncluded !== false ||
      !settingsBackup?.settings ||
      !Array.isArray(settingsBackup?.connections)
    ) {
      throw new Error("Settings export did not return the canonical credential-free backup schema")
    }
    const backupText = JSON.stringify(settingsBackup)
    if (/"(?:api_key|api_secret|api_passphrase|apiKey|apiSecret|passphrase)"\s*:/.test(backupText)) {
      throw new Error("Settings export exposed a credential field")
    }
    const importResult = (await request("/api/settings/import", {
      method: "POST",
      body: settingsBackup,
      timeoutMs: 30_000,
    })).data
    if (importResult?.success !== true || importResult?.persistenceVerified !== true || importResult?.credentialsImported !== false) {
      throw new Error("Settings backup import/readback verification failed")
    }

    const systemStatus = (await request("/api/system/status", { timeoutMs: 30_000 })).data
    if (
      !validServiceBootId(systemStatus?.startup?.boot_id) ||
      !Number.isFinite(Date.parse(systemStatus?.startup?.started_at || "")) ||
      Number(systemStatus?.startup?.service_uptime_seconds) < 0 ||
      String(systemStatus?.startup?.boot_id) === String(systemStatus?.siteInstanceId || "") ||
      Number(systemStatus?.startup?.service_restart_count) < 0 ||
      Number(systemStatus?.startup?.recovery_count) < 0
    ) {
      throw new Error("System status does not expose independent service-session uptime/lifecycle counters")
    }

    const inventory = (await request(`/api/settings/connections?t=${Date.now()}`)).data
    const bingxConnections = connectionList(inventory).filter((entry) => {
      const exchange = String(entry?.exchange || entry?.exchange_type || "").toLowerCase()
      return exchange.includes("bingx") || String(entry?.id || "").toLowerCase().startsWith("bingx")
    })
    const preferredConnectionId = String(process.env.PROD_UI_CONNECTION_ID || "bingx-x02")
    const connection = bingxConnections.find((entry) => String(entry?.id || "") === preferredConnectionId) || bingxConnections[0]
    connectionId = String(connection?.id || "")
    if (!connectionId) throw new Error("The production UI has no selectable BingX connection")
    if (connectionId !== preferredConnectionId) {
      throw new Error(`Preferred production UI connection ${preferredConnectionId} is unavailable (selected ${connectionId})`)
    }

    const connectionDetail = (await request(`/api/settings/connections/${encodeURIComponent(connectionId)}`)).data
    if (
      connectionDetail?.id !== "bingx-x02" ||
      String(connectionDetail?.environment || "") !== "prod-vst" ||
      String(connectionDetail?.base_url || "") !== "https://open-api-vst.bingx.com" ||
      ![true, "1", "true"].includes(connectionDetail?.is_testnet)
    ) {
      throw new Error(`BingX X02 immutable Prod-VST identity is incomplete: ${JSON.stringify({
        id: connectionDetail?.id,
        environment: connectionDetail?.environment,
        base_url: connectionDetail?.base_url,
        is_testnet: connectionDetail?.is_testnet,
      })}`)
    }
    if (
      connectionDetail?.credentials_configured !== true ||
      connectionDetail?.api_key_configured !== true ||
      connectionDetail?.api_secret_configured !== true ||
      !String(connectionDetail?.api_key || "").includes("••••") ||
      !String(connectionDetail?.api_secret || "").includes("••••")
    ) {
      throw new Error("Connection credential storage state is missing or unmasked")
    }

    // Keep the edit/readback phase independent from engine startup. QuickStart
    // below is the sole owner of the 32-symbol processing transition.
    await request(`/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`, {
      method: "POST",
      body: { is_enabled_dashboard: false },
      timeoutMs: 30_000,
    })

    // Exercise the same PATCH/readback path as the Connection Edit dialog.
    // An attempted host/testnet downgrade must be rejected by normalization.
    const editMarker = `ui_edit_${Date.now()}`
    const editedConnection = (await request(`/api/settings/connections/${encodeURIComponent(connectionId)}`, {
      method: "PATCH",
      body: {
        ui_connection_edit_test_marker: editMarker,
        api_key: connectionDetail.api_key,
        api_secret: connectionDetail.api_secret,
        base_url: "https://open-api.bingx.com",
        environment: "prod-live",
        is_testnet: false,
      },
      timeoutMs: 30_000,
    })).data
    if (
      editedConnection?.success !== true ||
      editedConnection?.connection?.ui_connection_edit_test_marker !== editMarker ||
      editedConnection?.connection?.base_url !== "https://open-api-vst.bingx.com" ||
      editedConnection?.connection?.environment !== "prod-vst" ||
      ![true, "1", "true"].includes(editedConnection?.connection?.is_testnet)
      || editedConnection?.connection?.credentials_configured !== true
    ) {
      throw new Error("Connection Edit dialog persistence did not retain the immutable Prod-VST identity")
    }
    const editedConnectionReadback = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}?t=${Date.now()}`,
    )).data
    if (
      editedConnectionReadback?.ui_connection_edit_test_marker !== editMarker ||
      editedConnectionReadback?.credentials_configured !== true
    ) {
      throw new Error("Connection Edit read-after-write or masked credential preservation failed")
    }

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
    // The production preview combines a long-running engine soak with this
    // targeted QuickStart check.  A sibling which was already running before
    // the operator action is not evidence that this QuickStart fanned out;
    // retain that baseline and reject only newly-started siblings below.
    const beforeEngineStatus = (await request("/api/trade-engine/status-all", { timeoutMs: 30_000 })).data
    const runningConnectionIdsBeforeQuickStart = new Set(
      Array.isArray(beforeEngineStatus?.engines)
        ? beforeEngineStatus.engines
          .filter((entry) => entry?.isEngineRunning === true)
          .map((entry) => String(entry?.connectionId || ""))
          .filter(Boolean)
        : [],
    )
    const beforeCycles = cycleTotal(beforeStats)
    const beforeLivePositionCycles = livePositionCycleTotal(beforeStats)
    const beforeHistoricWork = historicWorkSnapshot(beforeStats)

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
    let observedLivePositionCycles = beforeLivePositionCycles
    let observedHistoricWork = beforeHistoricWork
    let previousCycleSample = null
    let previousLivePositionCycleSample = null
    let previousHistoricWorkSample = null
    let cycleAdvanced = false
    let livePositionCycleAdvanced = false
    let historicWorkAdvanced = false
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
      observedLivePositionCycles = livePositionCycleTotal(statsResponse.data)
      observedHistoricWork = historicWorkSnapshot(statsResponse.data)
      if (previousCycleSample !== null) {
        if (observedCycles > previousCycleSample) cycleAdvanced = true
        if (observedCycles < previousCycleSample) cycleResetObserved = true
      }
      if (previousLivePositionCycleSample !== null && observedLivePositionCycles > previousLivePositionCycleSample) {
        livePositionCycleAdvanced = true
      }
      if (previousHistoricWorkSample !== null && observedHistoricWork.completed > previousHistoricWorkSample.completed) {
        historicWorkAdvanced = true
      }
      previousCycleSample = observedCycles
      previousLivePositionCycleSample = observedLivePositionCycles
      previousHistoricWorkSample = observedHistoricWork
      // QuickStart may intentionally start a new progression epoch. Its
      // cumulative counters then reset even though the engine is healthy, so
      // prove forward movement within the currently observed epoch instead of
      // requiring the new total to exceed a previous run's total.
      // Cold starts must not be judged by entry cycles alone: those cycles are
      // correctly gated until historic Sets are authoritative. Instead prove
      // two independent live signals while bootstrapping: real historic config
      // group completion and the exit/adoption/protection loop. Once history
      // is complete, require normal entry-cycle movement as well.
      const bootstrapLiveness = historicWorkAdvanced && livePositionCycleAdvanced
      const readyLiveness = observedHistoricWork.isComplete && cycleAdvanced
      if (coordinatedSymbols.length === UI_MAX_SYMBOLS && (bootstrapLiveness || readyLiveness)) break
      await sleep(1_000)
    }
    if (coordinatedSymbols.length !== UI_MAX_SYMBOLS) {
      throw new Error(`Engine coordinated ${coordinatedSymbols.length}/${UI_MAX_SYMBOLS} UI symbols`)
    }
    if (!(historicWorkAdvanced && livePositionCycleAdvanced) && !(observedHistoricWork.isComplete && cycleAdvanced)) {
      throw new Error(
        `Production bootstrap made no verified forward progress: entry cycles ${beforeCycles} → ${observedCycles}; ` +
        `live-position cycles ${beforeLivePositionCycles} → ${observedLivePositionCycles}; ` +
        `historic config work ${beforeHistoricWork.completed}/${beforeHistoricWork.total} → ` +
        `${observedHistoricWork.completed}/${observedHistoricWork.total} ` +
        `(failed=${observedHistoricWork.failed}, stage=${observedHistoricWork.stage || "unknown"}, ` +
        `symbol=${observedHistoricWork.symbol || "unknown"})`,
      )
    }

    const scopedStatus = (await request("/api/trade-engine/status-all", { timeoutMs: 30_000 })).data
    const runningConnectionIds = Array.isArray(scopedStatus?.engines)
      ? scopedStatus.engines
        .filter((entry) => entry?.isEngineRunning === true)
        .map((entry) => String(entry?.connectionId || ""))
        .filter(Boolean)
      : []
    const newlyStartedSiblingEngineIds = runningConnectionIds.filter(
      (id) => id !== connectionId && !runningConnectionIdsBeforeQuickStart.has(id),
    )
    if (newlyStartedSiblingEngineIds.length > 0) {
      throw new Error(`Targeted QuickStart launched sibling engines: ${newlyStartedSiblingEngineIds.join(", ")}`)
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
    const [
      infoSettings,
      infoIndications,
      infoPreset,
      infoRuntime,
      infoProgression,
      infoStats,
      signalStatus,
      signalSettings,
    ] = await Promise.all([
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings?t=${Date.now()}`),
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/active-indications?t=${Date.now()}`),
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/preset-type?t=${Date.now()}`),
      request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states?t=${Date.now()}`),
      request(`/api/connections/progression/${encodeURIComponent(connectionId)}?t=${Date.now()}`, { timeoutMs: 30_000 }),
      request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats?t=${Date.now()}`, { timeoutMs: 30_000 }),
      request(`/api/indications/signals/status?connectionId=${encodeURIComponent(connectionId)}&t=${Date.now()}`, { timeoutMs: 30_000 }),
      request(`/api/settings/indications/signal?t=${Date.now()}`, { timeoutMs: 30_000 }),
    ])
    if (
      !infoSettings.data?.settings ||
      !infoIndications.data?.channels?.main ||
      !infoIndications.data?.channels?.preset ||
      infoIndications.data?.channels?.main?.signal?.enabled !== true ||
      !("presetType" in infoPreset.data) ||
      infoRuntime.data?.connectionId !== connectionId ||
      infoProgression.data?.success !== true ||
      infoStats.data?.success !== true ||
      signalStatus.data?.success !== true ||
      Number(signalStatus.data?.sourceCount) !== 35 ||
      signalStatus.data?.connections?.[0]?.sourceHealth?.length !== 35 ||
      signalSettings.data?.success !== true ||
      Number(signalSettings.data?.settings?.requestIntervalSeconds) < 30
    ) {
      throw new Error("Main Connection information dialog snapshot is incomplete")
    }
    assertStatsRelationships(infoStats.data)

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
    const originalSignalVolume = Number(originalVolume?.signal_volume_factor ?? 1)
    const nextLiveVolume = originalLiveVolume === 1.2 ? 1.3 : 1.2
    const nextSignalVolume = originalSignalVolume === 1.4 ? 1.5 : 1.4
    const volumeUpdate = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume`,
      {
        method: "POST",
        body: {
          live_volume_factor: nextLiveVolume,
          signal_volume_factor: nextSignalVolume,
        },
        timeoutMs: 30_000,
      },
    )).data
    if (
      !volumeUpdate?.success ||
      !volumeUpdate?.settingsVersion ||
      !volumeUpdate?.recoordination?.completedAt ||
      Number(volumeUpdate.live_volume_factor) !== nextLiveVolume ||
      Number(volumeUpdate.signal_volume_factor) !== nextSignalVolume
    ) {
      throw new Error(`Volume hot reload did not acknowledge the applied value: ${JSON.stringify(volumeUpdate)}`)
    }
    const volumeReadback = (await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/volume?t=${Date.now()}`,
    )).data
    if (
      Number(volumeReadback?.live_volume_factor) !== nextLiveVolume ||
      Number(volumeReadback?.signal_volume_factor) !== nextSignalVolume
    ) {
      throw new Error("Volume setting read-after-write mismatch")
    }

    const relationshipStats = (await request(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
      { timeoutMs: 30_000 },
    )).data
    assertStatsRelationships(relationshipStats)
    const liveDirections = relationshipStats?.connectionStageOverview?.live
    if (
      Number(liveDirections?.total || 0) > 0 &&
      Number(liveDirections?.long || 0) === Number(liveDirections?.short || 0)
    ) {
      throw new Error(`Live long/short counts appear mirrored: ${liveDirections.long}/${liveDirections.short}`)
    }
    const directionOrders = relationshipStats?.liveExecution?.ordersByDirection
    if (
      Number(directionOrders?.long?.placed || 0) > 0 &&
      Number(directionOrders?.long?.placed || 0) === Number(directionOrders?.short?.placed || 0)
    ) {
      throw new Error(`Live order counts appear mirrored: ${directionOrders.long.placed}/${directionOrders.short.placed}`)
    }

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

    const beforeResumeStats = (await request(
      `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
    )).data
    const beforeResumeCycles = cycleTotal(beforeResumeStats)
    const beforeResumeLivePositionCycles = livePositionCycleTotal(beforeResumeStats)
    const beforeResumeHistoricWork = historicWorkSnapshot(beforeResumeStats)
    await request("/api/trade-engine/resume", { method: "POST", timeoutMs: 30_000 })
    await waitFor(
      "global resume status",
      async () => (await request("/api/trade-engine/status")).data,
      (status) => status?.paused === false && status?.actualRuntimeStatus === "running",
    )
    let previousResumeCycles = beforeResumeCycles
    let previousResumeLivePositionCycles = beforeResumeLivePositionCycles
    let previousResumeHistoricWork = beforeResumeHistoricWork
    let resumeCycleResetObserved = false
    let resumeCycleAdvanced = false
    let resumeLivePositionCycleAdvanced = false
    let resumeHistoricWorkAdvanced = false
    await waitFor(
      "cycles after resume",
      async () => (await request(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)).data,
      (stats) => {
        const current = cycleTotal(stats)
        const currentLivePositionCycles = livePositionCycleTotal(stats)
        const currentHistoricWork = historicWorkSnapshot(stats)
        if (current < previousResumeCycles) resumeCycleResetObserved = true
        if (current > previousResumeCycles) resumeCycleAdvanced = true
        if (currentLivePositionCycles > previousResumeLivePositionCycles) resumeLivePositionCycleAdvanced = true
        if (currentHistoricWork.completed > previousResumeHistoricWork.completed) resumeHistoricWorkAdvanced = true
        previousResumeCycles = current
        previousResumeLivePositionCycles = currentLivePositionCycles
        previousResumeHistoricWork = currentHistoricWork
        // pause()/resume() detaches the stopped manager and starts a fresh
        // progression generation. Accept either monotonic continuation or a
        // proven reset followed by forward movement inside that new epoch.
        // During historic bootstrap, entry cycles remain correctly gated; in
        // that state require both authoritative historic work and the live
        // position/protection loop to advance instead of treating zero entry
        // cycles as a stalled resume.
        const entryLiveness = current > beforeResumeCycles || (
          resumeCycleResetObserved && resumeCycleAdvanced && current > 0
        )
        const bootstrapLiveness = resumeHistoricWorkAdvanced && resumeLivePositionCycleAdvanced
        const readyLiveness = currentHistoricWork.isComplete && resumeCycleAdvanced
        return entryLiveness || bootstrapLiveness || readyLiveness
      },
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
      body: {
        live_volume_factor: originalLiveVolume,
        signal_volume_factor: originalSignalVolume,
      },
      timeoutMs: 30_000,
    })

    const positionIntegrityResult = await waitFor(
      "stable simulation position/order relation integrity",
      async () => {
        const payload = (await request(
          `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}`,
          { timeoutMs: 30_000 },
        )).data
        if (Array.isArray(payload?.realPositions) && payload.realPositions.length > 0) {
          throw new Error("A real exchange position appeared during the UI paper test")
        }
        return {
          state: {
            hasRealPositionsArray: Array.isArray(payload?.realPositions),
            realPositions: Array.isArray(payload?.realPositions) ? payload.realPositions.length : null,
            simulatedPositions: Array.isArray(payload?.simulatedPositions) ? payload.simulatedPositions.length : null,
            executionMode: payload?.dataIntegrity?.liveExecutionMode ?? null,
            liveTradeRequested: payload?.dataIntegrity?.liveTradeRequested ?? null,
            relationSuccess: payload?.dataIntegrity?.positionOrderRelationIntegrity?.success ?? null,
            relationMismatches: payload?.dataIntegrity?.positionOrderRelationIntegrity?.mismatchCount ?? null,
          },
          payload,
        }
      },
      (result) => result.state.hasRealPositionsArray
        && result.state.realPositions === 0
        && result.state.executionMode === "simulation"
        && result.state.liveTradeRequested === false
        && result.state.relationSuccess === true,
      30_000,
    )
    const positions = positionIntegrityResult.payload

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
      pageSurfacesVerified: UI_PAGE_PATHS.length,
      informationDialogAssetVerified: true,
      informationDialogSnapshotVerified: true,
      connectionId,
      runningConnectionIds,
      symbols: symbols.length,
      quickStartLatencyMs: enabled.latencyMs,
      engineCyclesBefore: beforeCycles,
      engineCyclesAfter: observedCycles,
      cycleResetObserved,
      resumeCycleResetObserved,
      settingsHotReloadVerified: true,
      settingsBackupRoundTripVerified: true,
      credentialPersistenceVerified: true,
      runtimeSessionLifecycleVerified: true,
      independentLongShortVerified: true,
      connectionEditDialogVerified: true,
      volumeHotReloadVerified: true,
      signalSourceRegistryVerified: 35,
      signalEnabledByDefaultVerified: true,
      signalVolumeHotReloadVerified: true,
      mainConnectionToggleVerified: true,
      globalControlsVerified: ["pause", "resume", "stop", "start"],
      statusRelationshipsVerified: true,
      positionOrderRelationIntegrityVerified: positions.dataIntegrity.positionOrderRelationIntegrity.checkedPositions,
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
