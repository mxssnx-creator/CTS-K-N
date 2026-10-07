import { readFileSync } from "node:fs"
import path from "node:path"
import { derivePosWindowStats, type PosWindowStats } from "@/lib/pos-history"
import { axisPreviousWindowRatio, materializeContinuousStageRows, type StrategySet } from "@/lib/strategy-coordinator"
import { blockLegOutcomes } from "@/lib/live-set-outcomes"

/**
 * Stage and Block/Axis defects found by the stage audit (2026-10-07). Each
 * changed what a stage admitted or what a Set's PF meant.
 */
const coordinator = readFileSync(path.join(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

describe("Main and Real carry the measured PF", () => {
  test("variant Sets scale the Base Set's measured PF, not each entry's indication estimate", () => {
    const build = coordinator.slice(coordinator.indexOf("const measuredBasePf"))
    expect(build).toContain("scaleMainTradePfCoordinate(Number.isFinite(measuredBasePf) ? measuredBasePf : baseEntry.profitFactor, cfg.pfBias)")
  })

  test("a full history window is never 'insufficient' for Main", () => {
    expect(coordinator).toContain("if (hasHistoricData && histCount < mainMinPos && !historyWindowFull) {")
    expect(coordinator).toContain("hasSignal: (posStats as { hasSignal?: boolean }).hasSignal === true,")
  })
})

describe("drawdown time", () => {
  test("closes without drawdown count with 0 in the average", () => {
    const records = [...Array.from({ length: 9 }, () => "0.1|0|0|0.1|0.1"), "-0.2|0|120|-0.2|0.1"]
    expect(derivePosWindowStats(records, 10).avgDDT).toBeCloseTo(12, 12)
  })
})

function sourceSet(): StrategySet {
  return {
    setKey: "BTCUSDT:direction:long", indicationType: "direction", direction: "long",
    avgProfitFactor: 1.5, avgConfidence: 0.9, avgDrawdownTime: 10, entryCount: 3,
    entries: [{ id: "e", sizeMultiplier: 1, leverage: 1, positionState: "new", profitFactor: 1.5, drawdownTime: 10, confidence: 0.9 }],
    createdAt: new Date(0).toISOString(),
  } as StrategySet
}
const windowOf = (pnlPcts: number[]): PosWindowStats => derivePosWindowStats(pnlPcts.map((p) => `${p}|0|5|${p}|0.1`), pnlPcts.length)

describe("row windows need enough samples", () => {
  test("one live close does not override a long source history", () => {
    const result = materializeContinuousStageRows([sourceSet()], {
      stage: "real",
      lookback: 25,
      metrics: { minProfitFactor: 1.1, maxDrawdownTime: 240 },
      windowBySetKey: new Map([
        ["BTCUSDT:direction:long#row_real#row_live", windowOf([-1])],
        ["BTCUSDT:direction:long", windowOf(Array.from({ length: 25 }, () => 0.5))],
      ]),
    })
    // Source ratio 1 + 0.5/0.1×0.1 = 1.5 passes; the single −1 % close (ratio 0) is not the judge.
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].avgProfitFactor).toBeCloseTo(1.5, 12)
  })
})

describe("Axis previous window", () => {
  test("a prev=4 Set is judged on its newest 4 closes", () => {
    // Newest-first: four winners, then eight losers.
    const window = windowOf([0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5])
    expect(axisPreviousWindowRatio(window, 4)).toBeCloseTo(1.5, 12)
    expect(axisPreviousWindowRatio(window, 12)).toBeCloseTo((4 * 1.5 + 8 * 0.5) / 12, 12)
  })
})

describe("Block legs book their own result", () => {
  test("a leg that made +1 % inside a losing position is booked as +1 % minus its fee share", () => {
    const legs = blockLegOutcomes({
      direction: "long", closePrice: 99, totalExecutedQuantity: 2, tradingFees: 0,
      blockLegs: [{ setKey: "S#block:1", lifecycleKey: "S#block:1", entryPrice: 98, quantity: 1 }],
    } as any)
    expect(legs.get("S#block:1")!.pnlPct).toBeCloseTo((1 / 98) * 100, 9)
  })

  test("fees are shared by quantity", () => {
    const legs = blockLegOutcomes({
      direction: "short", closePrice: 100, totalExecutedQuantity: 4, tradingFees: 0.4,
      blockLegs: [{ setKey: "S#block:2", entryPrice: 101, quantity: 1 }],
    } as any)
    expect(legs.get("S#block:2")!.pnl).toBeCloseTo(1 - 0.1, 12)
  })
})

describe("PositionCost ratio, never classic PF, in Block decisions", () => {
  test("no classic-PF fallback remains in Block observed PF", () => {
    expect(coordinator).not.toMatch(/: (ownWindow|laneWindow)\?\.profitFactor,/)
  })
})
