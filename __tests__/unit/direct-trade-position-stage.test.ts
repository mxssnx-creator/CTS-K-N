import { buildDirectTradeOpenPositionStage } from "@/lib/direct-trade-position-stage"

describe("Direct-Trade open position stage", () => {
  test("indexes only open rows and keeps them outside realised evaluation", () => {
    const stage = buildDirectTradeOpenPositionStage([
      {
        id: "open-long",
        status: "open",
        symbol: "BTCUSDT",
        direction: "long",
        strategyType: "combination",
        timeframe: "1m+10m",
        configKey: "cfg-long",
        openedAt: "2026-08-02T00:00:00.000Z",
        entryPrice: 100,
        lastObservedPrice: 101,
        positionCostPercent: 0.1,
        trailingArmed: true,
        exitTactic: "relative",
      },
      {
        id: "closed-short",
        status: "closed",
        symbol: "ETHUSDT",
        direction: "short",
        configKey: "cfg-short",
        entryPrice: 100,
        lastObservedPrice: 99,
      },
    ], "2026-08-02T01:00:00.000Z")

    expect(stage).toMatchObject({
      version: 1,
      updatedAt: "2026-08-02T01:00:00.000Z",
      counts: { total: 1, long: 1, short: 0, byStrategyType: { combination: 1 } },
      rowIdsByConfigKey: { "cfg-long": ["open-long"] },
      rowIdsBySymbol: { BTCUSDT: ["open-long"] },
    })
    expect(stage.rows).toEqual([expect.objectContaining({
      id: "open-long",
      stage: "open_position_management",
      evaluationIncluded: false,
      // 1% gross movement minus the one-time 0.1% position cost is a display
      // value only; it is not a PF/DDT input until the row closes.
      unrealizedPnlAfterCost: 0.9,
    })])
  })
})
