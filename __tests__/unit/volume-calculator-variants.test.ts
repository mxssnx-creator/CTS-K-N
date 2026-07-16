import { VolumeCalculator } from "@/lib/volume-calculator"

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

  test("Default, Block and DCA preserve their intended quantity ratios above venue minimum", () => {
    const standard = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 1 })
    const block = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 2 })
    const dca = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 0.5 })

    expect(standard.finalVolume).toBeCloseTo(1, 8)
    expect(block.finalVolume).toBeCloseTo(2, 8)
    expect(dca.finalVolume).toBeCloseTo(0.5, 8)
    expect(block.finalVolume! / standard.finalVolume!).toBeCloseTo(2, 8)
    expect(dca.finalVolume! / standard.finalVolume!).toBeCloseTo(0.5, 8)
    expect(block.intendedNotionalUsd).toBeCloseTo(200, 8)
    expect(dca.intendedNotionalUsd).toBeCloseTo(50, 8)
  })

  test("automated variant multipliers remain bounded", () => {
    const tooLarge = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: 500 })
    const invalid = VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier: -4 })

    expect(tooLarge.sizeMultiplier).toBe(5)
    expect(tooLarge.finalVolume).toBeCloseTo(5, 8)
    expect(invalid.sizeMultiplier).toBe(1)
    expect(invalid.finalVolume).toBeCloseTo(1, 8)
  })
})
