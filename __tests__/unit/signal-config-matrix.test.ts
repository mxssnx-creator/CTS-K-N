import {
  buildSignalTradeConfigurations,
  signalConfigurationTrailingProfile,
} from "@/lib/signal-config-matrix"

describe("Signal configuration matrix", () => {
  it("materialises every standard and trailing TP/SL tuple without sampling", () => {
    const configurations = buildSignalTradeConfigurations()
    // 9 TP × 6 SL relations × (1 standard + 5 trailing stops)
    expect(configurations).toHaveLength(324)
    expect(new Set(configurations.map((config) => config.id)).size).toBe(324)
    expect(configurations[0]).toMatchObject({
      takeProfitPct: 1,
      stopLossToTakeProfitRatio: 0.5,
      stopLossPct: 0.5,
      trailing: false,
    })
    expect(configurations.at(-1)).toMatchObject({
      takeProfitPct: 5,
      stopLossToTakeProfitRatio: 3,
      stopLossPct: 15,
      trailingStopPct: 2.4,
      trailing: true,
    })
  })

  it("creates the canonical dynamic trailing profile per trailing Set", () => {
    const trailing = buildSignalTradeConfigurations().find(
      (config) => config.trailingStopPct === 1.2,
    )
    expect(trailing).toBeDefined()
    expect(signalConfigurationTrailingProfile(trailing!)).toMatchObject({
      mode: "signal_dynamic",
      startRatio: 0,
      stopRatio: 0.012,
      minStopRatio: 0.012,
      positiveMoveRatio: 0.4,
      updateStopRangeRatio: 0.5,
    })
  })
})
