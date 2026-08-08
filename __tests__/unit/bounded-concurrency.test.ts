import {
  clampConcurrency,
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
})
