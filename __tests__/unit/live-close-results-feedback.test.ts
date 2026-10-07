import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getRedisClient } from "@/lib/redis-db"
import { getLiveSetClosedCounts, clearLiveSetOutcomeCache } from "@/lib/live-set-outcomes"
import { getStrategySetLedgerBatch } from "@/lib/pos-history"
import {
  attributeCloseReasonByOrderId,
  controlCloseSlippagePct,
  getLivePositionSnapshot,
  settleDeferredLiveRow,
} from "@/lib/trade-engine/stages/live-stage"

const liveStageSource = readFileSync(join(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

function closeLivePositionSource(): string {
  const start = liveStageSource.indexOf("export async function closeLivePosition(")
  return liveStageSource.slice(start, liveStageSource.indexOf("\nexport ", start + 10))
}

describe("a close is attributed to the control order that closed it", () => {
  const controls = {
    stopLossOrderId: "sl-1",
    takeProfitOrderId: "tp-1",
    securityStopOrderId: "sec-1",
    stopLossPrice: 99,
    takeProfitPrice: 102,
    securityStopPrice: 97,
  }

  test("the captured ids name the reason and the armed price measures slippage", () => {
    expect(attributeCloseReasonByOrderId({ ...controls, closeOrderId: "sl-1", orderId: "entry" }, "exchange_reconciliation")).toBe("stop_loss")
    expect(attributeCloseReasonByOrderId({ ...controls, closeOrderId: "tp-1", orderId: "entry" }, "unknown")).toBe("take_profit")
    expect(attributeCloseReasonByOrderId({ ...controls, closeOrderId: "sec-1", orderId: "entry" }, "")).toBe("security_stop")
    // A long stop armed at 99 filled at 98.5: 0.5051 % worse than armed.
    expect(controlCloseSlippagePct({ ...controls, direction: "long", closePrice: 98.5, closeReason: "stop_loss" })).toBeCloseTo(0.5051, 4)
  })

  test("closeLivePosition captures ids and armed prices before the terminal reset clears them", () => {
    const fn = closeLivePositionSource()
    const captured = fn.indexOf("const closingControls = {")
    expect(captured).toBeGreaterThan(0)
    // An earlier clear only drops ids of orders the orphan sweep itself just
    // cancelled (never the closing order); the terminal reset is the last one.
    expect(captured).toBeLessThan(fn.lastIndexOf("position.stopLossOrderId = undefined"))
    expect(captured).toBeLessThan(fn.lastIndexOf("position.stopLossPrice = 0"))
    expect(fn).toContain("attributeCloseReasonByOrderId(\n      { ...closingControls, closeOrderId: position.closeOrderId, orderId: position.orderId },")
    expect(fn).toContain("controlCloseSlippagePct({\n        ...closingControls,")
  })

  test("the reconcile (venue-side) close attributes before its reset as well", () => {
    const start = liveStageSource.indexOf("const externalClosingControls = {")
    expect(start).toBeGreaterThan(0)
    const reset = liveStageSource.indexOf("pos.stopLossOrderId = undefined", start)
    expect(reset).toBeGreaterThan(start)
    expect(liveStageSource.indexOf("{ ...externalClosingControls, closeOrderId: pos.closeOrderId, orderId: pos.orderId }", start)).toBeGreaterThan(reset)
  })

  test("minimum-volume results keep their sub-cent precision", () => {
    expect(closeLivePositionSource()).toContain("position.realizedPnL = Math.round(pnl * 1e8) / 1e8")
  })
})

describe("rows read back from Redis carry real accounting booleans", () => {
  test('"true"/"false" strings become booleans', async () => {
    const connectionId = `bool-flags-${Date.now()}`
    await getRedisClient().hset(`live_positions:${connectionId}:p1`, {
      id: "p1",
      connectionId,
      symbol: "BTCUSDT",
      status: "closed",
      realizedPnlComplete: "false",
      entryAccountingComplete: "true",
      pnlAccountingComplete: "false",
      version: "1",
      updatedAt: "1",
    })
    const snapshot = await getLivePositionSnapshot(connectionId, "p1")
    expect(snapshot?.realizedPnlComplete).toBe(false)
    expect(snapshot?.entryAccountingComplete).toBe(true)
    expect((snapshot as any)?.pnlAccountingComplete).toBe(false)
  })
})

describe("a settlement that arrives after the close reaches strategy evaluation", () => {
  async function storeSettledRow(connectionId: string, id: string) {
    await getRedisClient().hset(`live_positions:${connectionId}:${id}`, {
      id,
      connectionId,
      system_tracking_id: `sys-${connectionId}-${id}`,
      connection_tracking_id: `conn-${connectionId}`,
      symbol: "ETHUSDT",
      direction: "short",
      status: "closed",
      executionMode: "live",
      executionIntent: "main",
      orderId: `venue-${id}`,
      executedQuantity: "0.5",
      totalExecutedQuantity: "0.5",
      closedQuantity: "0.5",
      remainingQuantity: "0",
      averageExecutionPrice: "2000",
      entryPrice: "2000",
      realizedPnL: "-1.25",
      realizedPnlComplete: "true",
      pnlAccountingComplete: "true",
      realizedPnlSource: "exchange_settlement_deferred",
      closeAccountingSettledAt: "5",
      createdAt: "1000",
      closedAt: "601000",
      setKey: "ETHUSDT:direction:short#row_real#row_live",
      parentSetKey: "ETHUSDT:direction:short",
      accumulatedSetKeys: "[]",
      version: "3",
      updatedAt: "601000",
    })
  }

  test("books the exchange ring, the general ring and the live loss gate exactly once", async () => {
    const connectionId = `deferred-${Date.now()}`
    const key = "ETHUSDT:direction:short#row_real#row_live"
    await storeSettledRow(connectionId, "p1")
    await expect(settleDeferredLiveRow(connectionId, "p1")).resolves.toEqual({ booked: true, sets: 3 })
    await expect(settleDeferredLiveRow(connectionId, "p1")).resolves.toEqual({ booked: true, sets: 0 })
    clearLiveSetOutcomeCache(connectionId)
    expect((await getLiveSetClosedCounts(connectionId, [key])).get(key)).toBe(1)
    expect((await getStrategySetLedgerBatch(connectionId, [key])).closed[key]).toBe(1)
    const lossGate = await getRedisClient().hgetall(`live:config-outcomes:${connectionId}`)
    expect(Object.keys(lossGate || {})).toHaveLength(1)
  })

  test("an unsettled or paper row books nothing", async () => {
    const connectionId = `deferred-none-${Date.now()}`
    await storeSettledRow(connectionId, "p1")
    await getRedisClient().hset(`live_positions:${connectionId}:p1`, { realizedPnlComplete: "false", realizedPnlSource: "exchange_unresolved" })
    await expect(settleDeferredLiveRow(connectionId, "p1")).resolves.toEqual({ booked: false, sets: 0 })
    await storeSettledRow(connectionId, "p2")
    await getRedisClient().hset(`live_positions:${connectionId}:p2`, { executionMode: "simulation" })
    await expect(settleDeferredLiveRow(connectionId, "p2")).resolves.toEqual({ booked: false, sets: 0 })
  })
})
