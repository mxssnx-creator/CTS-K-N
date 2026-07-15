#!/usr/bin/env node

/** Read-only production-preview and UI/API continuity probe. */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3002}`
const PAGES = [
  "/",
  "/main",
  "/settings",
  "/monitoring",
  "/strategies",
  "/logistics",
  "/active-exchange",
  "/live-trading",
  "/presets",
  "/tracking",
]

async function request(pathname, { json = false, timeoutMs = 15_000, method = "GET", body } = {}) {
  const url = new URL(pathname, BASE_URL)
  const response = await fetch(url, {
    method,
    headers: {
      Accept: json ? "application/json" : "text/html,application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const responseBody = await response.text()
  if (!response.ok) throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${responseBody.slice(0, 160)}`)
  if (!json) return responseBody
  try { return JSON.parse(responseBody) } catch { throw new Error(`${method} ${pathname} returned invalid JSON`) }
}

const asBoolean = (value) => value === true || value === 1 || value === "1" || value === "true"

async function readSseChunk(reader, timeoutMs = 10_000) {
  let timeout
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SSE chunk timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function verifyConnectionSwitchAndSse(connectionId, originalEnabled) {
  const controller = new AbortController()
  const response = await fetch(
    new URL(`/api/ws?connectionId=*`, BASE_URL),
    { headers: { Accept: "text/event-stream" }, signal: controller.signal },
  )
  if (!response.ok || !response.body) throw new Error(`SSE endpoint returned HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const targetEnabled = !originalEnabled

  try {
    const first = await readSseChunk(reader)
    const handshake = decoder.decode(first.value || new Uint8Array(), { stream: true })
    if (!handshake.includes("event: connected") || !handshake.includes('"type":"connected"')) {
      throw new Error("SSE connected handshake invalid")
    }

    const toggle = await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/toggle`,
      { json: true, method: "POST", body: { is_enabled: targetEnabled }, timeoutMs: 30_000 },
    )
    if (!toggle?.success || asBoolean(toggle?.connection?.is_enabled) !== targetEnabled) {
      throw new Error("Connection switch response did not reflect requested state")
    }
    if ("api_secret" in (toggle.connection || {}) || "api_key" in (toggle.connection || {})) {
      throw new Error("Connection switch response exposed credential fields")
    }

    let canonicalUpdateSeen = false
    for (let attempt = 0; attempt < 5 && !canonicalUpdateSeen; attempt++) {
      const chunk = await readSseChunk(reader)
      const text = decoder.decode(chunk.value || new Uint8Array(), { stream: true })
      canonicalUpdateSeen = text.includes("dashboard.sectionUpdated") && text.includes(connectionId)
    }
    if (!canonicalUpdateSeen) throw new Error("Connection switch did not produce a canonical SSE update")

    const persisted = await request("/api/settings/connections", { json: true, timeoutMs: 30_000 })
    const rows = Array.isArray(persisted) ? persisted : persisted?.connections
    const current = Array.isArray(rows) ? rows.find((connection) => String(connection?.id) === connectionId) : null
    if (!current || asBoolean(current.is_enabled) !== targetEnabled) {
      throw new Error("Connection switch did not persist across a fresh API read")
    }
  } finally {
    await request(
      `/api/settings/connections/${encodeURIComponent(connectionId)}/toggle`,
      { json: true, method: "POST", body: { is_enabled: originalEnabled }, timeoutMs: 30_000 },
    ).catch(() => undefined)
    await reader.cancel().catch(() => undefined)
    controller.abort()
  }
}

