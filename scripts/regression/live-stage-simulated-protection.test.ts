import assert from "node:assert/strict"
import { __liveStageTest } from "../../lib/trade-engine/stages/live-stage"

function simulatedPosition(direction: "long" | "short") {
  const entry = 100
  const pos = {
    id: `test-${direction}`,
    connectionId: "test-conn",
    symbol: "BTCUSDT",
    direction,
    entryPrice: entry,
    averageExecutionPrice: entry,
    executedQuantity: 1,
    quantity: 1,
    remainingQuantity: 0,
    leverage: 1,
    marginType: "cross" as const,
    fills: [],
    status: "simulated" as const,
    stopLoss: 2,
    takeProfit: 3,
    assignedStopLoss: 2,
    assignedTakeProfit: 3,
  }
  const protection = __liveStageTest.computeDesiredProtectionPrices(pos)
  return {
    ...pos,
    stopLossPrice: protection.desiredSl,
    takeProfitPrice: protection.desiredTp,
    desiredStopLossPrice: protection.desiredSl,
    desiredTakeProfitPrice: protection.desiredTp,
  }
}

const long = simulatedPosition("long")
assert.equal(long.assignedStopLoss, 2)
assert.equal(long.assignedTakeProfit, 3)
assert.equal(long.stopLossPrice, 98)
assert.equal(long.takeProfitPrice, 103)
assert.equal(__liveStageTest.detectSltpCross(long, 98, long.stopLossPrice, long.takeProfitPrice), "sl_hit")
assert.equal(__liveStageTest.detectSltpCross(long, 103, long.stopLossPrice, long.takeProfitPrice), "tp_hit")

const short = simulatedPosition("short")
assert.equal(short.assignedStopLoss, 2)
assert.equal(short.assignedTakeProfit, 3)
assert.equal(short.stopLossPrice, 102)
assert.equal(short.takeProfitPrice, 97)
assert.equal(__liveStageTest.detectSltpCross(short, 102, short.stopLossPrice, short.takeProfitPrice), "sl_hit")
assert.equal(__liveStageTest.detectSltpCross(short, 97, short.stopLossPrice, short.takeProfitPrice), "tp_hit")

const staleAssignedLong = { ...long, assignedStopLoss: 999, assignedTakeProfit: 999 }
assert.deepEqual(__liveStageTest.readAbsoluteProtectionPrices(staleAssignedLong), {
  desiredSl: 98,
  desiredTp: 103,
})
assert.equal(
  __liveStageTest.detectSltpCross(
    staleAssignedLong,
    98,
    staleAssignedLong.stopLossPrice,
    staleAssignedLong.takeProfitPrice,
  ),
  "sl_hit",
)

console.log("simulated live-stage protection regression passed")

class InMemoryLockRedis {
  private entries = new Map<string, { value: string; expiresAt: number | null }>()

  async set(key: string, value: string, options?: { PX?: number; EX?: number; NX?: boolean }) {
    this.purgeExpired(key)
    if (options?.NX && this.entries.has(key)) return null
    const ttlMs = options?.PX ?? (options?.EX ? options.EX * 1000 : null)
    this.entries.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
    return "OK"
  }

  async get(key: string) {
    this.purgeExpired(key)
    return this.entries.get(key)?.value ?? null
  }

  async pexpire(key: string, ttlMs: number) {
    this.purgeExpired(key)
    const entry = this.entries.get(key)
    if (!entry) return 0
    entry.expiresAt = Date.now() + ttlMs
    return 1
  }

  async del(key: string) {
    this.purgeExpired(key)
    return this.entries.delete(key) ? 1 : 0
  }

  private purgeExpired(key: string) {
    const entry = this.entries.get(key)
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) this.entries.delete(key)
  }
}

async function runLockTokenRegression() {
  const redis = new InMemoryLockRedis()
  const lockKey = "live:lock:test-conn:BTCUSDT:long"
  const workerAToken = "worker-a-token"
  const workerBToken = "worker-b-token"

  assert.equal(await redis.set(lockKey, workerAToken, { PX: 5, NX: true }), "OK")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(await redis.set(lockKey, workerBToken, { PX: 1000, NX: true }), "OK")
  assert.equal(await __liveStageTest.releaseLockWithClient(redis, lockKey, workerAToken), false)
  assert.equal(await redis.get(lockKey), workerBToken)
  assert.equal(await __liveStageTest.refreshLockTTLWithClient(redis, lockKey, workerAToken, 1000), false)
  assert.equal(await redis.get(lockKey), workerBToken)
  assert.equal(await __liveStageTest.releaseLockWithClient(redis, lockKey, workerBToken), true)
  assert.equal(await redis.get(lockKey), null)

  console.log("live-order lock token regression passed")
}

runLockTokenRegression()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
