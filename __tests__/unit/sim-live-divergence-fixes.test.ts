import { readFileSync } from "node:fs"
import path from "node:path"

const mockListPositions = jest.fn(async () => [])
jest.mock("@/lib/redis-db", () => ({
  ...jest.requireActual("@/lib/redis-db"),
  getRedisClient: jest.fn(() => { throw new Error("no Redis access expected") }),
  getAppSettings: jest.fn(async () => ({})),
}))

import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import { deriveAdaptiveTrendProtection } from "@/lib/strategy-coordinator"

/**
 * Divergences between the measurement, the pseudo (paper) path and live
 * execution that made simulated PF differ from what the exchange delivers
 * (docs/reports/20261007-sim-vs-live/differences.md).
 */
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("bounded simulation lifecycle", () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env } })

  test("never books coin-flip closes outside a forced simulation", async () => {
    process.env.FORCE_SIMULATED = "0"
    const manager = new PseudoPositionManager("paper-real-data")
    ;(manager as any).listPositions = mockListPositions
    await expect(manager.enforceSimBoundedLifecycle("BTCUSDT", { maxOpenPerSymbol: 1 }))
      .resolves.toEqual({ closed: 0, wins: 0, losses: 0 })
    expect(mockListPositions).not.toHaveBeenCalled()
  })

  test("in a forced simulation the decided level is the booked exit price", async () => {
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"
    const manager = new PseudoPositionManager("forced-sim")
    const old = { id: "a", opened_at: "2026-01-01T00:00:00Z", entry_price: "100", side: "long", direction: "long", profit_factor: "1", takeprofit_price: "101", stoploss_price: "99" }
    ;(manager as any).listPositions = jest.fn(async () => [old, { ...old, id: "b", opened_at: new Date().toISOString() }])
    const close = jest.fn(async () => undefined)
    ;(manager as any).closePosition = close
    await manager.enforceSimBoundedLifecycle("BTCUSDT", { maxOpenPerSymbol: 1 })
    expect(close).toHaveBeenCalledTimes(1)
    const [, reason, , exitPrice] = close.mock.calls[0] as any[]
    expect(exitPrice).toBe(reason === "sim_tp_hit" ? 101 : 99)
  })

  test("closePosition uses an explicit exit price over the stored mark", () => {
    expect(source("lib/trade-engine/pseudo-position-manager.ts"))
      .toContain("const currentPrice = Number(exitPrice) > 0 ? Number(exitPrice) : parseFloat(position.current_price || \"0\")")
  })
})

describe("adaptive Trend take profit", () => {
  test("the ladder holds PositionCost multiples: factor 6 at 0.10 % is a 0.60 % target, not 6 %", () => {
    const protection = deriveAdaptiveTrendProtection([8, 6, 10], 0.1)!
    expect(protection.takeProfitPct).toBeCloseTo(0.6, 9)
    expect(protection.stopLossPct).toBeGreaterThanOrEqual(0.2)
  })

  test("no ladder means no adaptive protection", () => {
    expect(deriveAdaptiveTrendProtection(undefined, 0.1)).toBeNull()
    expect(deriveAdaptiveTrendProtection([0, -1, Number.NaN], 0.1)).toBeNull()
  })

  test("pseudo creation, live dispatch and the measurement use the same conversion", () => {
    const coordinator = source("lib/strategy-coordinator.ts")
    expect(coordinator).toContain("deriveAdaptiveTrendProtection(bestEntry.adaptiveTpFactors, livePositionCostPct)?.takeProfitPct")
    expect(coordinator).toContain("deriveAdaptiveTrendProtection(bestEntry.adaptiveTpFactors, livePositionCostPct, effectiveSizeMult)")
    expect(coordinator).not.toMatch(/adaptiveTpFactors\?\.find\(/)
    expect(source("lib/trade-engine/type-measurement.ts"))
      .toContain("deriveAdaptiveTrendProtection(row?.metadata?.adaptiveTpRange?.factors, context.positionCostPct)")
  })
})

describe("historic Common Sets", () => {
  const processor = source("lib/indication-sets-processor.ts")
  const common = processor.slice(processor.indexOf("private async processCommonSet"), processor.indexOf("private async processCommonSet") + 1500)

  test("compute indicators on the causal history, never the forward grading window", () => {
    expect(common).toContain("let candles = this.getHistoryCandles(marketData)")
    expect(common).not.toContain("this.getForwardCandles(marketData)")
    expect(processor).toContain("(!Number.isFinite(asOfMs) || candle.timestamp <= asOfMs))")
  })

  test("grade a bar touching both levels as a stop", () => {
    const grading = processor.slice(processor.indexOf("private evaluateForwardOutcome"))
    expect(grading.indexOf('direction === "long" && low <= sl')).toBeLessThan(grading.indexOf('direction === "long" && high >= tp'))
    expect(grading.indexOf('direction === "short" && high >= sl')).toBeLessThan(grading.indexOf('direction === "short" && low <= tp'))
  })
})
