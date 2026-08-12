#!/usr/bin/env node
/**
 * Stateful, execution-free Direct-Trade recovery contract.
 *
 * The surrounding harness starts a paper-only server, runs this scenario,
 * terminates the server, then starts it again against the same Redis snapshot
 * and invokes this script a second time with DIRECT_TRADE_RECOVERY_PHASE=after-restart.
 *
 * It proves that settings are normalised/persisted, a crashed lease owner is
 * replaced only after expiry, Stop preserves open management rows, and a
 * physical API restart restores those rows without making any order request.
 */

const baseUrl = (process.env.DIRECT_TRADE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const phase = process.env.DIRECT_TRADE_RECOVERY_PHASE || "before-crash"
const instancePrefix = `direct-recovery-${process.pid}`
const leaseWaitMs = Math.max(200, Math.floor(Number(process.env.DIRECT_TRADE_RECOVERY_LEASE_WAIT_MS) || 6_300))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

async function post(body) {
  const result = await request("/api/trade-engine/direct-trade", {
    method: "POST",
    body: JSON.stringify(body),
  })
  assert(result.response.ok, `POST ${body.action} failed: ${result.response.status} ${JSON.stringify(result.body)}`)
  return result.body
}

function openPosition() {
  return {
    id: "recovery-open-position",
    status: "open",
    symbol: "BTCUSDT",
    direction: "long",
    configKey: "recovery|BTCUSDT|long|combination",
    strategyType: "combination",
    timeframe: "5m+15m",
    entryPrice: 100,
    lastObservedPrice: 100.2,
    positionCostPercent: 0.1,
    openedAt: new Date(Date.now() - 30_000).toISOString(),
  }
}

async function beforeCrash() {
  const started = await post({
    action: "start",
    liveMode: "true", // Invalid non-boolean input must not open live mode.
    symbolOrder: "volume",
    processingIntervalMs: 280,
    minRecentProfitFactor: 25,
    recentEvaluationPositions: 12,
    maxTotalPositions: 300,
    blockRange: [0, 12],
  })
  assert(started.state.enabled === true, "Start did not enable Direct-Trade")
  assert(started.state.liveMode === false, "Non-boolean live mode was accepted")
  assert(started.state.minRecentProfitFactor === 25, "PF-25 default/settings were not persisted")
  assert(started.state.processingIntervalMs === 280, "280ms processing interval was not persisted")

  // A live request has to name a connection. This exercises the fail-closed
  // control gate without supplying a credential or contacting an exchange.
  const liveAttempt = await request("/api/trade-engine/direct-trade", {
    method: "POST",
    body: JSON.stringify({ action: "toggle-live", liveMode: true }),
  })
  assert(liveAttempt.response.status === 409, "Live mode was enabled without an explicit connection")

  const settingsOne = await post({
    action: "update-config",
    symbolOrder: "not-a-real-order",
    timeframes: ["5m", "15m"],
    strategyTypes: ["combination", "inverse"],
    entryTactics: ["relative"],
    exitTactics: ["relative", "time"],
    trailingEnabled: false,
    minRecentProfitFactor: 25,
    processingIntervalMs: 280,
  })
  assert(settingsOne.state.symbolOrder === "volatility_1h", "Invalid symbol order was not normalised")
  assert(settingsOne.state.timeframes.join(",") === "5m,15m", "Timeframe settings were not persisted")
  assert(settingsOne.state.strategyTypes.join(",") === "combination,inverse", "Strategy settings were not persisted")

  const owner = `${instancePrefix}-owner`
  const snapshot = {
    action: "processor-sync",
    instanceId: owner,
    tickCount: 1,
    positions: [openPosition()],
    stats: { totalOrders: 1, totalFilled: 1, totalPnl: 0, winCount: 0, lossCount: 0, pnlHistory: [] },
    configStatus: {},
    configPerformance: {},
  }
  const acquired = await post(snapshot)
  assert(acquired.leaseHeld === true, "Initial processor owner did not acquire lease")

  const standby = await post({ ...snapshot, instanceId: `${instancePrefix}-standby`, tickCount: 2 })
  assert(standby.leaseHeld === false, "Second processor overwrote an active lease")

  // Simulate a hard worker crash: it stops renewing its six-second lease. The
  // replacement sends the complete durable position row it restored locally.
  await sleep(leaseWaitMs)
  const replacement = await post({ ...snapshot, instanceId: `${instancePrefix}-replacement`, tickCount: 3 })
  assert(replacement.leaseHeld === true, "Replacement did not acquire the expired processor lease")

  const stopped = await post({ action: "stop" })
  assert(stopped.state.enabled === false, "Stop did not disable new Direct-Trade entries")
  const settingsWhileStopped = await post({
    action: "update-config",
    trailingEnabled: true,
    processingIntervalMs: 280,
    minRecentProfitFactor: 25,
  })
  assert(settingsWhileStopped.state.enabled === false && settingsWhileStopped.state.trailingEnabled === true,
    "Settings changed incorrectly re-enabled Direct-Trade")

  const status = await request("/api/trade-engine/direct-trade/status")
  assert(status.response.ok && status.body.openPositions === 1 && status.body.openPositionStage?.counts?.total === 1,
    `Stopped open position was not retained for management: ${JSON.stringify(status.body)}`)
  return {
    phase,
    leaseTakeover: true,
    settingsPersisted: true,
    openPositions: status.body.openPositions,
    simulatedOnly: true,
  }
}

async function afterRestart() {
  const initial = await request("/api/trade-engine/direct-trade/status")
  assert(initial.response.ok, "Direct-Trade status did not recover after server restart")
  assert(initial.body.state?.enabled === false, "Stopped state was not durable across server restart")
  assert(initial.body.openPositions === 1 && initial.body.openPositionStage?.counts?.total === 1,
    `Open management stage was lost after restart: ${JSON.stringify(initial.body)}`)
  assert(initial.body.state?.minRecentProfitFactor === 25 && initial.body.state?.processingIntervalMs === 280,
    "PF/interval settings were not durable across restart")

  // A fresh worker must be able to adopt the persisted row after restart. The
  // retry loop models the finite lease TTL if the crash occurred immediately
  // after a final heartbeat write.
  const instanceId = `${instancePrefix}-after-restart`
  let adopted = null
  for (let attempt = 0; attempt < 36; attempt++) {
    const result = await post({
      action: "processor-sync",
      instanceId,
      tickCount: 10 + attempt,
      positions: [openPosition()],
      stats: { totalOrders: 1, totalFilled: 1, totalPnl: 0, winCount: 0, lossCount: 0, pnlHistory: [] },
      configStatus: {},
      configPerformance: {},
    })
    if (result.leaseHeld) { adopted = result; break }
    await sleep(250)
  }
  assert(adopted?.leaseHeld === true, "Restarted worker could not adopt the durable lease/position row")

  const restarted = await post({
    action: "start",
    liveMode: false,
    symbolOrder: "volatility",
    processingIntervalMs: 280,
    minRecentProfitFactor: 25,
  })
  assert(restarted.state.enabled === true && restarted.state.symbolOrder === "volatility",
    "Restart configuration did not apply after recovery")
  const finalStop = await post({ action: "stop" })
  assert(finalStop.state.enabled === false, "Final controlled stop failed")
  return {
    phase,
    serverRestartRestoredState: true,
    workerAdoptedOpenStage: true,
    finalEnabled: finalStop.state.enabled,
    simulatedOnly: true,
  }
}

const result = phase === "after-restart" ? await afterRestart() : await beforeCrash()
console.log(JSON.stringify({ test: "direct-trade-recovery-scenarios", ...result }, null, 2))
