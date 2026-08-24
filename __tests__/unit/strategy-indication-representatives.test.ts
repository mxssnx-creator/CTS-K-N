import { selectStrategyIndicationRepresentatives } from "@/lib/trade-engine/indication-processor-fixed"

function exact(overrides: Record<string, unknown> = {}) {
  return {
    type: "common",
    direction: "long",
    setKey: "indication_set:test:BTCUSDT:common:long:rsi:a",
    profitFactor: 1.12,
    confidence: 0.7,
    config: { indicatorType: "rsi", timeframeMinutes: 5 },
    metadata: {
      direction: "long",
      commonIndicatorType: "rsi",
      timeframeMinutes: 5,
      positionCostRatio: 1.12,
      profitFactorSource: "position_cost_relative_realized_outcomes",
    },
    ...overrides,
  }
}

describe("logical Strategy indication representatives", () => {
  test("keeps complete calculation families but selects one deterministic executable row per lane", () => {
    const rows = selectStrategyIndicationRepresentatives([
      exact(),
      exact({
        setKey: "indication_set:test:BTCUSDT:common:long:rsi:b",
        profitFactor: 1.24,
        confidence: 0.8,
        metadata: {
          direction: "long",
          commonIndicatorType: "rsi",
          timeframeMinutes: 5,
          positionCostRatio: 1.24,
          profitFactorSource: "position_cost_relative_realized_outcomes",
        },
      }),
      exact({
        setKey: "indication_set:test:BTCUSDT:common:long:rsi:tf15",
        config: { indicatorType: "rsi", timeframeMinutes: 15 },
        metadata: {
          direction: "long",
          commonIndicatorType: "rsi",
          timeframeMinutes: 15,
          positionCostRatio: 1.14,
          profitFactorSource: "position_cost_relative_realized_outcomes",
        },
      }),
      exact({
        direction: "short",
        setKey: "indication_set:test:BTCUSDT:common:short:rsi:a",
        metadata: {
          direction: "short",
          commonIndicatorType: "rsi",
          timeframeMinutes: 5,
          positionCostRatio: 1.16,
          profitFactorSource: "position_cost_relative_realized_outcomes",
        },
      }),
    ])

    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.metadata.strategyLogicalLane === "common|long|rsi:tf5"))
      .toMatchObject({
        setKey: "indication_set:test:BTCUSDT:common:long:rsi:b",
        metadata: { qualifiedConfigurationCount: 2, strategyRepresentative: true },
      })
  })

  test("keeps distinct protection families and direct fallbacks", () => {
    const fallback = { type: "signal", direction: "long", setKey: "signal:one" }
    const rows = selectStrategyIndicationRepresentatives([
      exact({
        type: "active",
        setKey: "active:wide",
        metadata: {
          direction: "long",
          activeProtection: { id: "wide" },
          positionCostRatio: 1.2,
          profitFactorSource: "position_cost_relative_realized_outcomes",
        },
      }),
      exact({
        type: "active",
        setKey: "active:tight",
        metadata: {
          direction: "long",
          activeProtection: { id: "tight" },
          positionCostRatio: 1.18,
          profitFactorSource: "position_cost_relative_realized_outcomes",
        },
      }),
    ], [fallback])

    expect(rows.map((row) => row.setKey)).toEqual(["active:tight", "active:wide", "signal:one"])
  })
})
