import { VolumeCalculator } from "@/lib/volume-calculator"
import { resolveCombinedPosCountTargetQuantity } from "@/lib/pos-count-live-target"
import { hedgeStrategyVolumeParts } from "@/lib/strategy-volume-coordination"
import {
  normalizeIdentityVolumeFactor,
  normalizeVolumeStepRatio,
} from "@/lib/constants"

describe("live volume coordination by strategy variant", () => {
  const base = {
    accountBalance: 10_000,
    currentPrice: 100,
    positionCost: 0.1,
    positionsAverage: 10,
    leverage: 10,
    exchangeMinVolume: 0,
    tradeMode: "main" as const,
    mainVolumeFactor: 1,
  }

  test("normalizes only shared channel factors to the identity range", () => {
    expect(normalizeIdentityVolumeFactor(0.1)).toBe(1)
    expect(normalizeIdentityVolumeFactor("0.75")).toBe(1)
    expect(normalizeIdentityVolumeFactor(1)).toBe(1)
    expect(normalizeIdentityVolumeFactor("1.5")).toBe(1.5)
    expect(normalizeIdentityVolumeFactor(99)).toBe(10)
    expect(normalizeIdentityVolumeFactor("invalid", 2)).toBe(2)
    expect(normalizeIdentityVolumeFactor("invalid", 0.2)).toBe(1)
    expect(normalizeVolumeStepRatio(0.2)).toBe(0.2)
    expect(normalizeVolumeStepRatio("0.8")).toBe(0.8)
    expect(normalizeVolumeStepRatio(1)).toBe(1)
    expect(normalizeVolumeStepRatio(99)).toBe(1.8)
    expect(normalizeVolumeStepRatio("invalid", 0.6)).toBe(0.6)
  })

  test("ratio 1 equals the venue minimum while ordinary sub-minimum variants clamp", () => {
    const standard = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 1 })
    const block = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 2 })
    const dca = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 0.5 })

    expect(standard.finalVolume).toBeCloseTo(0.05, 8)
    expect(block.finalVolume).toBeCloseTo(0.1, 8)
    expect(dca.calculatedVolume).toBeCloseTo(0.025, 8)
    expect(dca.finalVolume).toBeCloseTo(0.05, 8)
    expect(block.finalVolume! / standard.finalVolume!).toBeCloseTo(2, 8)
    expect(block.intendedNotionalUsd).toBeCloseTo(10, 8)
    expect(dca.intendedNotionalUsd).toBeCloseTo(2.5, 8)
  })

  test("automated variant multipliers remain bounded", () => {
    const tooLarge = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 500 })
    const invalid = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: -4 })

    expect(tooLarge.sizeMultiplier).toBe(5)
    expect(tooLarge.finalVolume).toBeCloseTo(0.25, 8)
    expect(invalid.sizeMultiplier).toBe(1)
    expect(invalid.finalVolume).toBeCloseTo(0.05, 8)
  })

  test("permits an explicitly resolved combined Position-Count target to exceed the ordinary cap", () => {
    const combined = VolumeCalculator.calculatePositionVolume({
      ...base,
      sizeMultiplier: 16,
      allowUnboundedVariantMultiplier: true,
    })

    expect(combined.sizeMultiplier).toBe(16)
    expect(combined.finalVolume).toBeCloseTo(0.8, 8)
  })

  test.each([
    ["default", 1, 0.05, 0.05],
    ["trailing", 1, 0.05, 0.05],
    ["pause-resume", 1, 0.05, 0.05],
    ["block", 1.8, 0.09, 0.09],
    ["dca", 0.5, 0.025, 0.05],
    ["pos-count-part", 0.05, 0.0025, 0.05],
  ])("calculates the %s strategy independently", (_variant, multiplier, calculated, executable) => {
    const result = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: multiplier })
    expect(result.calculatedVolume).toBeCloseTo(calculated as number, 10)
    expect(result.finalVolume).toBeCloseTo(executable as number, 10)
    expect(result.sizeMultiplier).toBe(multiplier)
  })

  test("composes engine and strategy ratios once without changing either input", () => {
    const input = { ...base, mainVolumeFactor: 1.2, sizeMultiplier: 1.5 }
    const result = VolumeCalculator.calculatePositionVolume(input)
    expect(result.liveEngineFactor).toBe(1.2)
    expect(result.sizeMultiplier).toBe(1.5)
    expect(result.calculatedVolume).toBeCloseTo(0.09, 10)
    expect(result.finalVolume).toBeCloseTo(0.09, 10)
    expect(input.mainVolumeFactor).toBe(1.2)
    expect(input.sizeMultiplier).toBe(1.5)
  })

  test("applies the independent Signal factor once only on Main Signal orders", () => {
    const mainSignal = VolumeCalculator.calculatePositionVolume({
      ...base,
      indicationType: "signal",
      mainVolumeFactor: 2,
      signalVolumeFactor: 1.5,
      sizeMultiplier: 1,
    })
    const ordinaryMain = VolumeCalculator.calculatePositionVolume({
      ...base,
      indicationType: "direction",
      mainVolumeFactor: 2,
      signalVolumeFactor: 1.5,
      sizeMultiplier: 1,
    })
    const presetSignal = VolumeCalculator.calculatePositionVolume({
      ...base,
      tradeMode: "preset",
      indicationType: "signal",
      presetVolumeFactor: 2,
      signalVolumeFactor: 1.5,
      sizeMultiplier: 1,
    })

    expect(mainSignal.liveEngineFactor).toBe(3)
    expect(mainSignal.signalVolumeFactor).toBe(1.5)
    expect(mainSignal.finalVolume).toBeCloseTo(0.15, 10)
    expect(ordinaryMain.liveEngineFactor).toBe(2)
    expect(ordinaryMain.signalVolumeFactor).toBe(1)
    expect(ordinaryMain.finalVolume).toBeCloseTo(0.1, 10)
    expect(presetSignal.liveEngineFactor).toBe(2)
    expect(presetSignal.signalVolumeFactor).toBe(1)
    expect(presetSignal.finalVolume).toBeCloseTo(0.1, 10)
  })

  test("keeps channel basis at one while preserving independent sub-unit strategy ratios", () => {
    const clampedChannel = VolumeCalculator.calculatePositionVolume({
      ...base,
      indicationType: "signal",
      mainVolumeFactor: 0.1,
      signalVolumeFactor: 0.2,
      sizeMultiplier: 1,
    })
    const subUnitPosCount = VolumeCalculator.calculatePositionVolume({
      ...base,
      mainVolumeFactor: 1,
      sizeMultiplier: 0.05,
    })
    const pseudo = VolumeCalculator.calculatePositionVolume({
      ...base,
      tradeMode: undefined,
      mainVolumeFactor: 10,
      signalVolumeFactor: 10,
      indicationType: "signal",
      sizeMultiplier: 1,
    })

    expect(clampedChannel.liveEngineFactor).toBe(1)
    expect(clampedChannel.finalVolume).toBeCloseTo(0.05, 10)
    expect(subUnitPosCount.sizeMultiplier).toBe(0.05)
    expect(subUnitPosCount.calculatedVolume).toBeCloseTo(0.0025, 10)
    expect(pseudo.liveEngineFactor).toBe(1)
    expect(pseudo.signalVolumeFactor).toBe(1)
    expect(pseudo.calculatedVolume).toBeCloseTo(1, 10)
  })

  test("resolves connection overrides before global identity-based channel factors", () => {
    expect(VolumeCalculator.resolveLiveEngine(
      { is_live_trade: "1", signal_volume_factor: "2.5" },
      {
        mainTradeVolumeFactor: "1.5",
        presetTradeVolumeFactor: "2",
        signalTradeVolumeFactor: "1.75",
      },
    )).toMatchObject({
      tradeMode: "main",
      mainVolumeFactor: 1.5,
      presetVolumeFactor: 2,
      signalVolumeFactor: 2.5,
    })
    expect(VolumeCalculator.resolveLiveEngine(
      { is_preset_trade: "1", is_live_trade: "0" },
      { signalTradeVolumeFactor: "1.75" },
    )).toMatchObject({
      tradeMode: "preset",
      mainVolumeFactor: 1,
      presetVolumeFactor: 1,
      signalVolumeFactor: 1.75,
    })
  })

  test("calculates each pos-count part, the hedge, and the one-order target without per-part minimum inflation", () => {
    const parts = [
      ...Array.from({ length: 24 }, (_, index) => ({ setKey: `long-${index}`, direction: "long" as const, ratio: 0.05, quality: 2 })),
      ...Array.from({ length: 4 }, (_, index) => ({ setKey: `short-${index}`, direction: "short" as const, ratio: 0.05, quality: 2 })),
    ]
    const hedge = hedgeStrategyVolumeParts(parts)
    expect(hedge.longRatio).toBeCloseTo(1.2, 12)
    expect(hedge.shortRatio).toBeCloseTo(0.2, 12)
    expect(hedge.netRatio).toBeCloseTo(1, 12)
    expect(Object.values(hedge.memberRatios).reduce((sum, ratio) => sum + ratio, 0)).toBeCloseTo(1, 12)

    const result = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: hedge.netRatio })
    expect(result.calculatedVolume).toBeCloseTo(0.05, 12)
    expect(resolveCombinedPosCountTargetQuantity(result)).toBeCloseTo(0.05, 12)

    const subMinimum = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 0.95 })
    expect(subMinimum.calculatedVolume).toBeCloseTo(0.0475, 12)
    expect(resolveCombinedPosCountTargetQuantity(subMinimum)).toBe(0)
  })
})
