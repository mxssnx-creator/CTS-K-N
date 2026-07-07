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
process.exit(0)
