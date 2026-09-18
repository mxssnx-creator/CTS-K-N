import { VolumeCalculator } from "@/lib/volume-calculator"

const base = {
  accountBalance: 10_000, currentPrice: 100, positionCostPercent: 0.1,
  positionsAverage: 10, leverage: 5, exchangeMinVolume: 0.001, tradeMode: "main" as const,
}
const run = (sizeMultiplier: number) =>
  VolumeCalculator.calculatePositionVolume({ ...base, sizeMultiplier }) as any

describe("a strategy increase survives the exchange minimum floor", () => {
  test("the base alone still clamps to the plain minimum", () => {
    const plain = run(1)
    // Intended 0.2 USD is far under the 5 USD floor, so the floor applies.
    expect(plain.intendedNotionalUsd).toBeCloseTo(0.2, 8)
    expect(plain.volumeUsd).toBeCloseTo(5, 8)
  })

  test("a variant multiplier scales the floor instead of being swallowed by it", () => {
    // Before: 1x, 5x and 15x all executed the same 5 USD minimum, so a Block
    // recovery on a sub-minimum base was indistinguishable from a plain entry.
    const scaled = run(5)
    expect(scaled.volumeUsd).toBeCloseTo(25, 8)
    expect(scaled.finalVolume).toBeCloseTo(0.25, 8)
    expect(scaled.volumeUsd).toBeGreaterThan(run(1).volumeUsd)
  })

  test("the executed size is monotone in the multiplier", () => {
    const sizes = [1, 2, 3, 5].map((m) => run(m).volumeUsd)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1])
  })

  test("the ceiling admits exactly the scaled floor, not more", () => {
    const scaled = run(5)
    // 5 USD venue minimum x 5 = 25 USD; the ceiling rises to meet it and stops.
    expect(scaled.maxExecutionNotionalUsd).toBeCloseTo(25, 8)
    expect(scaled.exchangeMinNotionalUsd).toBeCloseTo(5, 8)
  })

  test("a multiplier at or below 1 never lifts the floor", () => {
    for (const multiplier of [1, 0.5, 0, -3]) {
      expect(run(multiplier).volumeUsd).toBeCloseTo(5, 8)
    }
  })

  test("a base above the minimum is unaffected by the floor logic", () => {
    const large = VolumeCalculator.calculatePositionVolume({
      ...base, accountBalance: 1_000_000, sizeMultiplier: 2,
    }) as any
    // Intended notional now exceeds the floor, so the floor never engages.
    expect(large.intendedNotionalUsd).toBeGreaterThan(large.exchangeMinNotionalUsd)
    expect(large.volumeUsd).toBeGreaterThan(5)
  })
})
