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

async function main() {
  let connectionId = ""
  let stopAttempted = false

  try {
    const page = await request("/", { parse: "text", timeoutMs: 30_000 })
    if (!page.contentType.includes("text/html") || !page.data.includes("/_next/static/")) {
      throw new Error("Production dashboard HTML/client assets were not served")
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
      if (coordinatedSymbols.length === UI_MAX_SYMBOLS && observedCycles > beforeCycles) break
      await sleep(1_000)
    }
    if (coordinatedSymbols.length !== UI_MAX_SYMBOLS) {
      throw new Error(`Engine coordinated ${coordinatedSymbols.length}/${UI_MAX_SYMBOLS} UI symbols`)
    }
    if (observedCycles <= beforeCycles) {
      throw new Error(`Production engine cycles did not advance (${beforeCycles} → ${observedCycles})`)
    }

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
      connectionId,
      symbols: symbols.length,
      quickStartLatencyMs: enabled.latencyMs,
      engineCyclesBefore: beforeCycles,
      engineCyclesAfter: observedCycles,
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
