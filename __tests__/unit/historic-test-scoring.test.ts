import {
  combinationKeyOf,
  historicTestValidatedKey,
  profitFactorToPositionCosts,
  scoreHistoricCombination,
  selectValidatedCombinations,
  summarizeHistoricScores,
  type HistoricTestCombinationScore,
} from "@/lib/historic-test-scoring"

const key = { symbol: "btcusdt", indication: "Momentum", family: "block" as const }
const trade = (r: number, holdMin = 10) => ({ signedResultR: r, openedAt: 1_000_000, closedAt: 1_000_000 + holdMin * 60_000 })

describe("Historic Test scoring is per combination and on the system PF coordinate", () => {
  test("PF is PositionCost-relative: 1.00 neutral, +1 average result is 1.10", () => {
    expect(scoreHistoricCombination(key, [trade(0)], 1).profitFactor).toBe(1)
    expect(scoreHistoricCombination(key, [trade(1), trade(1)], 1).profitFactor).toBeCloseTo(1.1, 10)
    expect(scoreHistoricCombination(key, [trade(3)], 1).profitFactor).toBeCloseTo(1.3, 10)
    expect(scoreHistoricCombination(key, [trade(-2)], 1).profitFactor).toBeCloseTo(0.8, 10)
    expect(profitFactorToPositionCosts(1.2)).toBeCloseTo(2, 10)
  })

  test("a combination must be positive before the threshold is even considered", () => {
    // Negative net result: rejected regardless of any favourable ratio.
    const negative = scoreHistoricCombination(key, [trade(-4), trade(1)], 1.0)
    expect(negative.positive).toBe(false)
    expect(negative.valid).toBe(false)
    expect(negative.rejectedReason).toBe("not_positive")
    // Positive but below the operator minimum.
    const weak = scoreHistoricCombination(key, [trade(1), trade(0)], 1.2)
    expect(weak.positive).toBe(true)
    expect(weak.profitFactor).toBeCloseTo(1.05, 10)
    expect(weak.valid).toBe(false)
    expect(weak.rejectedReason).toBe("below_min_profit_factor")
    // Positive and at the threshold.
    const strong = scoreHistoricCombination(key, [trade(2), trade(2)], 1.2)
    expect(strong.valid).toBe(true)
    expect(strong.rejectedReason).toBeNull()
  })

  test("an empty combination is never validated", () => {
    const empty = scoreHistoricCombination(key, [], 1.2)
    expect(empty).toMatchObject({ trades: 0, valid: false, positive: false, rejectedReason: "no_trades", profitFactor: 1 })
  })

  test("drawdown time is measured over losing trades only", () => {
    const score = scoreHistoricCombination(key, [trade(2, 5), trade(-1, 30), trade(-1, 90)], 1)
    expect(score.wins).toBe(1)
    expect(score.losses).toBe(2)
    expect(score.averageDrawdownTimeMin).toBeCloseTo(60, 6)
    expect(score.maxDrawdownTimeMin).toBeCloseTo(90, 6)
  })

  test("selection keeps only validated combinations and keys are normalized", () => {
    const scores = [
      scoreHistoricCombination(key, [trade(3), trade(3)], 1.2),
      scoreHistoricCombination({ ...key, symbol: "ETHUSDT" }, [trade(-1)], 1.2),
    ]
    const kept = selectValidatedCombinations(scores)
    expect(kept).toHaveLength(1)
    expect(kept[0].symbol).toBe("BTCUSDT")
    expect(kept[0].indication).toBe("momentum")
    expect(combinationKeyOf(key)).toBe("BTCUSDT|momentum|block")
    expect(historicTestValidatedKey("bingx-x02")).toBe("historic_test:validated:bingx-x02")
  })

  test("family summaries are trade-weighted and include an overall row", () => {
    const scores: HistoricTestCombinationScore[] = [
      scoreHistoricCombination({ symbol: "A", indication: "i", family: "block" }, [trade(2), trade(2)], 1.2),
      scoreHistoricCombination({ symbol: "B", indication: "i", family: "block" }, [trade(-1)], 1.2),
      scoreHistoricCombination({ symbol: "C", indication: "i", family: "dca" }, [trade(1)], 1.2),
    ]
    const rows = summarizeHistoricScores(scores, ["block", "dca"])
    const block = rows.find((r) => r.family === "block")!
    expect(block.combinations).toBe(2)
    expect(block.validCombinations).toBe(1)
    expect(block.trades).toBe(3)
    // Trade-weighted: (2 + 2 - 1) / 3 = 1 PositionCost -> 1.10
    expect(block.profitFactor).toBeCloseTo(1.1, 10)
    const overall = rows.find((r) => r.family === "overall")!
    expect(overall.trades).toBe(4)
    expect(overall.combinations).toBe(3)
    // A family with no scored combination reports the neutral coordinate.
    expect(summarizeHistoricScores([], ["normal"])[0]).toMatchObject({ family: "normal", trades: 0, profitFactor: 1 })
  })
})
