/**
 * Direct-Trade cycle cadence contract.
 *
 * `processingIntervalMs` is a start-to-start target. A cycle that finishes
 * early waits out the remaining target interval; a slow cycle never overlaps
 * the next one. In both cases a fixed 50 ms post-completion pause separates
 * all state/Redis/order effects from the next cycle.
 */
export const DIRECT_TRADE_INTER_CYCLE_PAUSE_MS = 50

export function directTradeCycleWaitPlan({
  cycleStartedAt,
  cycleFinishedAt,
  processingIntervalMs,
}) {
  const startedAt = Number(cycleStartedAt)
  const finishedAt = Number(cycleFinishedAt)
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : 0
  const intervalMs = Math.max(0, Number(processingIntervalMs) || 0)
  const intervalRemainderMs = Math.max(0, intervalMs - elapsedMs)
  return {
    elapsedMs,
    intervalMs,
    intervalRemainderMs,
    postCompletionPauseMs: DIRECT_TRADE_INTER_CYCLE_PAUSE_MS,
    totalWaitMs: intervalRemainderMs + DIRECT_TRADE_INTER_CYCLE_PAUSE_MS,
  }
}

export async function waitForDirectTradeNextCycle({
  cycleStartedAt,
  cycleFinishedAt = Date.now(),
  processingIntervalMs,
  sleep,
}) {
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function")
  const plan = directTradeCycleWaitPlan({
    cycleStartedAt,
    cycleFinishedAt,
    processingIntervalMs,
  })
  if (plan.intervalRemainderMs > 0) await sleep(plan.intervalRemainderMs)
  await sleep(plan.postCompletionPauseMs)
  return plan
}
