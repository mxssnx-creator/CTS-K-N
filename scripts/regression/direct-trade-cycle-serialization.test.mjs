import assert from "node:assert/strict"
import {
  DIRECT_TRADE_INTER_CYCLE_PAUSE_MS,
  directTradeCycleWaitPlan,
  waitForDirectTradeNextCycle,
} from "../direct-trade-cycle-scheduler.mjs"

assert.equal(DIRECT_TRADE_INTER_CYCLE_PAUSE_MS, 50)
assert.deepEqual(
  directTradeCycleWaitPlan({
    cycleStartedAt: 1_000,
    cycleFinishedAt: 1_180,
    processingIntervalMs: 280,
  }),
  {
    elapsedMs: 180,
    intervalMs: 280,
    intervalRemainderMs: 100,
    postCompletionPauseMs: 50,
    totalWaitMs: 150,
  },
)
assert.deepEqual(
  directTradeCycleWaitPlan({
    cycleStartedAt: 1_000,
    cycleFinishedAt: 1_450,
    processingIntervalMs: 280,
  }),
  {
    elapsedMs: 450,
    intervalMs: 280,
    intervalRemainderMs: 0,
    postCompletionPauseMs: 50,
    totalWaitMs: 50,
  },
)

const sleeps = []
await waitForDirectTradeNextCycle({
  cycleStartedAt: 2_000,
  cycleFinishedAt: 2_120,
  processingIntervalMs: 280,
  sleep: async (ms) => { sleeps.push(ms) },
})
assert.deepEqual(sleeps, [160, 50])

let activeCycles = 0
let maxActiveCycles = 0
const orderedEvents = []
const runSerializedCycle = async (id) => {
  const cycleStartedAt = Date.now()
  activeCycles++
  maxActiveCycles = Math.max(maxActiveCycles, activeCycles)
  orderedEvents.push(`start:${id}`)
  await new Promise((resolve) => setTimeout(resolve, 5))
  orderedEvents.push(`finish:${id}`)
  activeCycles--
  await waitForDirectTradeNextCycle({
    cycleStartedAt,
    cycleFinishedAt: Date.now(),
    processingIntervalMs: 0,
    sleep: async (ms) => {
      orderedEvents.push(`wait:${id}:${ms}`)
    },
  })
}

for (const id of [1, 2, 3]) await runSerializedCycle(id)
assert.equal(maxActiveCycles, 1)
assert.deepEqual(orderedEvents, [
  "start:1", "finish:1", "wait:1:50",
  "start:2", "finish:2", "wait:2:50",
  "start:3", "finish:3", "wait:3:50",
])

console.log("direct-trade serialized cycle pause regression passed")