function assertFiniteNonNegative(value, label) {
  if (value == null) return
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid: ${value}`)
}

async function main() {
  const startedAt = Date.now()
  const health = await request("/api/health", { json: true, timeoutMs: 30_000 })
  if (!health?.status && health?.alive !== true) throw new Error("Health response has no liveness status")

  for (const page of PAGES) {
    const html = await request(page, { timeoutMs: 30_000 })
    if (!html.toLowerCase().includes("<!doctype html") && !html.includes("__next")) {
      throw new Error(`${page} did not render a Next.js document`)
    }
  }

  const [connectionsPayload, settingsPayload, monitoring] = await Promise.all([
    request("/api/connections", { json: true, timeoutMs: 30_000 }),
    request("/api/settings", { json: true, timeoutMs: 30_000 }),
    request("/api/system/monitoring", { json: true, timeoutMs: 30_000 }),
  ])
  if (!connectionsPayload?.success || !Array.isArray(connectionsPayload.connections)) {
    throw new Error("Connections API schema invalid")
  }
  if (!settingsPayload || typeof settingsPayload !== "object") throw new Error("Settings API schema invalid")

  const connectionId = String(connectionsPayload.connections[0]?.id || "")
  let history = null
  const progressionReads = []
  if (connectionId) {
    const selectedConnection = connectionsPayload.connections.find((connection) => String(connection?.id) === connectionId)
    await verifyConnectionSwitchAndSse(connectionId, asBoolean(selectedConnection?.is_enabled))

    history = await request(
      `/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=500`,
      { json: true, timeoutMs: 30_000 },
    )
    if (!history?.success || !Array.isArray(history.rows)) throw new Error("Trade-history API schema invalid")
    if (history.rows.length > 500 || history?.paging?.maximum !== 500 || history?.paging?.visibleWindow !== 50) {
      throw new Error("Trade-history 500/50 bounds invalid")
    }
    for (const key of ["wins", "losses", "netPnl", "winRate"]) {
      if (!Number.isFinite(Number(history?.summary?.[key] ?? 0))) throw new Error(`Trade-history summary.${key} invalid`)
    }

    for (let index = 0; index < 20; index++) {
      const stats = await request(
        `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
        { json: true, timeoutMs: 30_000 },
      )
      const stages = stats?.breakdown?.strategies || stats?.strategies || {}
      for (const field of ["base", "main", "real", "baseEvaluated", "mainEvaluated", "realEvaluated"]) {
        assertFiniteNonNegative(stages[field], `progression.${field}`)
      }
      progressionReads.push(stats)
    }

    const [logistics, engineStats, livePositions, engineStatuses, connectionSettings, presetOverview, modeStates] = await Promise.all([
      request(`/api/logistics/queue?connectionId=${encodeURIComponent(connectionId)}`, { json: true, timeoutMs: 30_000 }),
      request(`/api/trading/engine-stats?connection_id=${encodeURIComponent(connectionId)}`, { json: true, timeoutMs: 30_000 }),
      request(`/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}`, { json: true, timeoutMs: 30_000 }),
      request("/api/trade-engine/status-all", { json: true, timeoutMs: 30_000 }),
      request(`/api/settings/connections/${encodeURIComponent(connectionId)}/settings`, { json: true, timeoutMs: 30_000 }),
      request(`/api/preset-optimizer?connectionId=${encodeURIComponent(connectionId)}`, { json: true, timeoutMs: 30_000 }),
      request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states`, { json: true, timeoutMs: 30_000 }),
    ])
    if (!logistics?.success) throw new Error("Logistics API schema invalid")
    for (const field of ["queueSize", "processingRate", "successRate", "avgLatency", "completedOrders", "failedOrders"]) {
      assertFiniteNonNegative(logistics[field], `logistics.${field}`)
    }
    if (!engineStats || typeof engineStats !== "object") throw new Error("Engine stats API schema invalid")
    const liveRows = Array.isArray(livePositions) ? livePositions : livePositions?.positions
    if (!Array.isArray(liveRows)) throw new Error("Live positions API schema invalid")
    if (!engineStatuses || !Array.isArray(engineStatuses.engines)) throw new Error("Engine status API schema invalid")
    if (!connectionSettings?.settings || typeof connectionSettings.settings !== "object") throw new Error("Connection settings API schema invalid")
    if (!presetOverview?.success || !Array.isArray(presetOverview?.data?.presets)) {
      throw new Error("Preset optimizer API schema invalid")
    }
    if (Number(presetOverview?.data?.settings?.presetsPerSymbol) !== 4) {
      throw new Error("Preset optimizer default count is not four per symbol/type")
    }
    if (!modeStates?.success || !modeStates?.modes?.mainTrade || !modeStates?.modes?.presetTrade) {
      throw new Error("Main/Preset engine-state schema invalid")
    }
  }

  const memory = monitoring?.memory || monitoring?.system?.memory || monitoring?.resources?.memory || {}
  for (const [field, value] of Object.entries(memory)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`monitoring.memory.${field} invalid`)
  }

  console.log(JSON.stringify({
    success: true,
    mode: "production-preview-read-only",
    orderRequests: 0,
    pagesVerified: PAGES.length,
    connections: connectionsPayload.connections.length,
    connectionId: connectionId || null,
    tradeHistoryRows: history?.rows?.length || 0,
    tradeHistoryWins: history?.summary?.wins || 0,
    tradeHistoryLosses: history?.summary?.losses || 0,
    progressionReads: progressionReads.length,
    connectionSwitchesVerified: connectionId ? 2 : 0,
    durationMs: Date.now() - startedAt,
  }, null, 2))
}

main().catch((error) => {
  console.error("[verify-prod-preview] failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
