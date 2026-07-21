import { VolumeCalculator } from "@/lib/volume-calculator"
import { resolveCombinedPosCountTargetQuantity } from "@/lib/pos-count-live-target"
import { hedgeStrategyVolumeParts } from "@/lib/strategy-volume-coordination"

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
