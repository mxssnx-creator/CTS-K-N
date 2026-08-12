#!/usr/bin/env node
/**
 * Execution-free Direct-Trade lifecycle contract.
 *
 * It proves that open rows persist in their own management stage and are
 * excluded from realised PF/DDT, then closes the same row and verifies the
 * stage/index hand-off. It never calls an exchange or order endpoint.
 */

const baseUrl = (process.env.DIRECT_TRADE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const instanceId = `direct-trade-lifecycle-${process.pid}`

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

const now = Date.now()
const closed = {
  id: "lifecycle-closed",
  status: "closed",
  symbol: "BTCUSDT",
  direction: "long",
  configKey: "cfg-closed",
  strategyType: "standard",
  entryPrice: 100,
  exitPrice: 100.5,
  grossPnl: 0.5,
  positionCostPercent: 0.1,
  pnl: 0.4,
  drawdownTimeMin: 1,
  openedAt: new Date(now - 20 * 60_000).toISOString(),
  closedAt: new Date(now - 10 * 60_000).toISOString(),
}
const open = {
  id: "lifecycle-open",
  status: "open",
  symbol: "ETHUSDT",
  direction: "short",
  configKey: "cfg-open",
  strategyType: "combination",
  timeframe: "5m+15m",
  entryPrice: 100,
  lastObservedPrice: 99,
  positionCostPercent: 0.1,
  trailingArmed: true,
  exitTactic: "relative",
  openedAt: new Date(now - 5 * 60_000).toISOString(),
}

const firstSync = await request("/api/trade-engine/direct-trade", {
  method: "POST",
  body: JSON.stringify({
    action: "processor-sync",
    instanceId,
    tickCount: 1,
    positions: [closed, open],
    stats: { totalOrders: 2, totalFilled: 2, totalPnl: 0.4, winCount: 1, lossCount: 0, pnlHistory: [] },
    configStatus: {},
    configPerformance: { "cfg-closed": [{ pnl: 0.4, drawdownTimeMin: 1 }] },
  }),
})
if (!firstSync.leaseHeld) throw new Error("Lifecycle processor lease was not acquired")

const during = await request("/api/trade-engine/direct-trade/status")
if (during.openPositions !== 1 || during.openPositionStage?.counts?.total !== 1) {
  throw new Error(`Open position stage mismatch: ${JSON.stringify(during.openPositionStage)}`)
}
if (during.stats?.last12Pos?.pnl !== 0.4 || during.stats?.last12Pos?.pfInfinite !== true) {
  throw new Error(`Open position leaked into realised PF/DDT: ${JSON.stringify(during.stats?.last12Pos)}`)
}

const closedOpen = {
  ...open,
  status: "closed",
  exitPrice: 99.6,
  grossPnl: 0.4,
  pnl: 0.3,
  drawdownTimeMin: 0.5,
  closedAt: new Date(now).toISOString(),
  exitReason: "trailing",
}
await request("/api/trade-engine/direct-trade", {
  method: "POST",
  body: JSON.stringify({
    action: "processor-sync",
    instanceId,
    tickCount: 2,
    positions: [closed, closedOpen],
    stats: { totalOrders: 2, totalFilled: 2, totalPnl: 0.7, winCount: 2, lossCount: 0, pnlHistory: [] },
    configStatus: {},
    configPerformance: {
      "cfg-closed": [{ pnl: 0.4, drawdownTimeMin: 1 }],
      "cfg-open": [{ pnl: 0.3, drawdownTimeMin: 0.5, exitReason: "trailing" }],
    },
  }),
})
const after = await request("/api/trade-engine/direct-trade/status")
if (after.openPositions !== 0 || after.openPositionStage?.counts?.total !== 0) {
  throw new Error(`Closed position remained in open stage: ${JSON.stringify(after.openPositionStage)}`)
}
if (after.stats?.last12Pos?.pnl !== 0.7 || after.stats?.last12Pos?.pfInfinite !== true) {
  throw new Error(`Closed position did not enter realised rolling stats: ${JSON.stringify(after.stats?.last12Pos)}`)
}

console.log(JSON.stringify({
  test: "direct-trade-position-lifecycle",
  simulatedOnly: true,
  during: { openRows: during.openPositionStage.counts.total, realisedPnl: during.stats.last12Pos.pnl },
  after: { openRows: after.openPositionStage.counts.total, realisedPnl: after.stats.last12Pos.pnl },
}, null, 2))
