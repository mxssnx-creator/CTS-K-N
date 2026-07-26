import { StrategyEngine } from "@/lib/strategies"
import { TradingEngine } from "@/lib/trading"
import { resolveRealStageSizeMultiplier } from "@/lib/trade-engine/stages/real-stage"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { normalizeBaseVolumeFactor } from "@/lib/constants"
import { normalizeFileConnectionBaseIdentity } from "@/lib/file-storage"
import type { StrategyConfig } from "@/lib/types"

const config = (adjustments?: StrategyConfig["adjustments"]): StrategyConfig => ({
  takeprofit_factor: 3,
  stoploss_ratio: 1,
  trailing_enabled: false,
  last_positions_count: 25,
  main_positions_count: 5,
  // Deliberately stale/imported: normal Base coordination must ignore it.
  volume_factor: 9,
  adjustments,
})

const positions = Array.from({ length: 25 }, (_, index) => ({
  id: `p-${index}`,
  connection_id: "identity",
  symbol: "BTCUSDT",
  indication_type: "direction" as const,
  takeprofit_factor: 3,
  stoploss_ratio: 1,
  trailing_enabled: false,
  entry_price: 100,
  current_price: 101,
  profit_factor: index % 2 === 0 ? 2 : -0.5,
  position_cost: 0.1,
  status: "closed" as const,
  created_at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
  updated_at: new Date(1_700_000_000_500 + index * 1_000).toISOString(),
}))

