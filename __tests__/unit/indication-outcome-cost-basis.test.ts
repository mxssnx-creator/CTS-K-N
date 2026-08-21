import fs from "node:fs"
import path from "node:path"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

describe("indication outcome PositionCost basis", () => {
  test("maps realized outcomes with one gross cost as neutral", () => {
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.trendPositionCostPct = 0.1

    // Outcome aggregates are stored as decimal returns, so 0.001 = 0.10%.
    expect(processor.outcomePerformanceFromStats(0.001, 0, 1).positionCostRatio)
      .toBeCloseTo(1, 12)
    expect(processor.outcomePerformanceFromStats(0.002, 0, 1).positionCostRatio)
      .toBeCloseTo(1.1, 12)
  })

  test("keeps execution-net PnL separate from the one-cost stage coordinate", () => {
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.trendPositionCostPct = 0.1
    const sample = processor.createOutcomeSample({
      grossMoveFraction: 0.002, // +0.20% gross market move
      netPnlPct: -0.06, // accounting result may include separate venue fees
      costPct: 0.26,
    })

    expect(sample).toMatchObject({
      basis: "gross_market_move_v2",
      profit: 0.002,
      loss: 0,
      netPnlPct: -0.06,
    })
    // The stage consumes 0.20% gross and deducts its configured 0.10%
    // PositionCost exactly once, independently of the accounting fee field.
    expect(processor.outcomePerformanceFromStats(sample.profit, sample.loss, 1).positionCostRatio)
      .toBeCloseTo(1.1, 12)
  })

  test("keeps the atomic Lua update on the same net-cost mapping", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/indication-sets-processor.ts"),
      "utf8",
    )
    expect(source).toContain("local netMovePct = averageMovePct - positionCostPct")
    expect(source).toContain("1 + (netMovePct / positionCostPct) * 0.1")
    expect(source).toContain('const OUTCOME_SAMPLE_BASIS = "gross_market_move_v2"')
    expect(source).toContain("local basis = ARGV[5] or \"\"")
  })
})
