import { buildDirectTradeOpenPositionStage } from "@/lib/direct-trade-position-stage"
import { aggregateCostNormalizedResults } from "@/lib/profit-factor"
import { calculatePseudoClosePnl } from "@/lib/pseudo-position-costs"
import { StrategyConfigManager } from "@/lib/strategy-config-manager"
import { hedgeStrategyVolumeParts } from "@/lib/strategy-volume-coordination"
import { calculateClosedPositionSignedPricePct } from "@/lib/trade-engine/closed-position-aggregation"
import { normalizeBingXClosedOrder } from "@/lib/trade-history"

describe("direction-bearing processing fails closed", () => {
  test("does not price an unknown pseudo side as Long", () => {
    expect(() => calculatePseudoClosePnl({
      entryPrice: 100,
      currentPrice: 101,
      quantity: 1,
      side: "sideways",
    })).toThrow(/Invalid pseudo-position side/)
  })

  test("excludes invalid open rows from directional counts", () => {
    const stage = buildDirectTradeOpenPositionStage([
      { id: "valid", status: "open", symbol: "BTCUSDT", direction: "short", entryPrice: 100 },
      { id: "invalid", status: "open", symbol: "BTCUSDT", direction: "flat", entryPrice: 100 },
    ])
    expect(stage.rows.map((row) => row.id)).toEqual(["valid"])
    expect(stage.counts).toMatchObject({ total: 1, long: 0, short: 1 })
  })

  test("keeps malformed directions out of PF and hedge ledgers", () => {
    const aggregate = aggregateCostNormalizedResults([
      { entryPrice: 100, exitPrice: 101, direction: "long", positionCostPct: 0.1 },
      { entryPrice: 100, exitPrice: 101, direction: "flat", positionCostPct: 0.1 },
    ])
    expect(aggregate.count).toBe(1)
    expect(calculateClosedPositionSignedPricePct({
      entryPrice: 100,
      exitPrice: 101,
      direction: "flat",
    })).toBeNaN()

    const hedge = hedgeStrategyVolumeParts([
      { setKey: "valid-short", direction: "short", ratio: 2 },
      { setKey: "invalid", direction: "flat" as any, ratio: 50 },
    ])
    expect(hedge.direction).toBe("short")
    expect(hedge.shortRatio).toBe(2)
    expect(hedge.longRatio).toBe(0)
  })

  test("persists direction in the Set schema and leaves legacy rows unknown", () => {
    const serialized = StrategyConfigManager.serializeSetEntry({
      entry_time: "2026-08-12T00:00:00.000Z",
      symbol: "BTCUSDT",
      entry_price: 100,
      take_profit: 101,
      stop_loss: 99,
      status: "closed",
      result: 1,
      exit_time: "2026-08-12T00:01:00.000Z",
      exit_price: 101,
      direction: "short",
      indication_type: "special",
    })
    expect(StrategyConfigManager.parseEntry(serialized)).toMatchObject({
      direction: "short",
      indication_type: "special",
    })
    expect(StrategyConfigManager.parseEntry(
      "2026-08-12T00:00:00.000Z|BTCUSDT|100|101|99|closed|1|2026-08-12T00:01:00.000Z|101",
    )?.direction).toBeUndefined()
  })

  test("rejects a filled BingX row with no valid order side", () => {
    expect(normalizeBingXClosedOrder({
      status: "FILLED",
      quantity: 1,
      avgPrice: 100,
      side: "UNKNOWN",
      positionSide: "BOTH",
      realizedPnl: 2,
    })).toBeNull()
  })
})
