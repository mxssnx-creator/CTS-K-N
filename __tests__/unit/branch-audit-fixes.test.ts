/**
 * Regression tests for issues found in the adversarial audit of the
 * ownership / margin-control / ordering / synthetic-market branch.
 */
jest.mock("@/lib/exchange-connectors/factory", () => ({
  ExchangeConnectorFactory: { getConnector: jest.fn(() => ({ id: "connector" })) },
}))
jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: jest.fn(),
  closeLivePosition: jest.fn(),
}))

import { ExchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getLivePositions, closeLivePosition } from "@/lib/trade-engine/stages/live-stage"
import { TradeExecutionOrchestrator } from "@/lib/trade-execution-orchestrator"
import { compareStrategySetsBestFirst } from "@/lib/strategy-coordinator"
import { marginCallGloballyEnabled } from "@/lib/margin-call-policy"
import { extendSyntheticCandles, generateSyntheticCandles } from "@/lib/market-data-loader"

describe("branch audit fixes", () => {
  test("best-first comparator keeps a +Infinity PF first; only NaN/undefined sort last", () => {
    const rows = [
      { setKey: "nan", avgProfitFactor: Number.NaN },
      { setKey: "two", avgProfitFactor: 2 },
      { setKey: "inf", avgProfitFactor: Number.POSITIVE_INFINITY },
      { setKey: "undef", avgProfitFactor: undefined as any },
    ]
    expect(rows.sort(compareStrategySetsBestFirst).map((r) => r.setKey)).toEqual(["inf", "two", "nan", "undef"])
  })

  test("system-wide margin control master only turns on for an explicit on value", () => {
    for (const on of ["1", 1, true, "true", "on", " YES "]) expect(marginCallGloballyEnabled(on)).toBe(true)
    for (const off of [undefined, null, "", "0", 0, false, "off", "garbage", "2", {}]) {
      expect(marginCallGloballyEnabled(off)).toBe(false)
    }
  })

  test("close-all signal reports failure when an owned row is not confirmed closed", async () => {
    ;(getLivePositions as jest.Mock).mockResolvedValue([
      { id: "a", symbol: "BCHUSDT", status: "open", entryPrice: 1 },
      { id: "b", symbol: "BCHUSDT", status: "open", entryPrice: 1 },
    ])
    ;(closeLivePosition as jest.Mock)
      .mockResolvedValueOnce({ status: "closed" })
      .mockResolvedValueOnce({ status: "closing" })
    const orchestrator = new TradeExecutionOrchestrator() as any
    const partial = await orchestrator.executeCloseAllSignal("bingx-x02")
    expect(partial.success).toBe(false)
    expect(partial.error).toContain("1/2")

    ;(closeLivePosition as jest.Mock).mockResolvedValue({ status: "closed" })
    const full = await orchestrator.executeCloseAllSignal("bingx-x02")
    expect(full.success).toBe(true)
    expect(ExchangeConnectorFactory.getConnector).toHaveBeenCalledWith("bingx-x02")
  })

  test("synthetic continuation after a gap longer than the window still ends at now", () => {
    const now = Date.now()
    const seed = generateSyntheticCandles("BCHUSDT", 100, 50, 1_000).map((candle, index) => ({
      ...candle,
      timestamp: now - 3_600_000 - (50 - index) * 1_000,
    }))
    const extended = extendSyntheticCandles("BCHUSDT", seed, 1_000, 300, now)
    const tail = Number(extended[extended.length - 1].timestamp)
    expect(tail).toBeLessThanOrEqual(now)
    expect(now - tail).toBeLessThan(1_000)
    for (let index = 1; index < extended.length; index++) {
      expect(Number(extended[index].timestamp)).toBeGreaterThan(Number(extended[index - 1].timestamp))
    }
  })
})
