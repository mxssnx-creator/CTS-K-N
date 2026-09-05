import { advanceBlockCountLifecycle, type BlockCountLifecycle } from "@/lib/block-count-lifecycle"
import { calculateBlockVolumeMultiplier, calculateBlockTargetQuantity, calculateBlockRemainingAddQuantity } from "@/lib/block-count-state"

describe("independent additive Block specification", () => {
  test("four valid blocks add four original volumes, without multiplying the increased volume", () => {
    expect(calculateBlockTargetQuantity(3, 4, 1)).toBe(15)
    expect(calculateBlockTargetQuantity(3, 4, 0.5)).toBe(9)
    expect([1, 2, 3, 4, 5, 6].map((count) => calculateBlockVolumeMultiplier(count, 0.5))).toEqual([1.5, 2, 2.5, 3, 3.5, 4])
    expect(calculateBlockRemainingAddQuantity(3, 4, 0.5, 4.5)).toBe(1.5)
    expect(calculateBlockRemainingAddQuantity(3, 4, 0.5, 6)).toBe(0)
  })

  test("base one ratios preserve their relationship at every physical base size", () => {
    for (const base of [0.0002, 1, 3, 25]) for (const count of [1, 2, 3, 4, 5, 6]) {
      for (const ratio of [0.25, 0.5, 1, 1.5]) for (const level of [1, 2]) {
        expect(calculateBlockTargetQuantity(base, count, ratio, 2, level) / base)
          .toBeCloseTo(1 + count * ratio * level, 10)
      }
    }
  })

  test("losses retain each count independently, permit a second increase and only profit starts its pause", () => {
    const states = new Map<number, BlockCountLifecycle>()
    const outcome = (count: number, pnl: number) => {
      const next = advanceBlockCountLifecycle(states.get(count), {
        setKey: `source#block:${count}`, symbol: "BTCUSDT", direction: "long", sourceKey: "source",
        blockCount: count, incrementSteps: 2, pauseCount: count, netPnl: pnl, updatedAt: 1,
      })
      states.set(count, next)
      return next
    }
    expect(outcome(1, -1)).toMatchObject({ incrementStep: 2, remaining: 0, recovering: true })
    expect(outcome(4, -1)).toMatchObject({ incrementStep: 1, remaining: 0, recovering: true })
    for (let index = 0; index < 3; index++) outcome(4, -1)
    expect(states.get(4)?.incrementStep).toBe(2)
    for (let index = 0; index < 20; index++) outcome(4, 0)
    expect(states.get(4)).toMatchObject({ incrementStep: 2, remaining: 0 })
    expect(outcome(4, 0.1)).toMatchObject({ incrementStep: 1, remaining: 4, recovering: false })
    expect(states.get(1)).toMatchObject({ incrementStep: 2, remaining: 0, recovering: true })
  })
})
