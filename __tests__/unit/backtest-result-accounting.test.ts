jest.mock("@/lib/redis-db", () => ({
  getSettings: jest.fn(),
  setSettings: jest.fn(),
}))

jest.mock("@/lib/db", () => ({ sql: jest.fn() }))

import { BacktestEngine } from "@/lib/backtest-engine"

const makeTrade = (overrides: Record<string, unknown> = {}) => ({
  symbol: "BTCUSDT",
  side: "long",
  entry_price: 100,
  exit_price: 100,
  entry_time: new Date("2026-08-21T00:00:00.000Z"),
  exit_time: new Date("2026-08-21T01:00:00.000Z"),
  profit_loss: 0,
  gross_profit_loss: 0,
  position_cost: 10,
  signedResultR: 0,
  profit_factor: 0,
  signed_result_r: 0,
  profit_factor_kind: "signed_result_r",
  strategy_config: {},
  ...overrides,
})

describe("backtest net-result accounting", () => {
  test("keeps flat results neutral, excludes them from classic PF decisions, and never emits NaN", () => {
    const engine = new BacktestEngine("preset", "conn", new Date(0), new Date(1), [])
    const metrics = (engine as any).calculateMetrics([
      makeTrade({ profit_loss: 10, signedResultR: 1 }),
      makeTrade({ profit_loss: 0, signedResultR: 0 }),
      makeTrade({ profit_loss: -5, signedResultR: -0.5 }),
    ])

    expect(metrics).toMatchObject({
      totalTrades: 3,
      winningTrades: 1,
      losingTrades: 1,
      flatTrades: 1,
      winRate: 50,
      profitFactor: 2,
    })

    const empty = (engine as any).calculateMetrics([])
    expect(Number.isFinite(empty.sharpeRatio)).toBe(true)
    expect(Number.isFinite(empty.sortinoRatio)).toBe(true)
  })

  test("retains a negative simulated Result-R and reports finite drawdown from zero equity", () => {
    const engine = new BacktestEngine("preset", "conn", new Date(0), new Date(1), [])
    const trade = (engine as any).simulateTrade(
      "BTCUSDT",
      [
        { price: 100, timestamp: "2026-08-21T00:00:00.000Z" },
        { price: 100, timestamp: "2026-08-21T00:01:00.000Z" },
      ],
      0,
      { takeprofit_factor: 5, stoploss_ratio: 1, trailing_enabled: false, position_timeout_hours: 1 },
    )

    expect(trade.profit_factor_kind).toBe("signed_result_r")
    expect(trade.profit_factor).toBeLessThan(0)

    const drawdown = (engine as any).calculateDrawdown([
      makeTrade({ profit_loss: -5, position_cost: 5 }),
    ])
    expect(drawdown.maxDrawdown).toBe(100)
    expect(Number.isFinite(drawdown.avgDrawdown)).toBe(true)
  })

  test("uses the same PositionCost TP/SL coordinate as the preset and direct engines", () => {
    const engine = new BacktestEngine("preset", "conn", new Date(0), new Date(1), [])
    const trade = (engine as any).simulateTrade(
      "BTCUSDT",
      [
        { price: 100, timestamp: "2026-08-21T00:00:00.000Z" },
        { price: 100.5, timestamp: "2026-08-21T00:01:00.000Z" },
      ],
      0,
      {
        // 5 × 0.10% is a 0.50% gross TP, not a literal 5% target.
        takeprofit_factor: 5,
        stoploss_ratio: 1,
        position_cost: 0.1,
        trailing_enabled: false,
        position_timeout_hours: 1,
      },
    )

    expect(trade.side).toBe("long")
    expect(trade.exit_price).toBeCloseTo(100.5, 12)
    expect(trade.profit_loss).toBeCloseTo(0.4, 12)
  })
})
