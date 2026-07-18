#!/usr/bin/env node
/**
 * autotest-drift.mjs — Automated drift detection test runner
 * Polls engine state periodically and reports any unexpected drift
 * in positions, strategies, or progression state.
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'
const INTERVAL_MS = parseInt(process.env.DRIFT_INTERVAL_MS || '60000', 10)
const MAX_RUNS = parseInt(process.env.DRIFT_MAX_RUNS || '0', 10) // 0 = unlimited

let runCount = 0
let previousState = null
let successfulRuns = 0
let detectedDrifts = 0

async function fetchJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`)
  return res.json()
}

function detectDrift(prev, curr) {
  const drifts = []

  // Check engine status drift
  if (prev.engineStatus !== curr.engineStatus) {
    drifts.push(`engine.status: ${prev.engineStatus} → ${curr.engineStatus}`)
  }

  // Check active connections count
  if (prev.connectionsCount !== curr.connectionsCount) {
    drifts.push(`connectionsCount: ${prev.connectionsCount} → ${curr.connectionsCount}`)
  }

  if (
    curr.engineStatus === 'running' &&
    curr.activeEngineCount > 0 &&
    curr.connectionHeartbeatFresh === false &&
    curr.totalCycles <= prev.totalCycles
  ) {
    drifts.push(
      `running engine is stalled: cycles ${prev.totalCycles} → ${curr.totalCycles}, connection heartbeat is stale`,
    )
  }

  return drifts
}

async function runCheck() {
  runCount++
  const timestamp = new Date().toISOString()
  console.log(`[autotest-drift] [${timestamp}] Run #${runCount}`)

  try {
    const [health, engineStatus] = await Promise.allSettled([
      fetchJSON('/api/health'),
      fetchJSON('/api/trade-engine/status'),
    ])

    if (health.status === 'rejected' && engineStatus.status === 'rejected') {
      throw new Error(`all monitored APIs failed: ${health.reason?.message}; ${engineStatus.reason?.message}`)
    }

    const engine = engineStatus.status === 'fulfilled' ? engineStatus.value : null
    const connections = Array.isArray(engine?.connections) ? engine.connections : []
    const connectionHeartbeatFresh = engineStatus.status === 'fulfilled'
      ? Boolean(
          engine?.connectionHeartbeatFresh ||
          connections.some((connection) => connection?.connectionHeartbeatFresh || connection?.distributedHeartbeatFresh),
        )
      : null
    const totalCycles = connections.reduce(
      (sum, connection) => sum + Number(connection?.progression?.cycles_completed || connection?.state?.cyclesCompleted || 0),
      0,
    )

    const currentState = {
      engineStatus: engine?.actualRuntimeStatus ?? engine?.actualStatus ?? engine?.status ?? null,
      health: health.status === 'fulfilled' ? health.value : null,
      connectionsCount: engineStatus.status === 'fulfilled'
        ? (connections.length || Number(engine?.activeEngineCount || 0))
        : 0,
      activeEngineCount: Number(engine?.activeEngineCount || 0),
      connectionHeartbeatFresh,
      totalCycles,
    }

    if (health.status === 'rejected') {
      console.warn(`[autotest-drift] Health check failed: ${health.reason?.message}`)
    } else {
      console.log(`[autotest-drift] Health: ${currentState.health?.status ?? 'unknown'}`)
    }

    if (engineStatus.status === 'rejected') {
      console.warn(`[autotest-drift] Engine status failed: ${engineStatus.reason?.message}`)
    } else {
      console.log(
        `[autotest-drift] Engine: ${currentState.engineStatus ?? 'unknown'}; ` +
        `cycles=${currentState.totalCycles}; connectionHeartbeatFresh=${String(currentState.connectionHeartbeatFresh)}`,
      )
    }

    if (previousState) {
      const drifts = detectDrift(previousState, currentState)
      if (drifts.length > 0) {
        detectedDrifts += drifts.length
        console.warn(`[autotest-drift] ⚠ DRIFT DETECTED:`)
        drifts.forEach(d => console.warn(`  - ${d}`))
      } else {
        console.log(`[autotest-drift] ✓ No drift detected`)
      }
    } else {
      console.log(`[autotest-drift] ✓ Baseline captured`)
    }

    previousState = currentState
    successfulRuns++
  } catch (err) {
    console.error(`[autotest-drift] Error: ${err.message}`)
  }

  if (MAX_RUNS > 0 && runCount >= MAX_RUNS) {
    console.log(`[autotest-drift] Completed ${runCount} runs. Exiting.`)
    process.exit(successfulRuns > 0 && detectedDrifts === 0 ? 0 : 1)
  }
}

console.log(`[autotest-drift] Starting drift monitor`)
console.log(`[autotest-drift] Target: ${BASE_URL}`)
console.log(`[autotest-drift] Interval: ${INTERVAL_MS}ms`)
console.log(`[autotest-drift] Max runs: ${MAX_RUNS === 0 ? 'unlimited' : MAX_RUNS}`)
console.log('')

// Run immediately, then on interval
await runCheck()
setInterval(runCheck, INTERVAL_MS)
