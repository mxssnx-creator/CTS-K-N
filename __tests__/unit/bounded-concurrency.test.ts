import {
  clampConcurrency,
  createAdaptiveConcurrencyLimiter,
  mapSettledWithConcurrency,
  mapWithConcurrency,
} from "../../lib/bounded-concurrency"
import { buildStrategyIndicationFingerprint } from "../../lib/strategy-coordinator"

describe("bounded engine concurrency", () => {
  test("preserves result order while enforcing the in-flight ceiling", async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 18 }, (_, index) => index)

    const results = await mapWithConcurrency(items, 3, async (item) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, (item % 4) + 1))
      active--
      return item * 2
    })

    expect(peak).toBe(3)
    expect(results).toEqual(items.map((item) => item * 2))
  })

  test("isolates failures without cancelling sibling work", async () => {
    const results = await mapSettledWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      if (item === 1) throw new Error("expected")
      return item + 10
    })

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ])
    expect((results[3] as PromiseFulfilledResult<number>).value).toBe(13)
  })

  test("clamps invalid and oversized configuration", () => {
    expect(clampConcurrency(undefined, 2, 4, 12)).toBe(2)
    expect(clampConcurrency("99", 2, 4, 12)).toBe(4)
    expect(clampConcurrency("invalid", 2, 4, 1)).toBe(1)
  })

  test("adapts newly scheduled work when the runtime lane sampler changes", async () => {
    let desired = 3
    let active = 0
    let peakBeforeReduction = 0
    let peakAfterReduction = 0
    let completed = 0

    const results = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async (item) => {
        active++
        if (completed < 3) peakBeforeReduction = Math.max(peakBeforeReduction, active)
        else peakAfterReduction = Math.max(peakAfterReduction, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
        completed++
        if (completed === 3) desired = 1
        return item
      },
      { getConcurrency: () => desired, yieldEvery: 0 },
    )

    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(peakBeforeReduction).toBe(3)
    expect(peakAfterReduction).toBe(1)
  })

  test("contains sampler failures by falling back to one lane", async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency([1, 2, 3], 3, async (item) => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return item
    }, { getConcurrency: () => { throw new Error("telemetry unavailable") } })

    expect(results).toEqual([1, 2, 3])
    expect(peak).toBe(1)
  })

  test("shares one adaptive budget across independent async branches", async () => {
    let desired = 2
    let active = 0
    let peak = 0
    const limiter = createAdaptiveConcurrencyLimiter(4, () => desired)
    const work = (id: number) => limiter.run(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      if (id === 1) desired = 1
      return id
    })

    const [left, right] = await Promise.all([
      Promise.all([work(0), work(1), work(2)]),
      Promise.all([work(3), work(4), work(5)]),
    ])

    expect([...left, ...right].sort()).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(2)
    expect(limiter.activeCount).toBe(0)
    expect(limiter.queuedCount).toBe(0)
  })

  test("same-size indication replacements invalidate the strategy cache", () => {
    const before = buildStrategyIndicationFingerprint([
      { id: "a", timestamp: "2026-07-15T10:00:00.000Z" },
      { id: "z", timestamp: "2026-07-15T10:00:02.000Z" },
    ])
    const after = buildStrategyIndicationFingerprint([
      { id: "c", timestamp: "2026-07-15T10:00:01.000Z" },
      { id: "z", timestamp: "2026-07-15T10:00:02.000Z" },
    ])

    expect(after).not.toBe(before)
  })

  test("exact snapshot refresh timestamps do not invalidate the strategy cache", () => {
    const before = buildStrategyIndicationFingerprint([{ id: "old", setKey: "exact:1", timestamp: 1, price: 10 }])
    const after = buildStrategyIndicationFingerprint([{ id: "new", setKey: "exact:1", timestamp: 2, price: 10 }])
    expect(after).toBe(before)
  })
})
