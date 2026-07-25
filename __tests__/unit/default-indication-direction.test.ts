import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { DEFAULT_MAIN_COORDINATION_SETTINGS } from "@/lib/multi-range-coordination"
import {
  normalizeStrategyDirection,
  resolveIndicationTradeDirection,
} from "@/lib/strategy-coordinator"

function processor() {
  const instance = Object.create(IndicationSetsProcessor.prototype) as any
  instance.defaultCoordination = {
    ...DEFAULT_MAIN_COORDINATION_SETTINGS,
    rangeSteps: [2, 2.5, 3],
  }
  instance.trendPositionCostPct = 100
  return instance
}

describe("default Direction indication semantics", () => {
  test("trades a reversal in the new market direction", () => {
    const instance = processor()
    const config = {
      range: 3,
      drawdownRatio: 1,
      lastPartRatio: 0.5,
      factorMultiplier: 1,
    }

    const toLong = instance.calculateDirectionIndication(
      { prices: [103, 102, 101, 100, 101, 102] },
      config,
    )
    const toShort = instance.calculateDirectionIndication(
      { prices: [100, 101, 102, 103, 102, 101] },
      config,
    )

    expect(toLong).toMatchObject({
      metadata: { firstDir: expect.any(Number), secondDir: expect.any(Number), direction: "long" },
    })
    expect(toLong.metadata.firstDir).toBeLessThan(0)
    expect(toLong.metadata.secondDir).toBeGreaterThan(0)
    expect(toShort.metadata.direction).toBe("short")
    expect(toShort.metadata.firstDir).toBeGreaterThan(0)
    expect(toShort.metadata.secondDir).toBeLessThan(0)
  })

  test("keeps the original reversal calculation independent of extra relative-step gates", () => {
    const instance = processor()
    const result = instance.calculateDirectionIndication(
      { prices: [103, 102, 101, 100, 101, 102] },
      {
        range: 3,
        drawdownRatio: 1,
        lastPartRatio: 0.5,
        factorMultiplier: 1,
      },
    )

    expect(result).not.toBeNull()
    expect(result.metadata.passedRangeSteps).toEqual([])
    expect(result.signalScore).toBeGreaterThan(1)
  })

  test("derives monotonic direction from temporal movement, not values above an average", () => {
    const instance = processor()
    expect(instance.getDirection([100, 101, 102, 103])).toBeGreaterThan(0)
    expect(instance.getDirection([103, 102, 101, 100])).toBeLessThan(0)
  })

  test("reconstructs legacy Direction rows from the new post-reversal side and rejects missing sides", () => {
    expect(resolveIndicationTradeDirection({
      type: "direction",
      metadata: { firstDir: -1, secondDir: 1 },
    })).toBe("long")
    expect(resolveIndicationTradeDirection({
      type: "direction",
      metadata: { firstDir: 1 },
    })).toBe("short")
    expect(resolveIndicationTradeDirection({
      type: "move",
      metadata: { movement: -0.25 },
    })).toBe("short")
    expect(resolveIndicationTradeDirection({
      type: "direction",
      value: 42_000,
      metadata: {},
    })).toBeNull()
    expect(normalizeStrategyDirection("BUY")).toBe("long")
    expect(normalizeStrategyDirection("sell")).toBe("short")
    expect(normalizeStrategyDirection("sideways")).toBeNull()
  })
})
