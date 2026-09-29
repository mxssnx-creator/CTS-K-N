import { normalizeProtectionPercentages } from "@/lib/trade-protection-contract"
import { attributeCloseReasonByOrderId, controlCloseSlippagePct } from "@/lib/trade-engine/stages/live-stage"

describe("the executed bracket keeps the Set's reward/risk", () => {
  test("the production case: requested TP 0.2 / SL 0.2 with a 0.5 floor -> TP 0.5, SL 0.5 (was TP 0.333)", () => {
    const p = normalizeProtectionPercentages({ takeProfitPct: 0.2, stopLossPct: 0.2, minimumTakeProfitPct: 0.2, minimumStopLossPct: 0.5, maxStopLossToTakeProfitRatio: 1.5 })
    expect(p.stopLossPct).toBe(0.5)
    expect(p.takeProfitPct).toBe(0.5)
  })
  test("a floored stop scales the target by the same factor: TP 0.4 / SL 0.2, floor 0.5 -> TP 1.0", () => {
    const p = normalizeProtectionPercentages({ takeProfitPct: 0.4, stopLossPct: 0.2, minimumStopLossPct: 0.5 })
    expect(p.stopLossPct).toBe(0.5)
    expect(p.takeProfitPct).toBe(1)
  })
  test("a bracket that already satisfies both rules is unchanged", () => {
    const p = normalizeProtectionPercentages({ takeProfitPct: 1.2, stopLossPct: 0.8, minimumStopLossPct: 0.5 })
    expect(p).toMatchObject({ takeProfitPct: 1.2, stopLossPct: 0.8 })
  })
  test("a capped (lowered) stop leaves the target alone: the 1.5x cap and wide-stop Sets are unchanged", () => {
    const p = normalizeProtectionPercentages({ takeProfitPct: 0.5, stopLossPct: 2.0, minimumStopLossPct: 0.5, maxStopLossToTakeProfitRatio: 1.5 })
    expect(p).toMatchObject({ stopLossPct: 0.75, takeProfitPct: 0.5 })
  })
})

describe("a close through an own control order is attributed by its id", () => {
  const row = { orderId: "E", stopLossOrderId: "S1", takeProfitOrderId: "T1", securityStopOrderId: "X1" }
  test("stop, target and security stop", () => {
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "S1" }, "exchange_reconciliation")).toBe("stop_loss")
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "T1" }, "exchange_reconciliation")).toBe("take_profit")
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "X1" }, "exchange_externally_closed")).toBe("security_stop")
  })
  test("an explicit reason and a close by an unknown order stay as they are", () => {
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "S1" }, "manual")).toBe("manual")
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "Z9" }, "exchange_reconciliation")).toBe("exchange_reconciliation")
    expect(attributeCloseReasonByOrderId({ ...row, closeOrderId: "" }, "exchange_reconciliation")).toBe("exchange_reconciliation")
  })
  test("slippage: a long stop armed at 100 filled at 99 is 1 % worse; a fill at the price is 0; a target fill better is negative", () => {
    expect(controlCloseSlippagePct({ direction: "long", stopLossPrice: 100, closePrice: 99, closeReason: "stop_loss" })).toBe(1)
    expect(controlCloseSlippagePct({ direction: "short", stopLossPrice: 100, closePrice: 102.5, closeReason: "stop_loss" })).toBe(2.5)
    expect(controlCloseSlippagePct({ direction: "long", takeProfitPrice: 100, closePrice: 100.2, closeReason: "take_profit" })).toBe(-0.2)
    expect(controlCloseSlippagePct({ direction: "long", stopLossPrice: 100, closePrice: 99, closeReason: "manual" })).toBeNull()
  })
})
