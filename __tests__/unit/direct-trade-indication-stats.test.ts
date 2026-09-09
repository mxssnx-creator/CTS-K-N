import {
  buildDirectTradeIndicationTypeStats,
  directTradePositionIndicationType,
} from "@/lib/direct-trade-indication-stats"

describe("Direct-Trade indication-type performance statistics", () => {
  test("keeps exchange settlement, PF coordinate and internal simulation results separate", () => {
    const rows = buildDirectTradeIndicationTypeStats({
      selectedMode: "live",
      enabledIndicationTypes: ["momentum", "breakout"],
      calculation: {
        byEntryTactic: {
          momentum: {
            evaluated: 100,
            valid: 20,
            disabled: 80,
            totalPnl: 45,
            averagePnlPerSet: 0.45,
            profitFactor: 1.8,
          },
          relative: {
            evaluated: 40,
            valid: 0,
            disabled: 40,
            totalPnl: -5,
            averagePnlPerSet: -0.125,
            profitFactor: 0.8,
          },
        },
      },
      positions: [
        {
          status: "closed",
          mode: "live",
          entryTactic: "momentum",
          pnl: 2,
          realizedPnlUsdt: 4,
          pnlAccountingComplete: true,
          positionCostPercent: 0.1,
          blockRealizedVolumeMultiplier: 2,
        },
        {
          status: "closed",
          mode: "live",
          configKey: "BTCUSDT|entry:momentum|type:standard",
          pnl: -1,
          realizedPnLUsdt: -2,
          pnlAccountingComplete: true,
          positionCostPercent: 0.1,
        },
        {
          status: "closed",
          mode: "live",
          indicationType: "momentum",
          pnl: 0,
          realizedPnlUsdt: 0,
          pnlAccountingComplete: true,
          positionCostPercent: 0.1,
        },
        {
          status: "closed",
          mode: "live",
          entryTactic: "momentum",
          pnl: 999,
          realizedPnlUsdt: 999,
          pnlAccountingComplete: false,
        },
        { status: "open", mode: "live", entryTactic: "momentum" },
        { status: "closed", mode: "simulated", entryTactic: "momentum", pnl: 500 },
      ],
    })

    expect(rows.map((row) => row.indicationType)).toEqual([
      "momentum",
      "mean_reversion",
      "breakout",
      "relative",
    ])
    expect(rows[0]).toMatchObject({
      liveEntryEnabled: true,
      openPositions: 1,
      closedPositions: 3,
      accountingPending: 1,
      wins: 1,
      losses: 1,
      breakeven: 1,
      netPnlPercent: 1,
      netExchangePnlUsdt: 2,
      positionCostPercent: 0.4,
      profitFactor: 2,
      profitFactorCoordinate: 1.25,
      internalEvaluated: 100,
      internalValid: 20,
      internalTotalPnl: 45,
      internalProfitFactor: 1.8,
    })
    expect(rows[2]).toMatchObject({ liveEntryEnabled: true, profitFactor: null, profitFactorCoordinate: null })
    expect(rows[3]).toMatchObject({ liveEntryEnabled: false, internalEvaluated: 40, internalTotalPnl: -5 })
  })

  test("infers legacy tactics but never invents a lane", () => {
    expect(directTradePositionIndicationType({ configKey: "x|entry:relative|y" })).toBe("relative")
    expect(directTradePositionIndicationType({ configKey: "x|entry:unknown|y" })).toBeNull()
  })
})
