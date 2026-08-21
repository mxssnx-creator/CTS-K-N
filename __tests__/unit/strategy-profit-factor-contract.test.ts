import { StrategyEngine } from "@/lib/strategies"

const config = {
  takeprofit_factor: 5,
  stoploss_ratio: 1,
  trailing_enabled: false,
  last_positions_count: 8,
  main_positions_count: 3,
  volume_factor: 1,
}

function pseudo(overrides: Record<string, unknown> = {}) {
  return {
    id: "pseudo-1",
    connection_id: "conn-1",
    symbol: "BTCUSDT",
    indication_type: "direction",
    takeprofit_factor: 5,
    stoploss_ratio: 1,
    trailing_enabled: false,
    entry_price: 100,
    current_price: 100,
    profit_factor: 0,
    position_cost: 0.1,
    status: "closed",
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:01:00.000Z",
    ...overrides,
  }
}

describe("legacy pseudo Result-R / Main-stage PF contract", () => {
  test("keeps a positive Result-R below one positive while emitting the correct PF coordinate", () => {
    const engine = new StrategyEngine()
    const strategy = engine.calculateBaseStrategy([pseudo({ profit_factor: 0.6 })] as any, config)

    // `0.6 R` is a gain, not a loss.  The stage coordinate is 1 + 0.6×0.1.
    expect(strategy.avg_signed_result_r).toBeCloseTo(0.6, 12)
    expect(strategy.avg_profit_factor).toBeCloseTo(1.06, 12)
    expect(strategy.stats.win_rate).toBe(1)
    expect(strategy.validation_state).toBe("invalid")
  })

  test("uses the explicit signed result for DCA instead of a display PF coordinate", () => {
    const engine = new StrategyEngine()
    const strategy = engine.calculateBaseStrategy(
      [pseudo({ profit_factor: 1.6, signedResultR: -0.2 })] as any,
      { ...config, adjustments: { dca: { enabled: true, levels: 3 } } },
    )

    expect(strategy.avg_signed_result_r).toBeCloseTo(-0.2, 12)
    expect(strategy.avg_profit_factor).toBeCloseTo(0.98, 12)
    expect(strategy.stats.win_rate).toBe(0)
    expect(strategy.volume_factor).toBeCloseTo(2, 12)
  })
})