describe("system-wide Base volume identity", () => {
  test("normalizes every legacy Base value to exactly one", () => {
    expect(normalizeBaseVolumeFactor(undefined)).toBe(1)
    expect(normalizeBaseVolumeFactor(0.05)).toBe(1)
    expect(normalizeBaseVolumeFactor(9)).toBe(1)
    expect(normalizeBaseVolumeFactor("invalid")).toBe(1)
  })

  test("normalizes stale file-backed connection exports, including nested settings", () => {
    const normalized = normalizeFileConnectionBaseIdentity({
      id: "legacy-file",
      user_id: 1,
      name: "Legacy",
      exchange: "bingx",
      exchange_id: 9,
      api_type: "perpetual_futures",
      connection_method: "library",
      connection_library: "sdk",
      api_key: "",
      api_secret: "",
      margin_type: "cross",
      position_mode: "hedge",
      is_testnet: true,
      is_enabled: true,
      is_live_trade: false,
      is_preset_trade: false,
      is_active: true,
      is_predefined: false,
      volume_factor: 7,
      connection_settings: JSON.stringify({
        volume_factor: 9,
        base_volume_factor: 8,
        baseVolumeFactor: 6,
        signal_volume_factor: 1.5,
      }),
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    })

    expect(normalized.volume_factor).toBe(1)
    expect(JSON.parse(String(normalized.connection_settings))).toEqual({
      volume_factor: 1,
      base_volume_factor: 1,
      baseVolumeFactor: 1,
      signal_volume_factor: 1.5,
    })
  })

  test("legacy TradingEngine cannot mutate the shared Base basis", () => {
    const engine = new TradingEngine()
    engine.setBaseVolumeFactor(7)
    expect(engine.calculateVolume(2)).toEqual({
      base: 2,
      adjusted: 2,
      factor: 1,
    })
    expect(engine.calculateVolume(2, 1.5)).toEqual({
      base: 2,
      adjusted: 3,
      factor: 1.5,
    })
  })

  test("demo StrategyEngine keeps normal Base at 1 and starts Block immediately", () => {
    const engine = new StrategyEngine()
    const normal = engine.calculateBaseStrategy(positions as any, config(), true)
    const block = engine.calculateBaseStrategy(positions as any, config({
      block: {
        enabled: true,
        blockSize: 3,
        adjustmentRatio: 1.5,
      },
    }), true)

    expect(normal.volume_factor).toBe(1)
    expect(block.volume_factor).toBe(5.5)
    expect(block.adjustments).toEqual(["block"])
  })

  test("legacy/demo projection never compounds Block and DCA into one lane", () => {
    const engine = new StrategyEngine()
    const dca = engine.calculateBaseStrategy(positions as any, config({
      dca: {
        enabled: true,
        levels: 3,
      },
    }), true)
    const malformedCombined = engine.calculateBaseStrategy(positions as any, config({
      block: {
        enabled: true,
        blockSize: 3,
        adjustmentRatio: 1.5,
      },
      dca: {
        enabled: true,
        levels: 3,
      },
    }), true)

    expect(dca.volume_factor).toBeCloseTo(1 + 12 / 25, 12)
    expect(dca.adjustments).toEqual(["dca"])
    expect(malformedCombined.volume_factor).toBe(5.5)
    expect(malformedCombined.adjustments).toEqual(["block"])
  })

  test("compatibility Real stage ignores stale Base multipliers for every variant", () => {
    expect(resolveRealStageSizeMultiplier({
      variant: "default",
      baseMultiplier: 7,
      sizeMultiplier: 4,
    })).toBe(1)
    expect(resolveRealStageSizeMultiplier({
      variant: "trailing",
      baseMultiplier: 3,
    })).toBe(1)
    expect(resolveRealStageSizeMultiplier({
      variant: "block",
      setKey: "BTCUSDT:signal:long#block:3",
      blockCount: 3,
      blockVolumeRatio: 1.5,
      baseMultiplier: 99,
    })).toBe(5.5)
    expect(resolveRealStageSizeMultiplier({
      variant: "dca",
      variantSizeMultiplier: 0.5,
      baseMultiplier: 4,
    })).toBe(0.5)
    expect(resolveRealStageSizeMultiplier({
      combinedPosCounts: true,
      posCountsTargetFlat: true,
      sizeMultiplier: 9,
    })).toBe(0)
  })

  test("risk-percentage sizing ignores stale Base fields but composes explicit channels once", () => {
    const common = {
      accountBalance: 10_000,
      currentPrice: 100,
      riskPercentage: 1,
      positionsAverage: 10,
      leverage: 10,
      exchangeMinVolume: 0,
      tradeMode: "main" as const,
      mainVolumeFactor: 2,
      indicationType: "signal",
      signalVolumeFactor: 1.5,
      sizeMultiplier: 0.5,
    }
    const identity = VolumeCalculator.calculatePositionVolume({
      ...common,
      baseVolumeFactor: 1,
    })
    const stale = VolumeCalculator.calculatePositionVolume({
      ...common,
      baseVolumeFactor: 9,
    })

    expect(stale.calculatedVolume).toBeCloseTo(identity.calculatedVolume!, 12)
    expect(stale.finalVolume).toBeCloseTo(identity.finalVolume!, 12)
    expect(stale.riskAmount).toBeCloseTo(identity.riskAmount!, 12)
    expect(stale.liveEngineFactor).toBe(3)
    expect(stale.signalVolumeFactor).toBe(1.5)
    expect(stale.sizeMultiplier).toBe(0.5)
    expect(stale.adjustmentReason).not.toContain("base ratio")
  })

  test.each([
    {
      name: "pseudo ordinary",
      tradeMode: undefined,
      indicationType: "direction",
      mainVolumeFactor: 4,
      presetVolumeFactor: 6,
      signalVolumeFactor: 3,
      sizeMultiplier: 1,
      expectedEngine: 1,
      expectedSignal: 1,
      expectedVariant: 1,
      expectedCalculated: 1,
    },
    {
      name: "pseudo sub-unit pos-count",
      tradeMode: undefined,
      indicationType: "signal",
      mainVolumeFactor: 4,
      presetVolumeFactor: 6,
      signalVolumeFactor: 3,
      sizeMultiplier: 0.05,
      expectedEngine: 1,
      expectedSignal: 1,
      expectedVariant: 0.05,
      expectedCalculated: 0.05,
    },
    {
      name: "main ordinary",
      tradeMode: "main" as const,
      indicationType: "direction",
      mainVolumeFactor: 2,
      presetVolumeFactor: 7,
      signalVolumeFactor: 3,
      sizeMultiplier: 1,
      expectedEngine: 2,
      expectedSignal: 1,
      expectedVariant: 1,
      expectedCalculated: 0.1,
    },
    {
      name: "main signal block target",
      tradeMode: "main" as const,
      indicationType: "signal",
      mainVolumeFactor: 2,
      presetVolumeFactor: 7,
      signalVolumeFactor: 1.5,
      sizeMultiplier: 5,
      expectedEngine: 3,
      expectedSignal: 1.5,
      expectedVariant: 5,
      expectedCalculated: 0.75,
    },
    {
      name: "preset ignores signal channel",
      tradeMode: "preset" as const,
      indicationType: "signal",
      mainVolumeFactor: 9,
      presetVolumeFactor: 2.5,
      signalVolumeFactor: 3,
      sizeMultiplier: 2,
      expectedEngine: 2.5,
      expectedSignal: 1,
      expectedVariant: 2,
      expectedCalculated: 0.25,
    },
  ])("position-cost matrix keeps Base identity for $name", ({
    tradeMode,
    indicationType,
    mainVolumeFactor,
    presetVolumeFactor,
    signalVolumeFactor,
    sizeMultiplier,
    expectedEngine,
    expectedSignal,
    expectedVariant,
    expectedCalculated,
  }) => {
    const common = {
      accountBalance: 10_000,
      currentPrice: 100,
      positionCost: 0.01,
      positionsAverage: 1,
      leverage: 10,
      exchangeMinVolume: 0,
      tradeMode,
      indicationType,
      mainVolumeFactor,
      presetVolumeFactor,
      signalVolumeFactor,
      sizeMultiplier,
    }
    const identity = VolumeCalculator.calculatePositionVolume({
      ...common,
      baseVolumeFactor: 1,
    })
    const stale = VolumeCalculator.calculatePositionVolume({
      ...common,
      baseVolumeFactor: 9,
    })

    expect(stale.calculatedVolume).toBeCloseTo(expectedCalculated, 12)
    expect(stale.calculatedVolume).toBeCloseTo(identity.calculatedVolume!, 12)
    expect(stale.liveEngineFactor).toBe(expectedEngine)
    expect(stale.signalVolumeFactor).toBe(expectedSignal)
    expect(stale.sizeMultiplier).toBe(expectedVariant)
  })
})
