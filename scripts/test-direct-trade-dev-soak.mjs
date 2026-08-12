#!/usr/bin/env node
/**
 * Direct-Trade dev-server integration soak.
 *
 * The script is deliberately execution-free: it asks the server to build the
 * public-market historical matrix and repeatedly evaluates current entry
 * pulses, but never starts Direct-Trade, toggles live mode, or calls an order
 * endpoint. It is safe to run against a dev server with FORCE_SIMULATED=1.
 *
 * Environment:
 *   DIRECT_TRADE_BASE_URL=http://127.0.0.1:3000
 *   DIRECT_TRADE_DEV_SYMBOLS=32
 *   DIRECT_TRADE_DEV_HISTORY_HOURS=48
 *   DIRECT_TRADE_DEV_SOAK_ROUNDS=5
 *   DIRECT_TRADE_DEV_SOAK_INTERVAL_MS=60000
 */

const baseUrl = (process.env.DIRECT_TRADE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const symbolCount = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_DEV_SYMBOLS) || 32))
const historyHours = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_DEV_HISTORY_HOURS) || 48))
const rounds = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_DEV_SOAK_ROUNDS) || 5))
const intervalMs = Math.max(250, Math.floor(Number(process.env.DIRECT_TRADE_DEV_SOAK_INTERVAL_MS) || 60_000))
const strategyTypes = ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(330_000),
  })
  const payload = await response.json().catch(() => ({ error: `Non-JSON response (${response.status})` }))
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

const health = await request("/api/health")
if (!health) throw new Error("Dev server health endpoint returned no body")

const calculation = await request("/api/trade-engine/direct-trade/calculate", {
  method: "POST",
  body: JSON.stringify({
    symbolCount,
    historyHours,
    timeframes: ["5m", "15m", "30m"],
    strategyTypes,
    entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
    exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
    entryTiming: "current",
    activityVolumeRatio: 1,
    minVolFactor: 0.1,
    maxSlRatio: 0.75,
    inverseMaxSlRatio: 1.25,
    trailingEnabled: true,
    minProfitFactor: 0.8,
    maxDrawdownTimeMin: 10,
    maxHoldMinutes: 120,
    blockRange: [1, 12],
  }),
})

if (!calculation?.success || calculation?.summary?.historyHours !== historyHours) {
  throw new Error(`Direct-Trade ${historyHours}h calculation did not complete: ${JSON.stringify(calculation)}`)
}
for (const type of strategyTypes) {
  if (!Number.isFinite(Number(calculation?.summary?.byStrategyType?.[type]?.evaluated))) {
    throw new Error(`Calculation did not report the ${type} strategy lineage`)
  }
}
if (symbolCount >= 32 && calculation?.configStorage?.mode !== "chunked") {
  throw new Error(`Maximum-symbol calculation must use chunked persistence: ${JSON.stringify(calculation?.configStorage)}`)
}

const pulses = []
for (let round = 0; round < rounds; round++) {
  const startedAt = Date.now()
  const [pulse, status, ...statistics] = await Promise.all([
    request("/api/trade-engine/direct-trade/pulse"),
    request("/api/trade-engine/direct-trade/status"),
    ...strategyTypes.map((strategyType) => request(
      `/api/trade-engine/direct-trade?view=statistics&timeframe=all&direction=all&state=all&strategyType=${strategyType}`,
    )),
  ])
  if (!pulse?.success || !Array.isArray(pulse.activeSignalKeys)) {
    throw new Error(`Direct-Trade pulse ${round + 1} was incomplete: ${JSON.stringify(pulse)}`)
  }
  if (status?.state?.liveMode === true) {
    throw new Error("Dev soak refuses a server that is in live mode")
  }
  for (let index = 0; index < statistics.length; index++) {
    const rows = Array.isArray(statistics[index]?.rows) ? statistics[index].rows : []
    if (rows.length > 0 && !rows.every((row) =>
      Number.isFinite(Number(row?.recentPositionCount)) &&
      (row?.recentProfitFactorInfinite === true || Number.isFinite(Number(row?.recentProfitFactor))) &&
      (row?.lastPositionExitReason == null || typeof row.lastPositionExitReason === "string"),
    )) {
      throw new Error(`Statistics response did not preserve recent-position metrics for ${strategyTypes[index]}`)
    }
  }
  pulses.push({
    round: round + 1,
    elapsedMs: Date.now() - startedAt,
    signalsEvaluated: Number(pulse.signalsEvaluated || 0),
    activeSignals: pulse.activeSignalKeys.length,
    processorHealthy: status?.processor?.isHealthy === true,
    strategyTypes: Object.fromEntries(statistics.map((snapshot, index) => [strategyTypes[index], {
      matched: Number(snapshot?.matched || 0),
      topRows: Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0,
    }])),
  })
  if (round + 1 < rounds) await sleep(intervalMs)
}

console.log(JSON.stringify({
  test: "direct-trade-dev-soak",
  baseUrl,
  simulatedOnly: true,
  symbolCount,
  historyHours,
  evaluatedSets: calculation.summary.evaluatedSets,
  validSets: calculation.summary.validSets,
  configStorage: calculation.configStorage,
  byStrategyType: calculation.summary.byStrategyType,
  pulses,
}, null, 2))
