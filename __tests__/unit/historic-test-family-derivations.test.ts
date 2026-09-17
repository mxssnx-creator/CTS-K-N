import blockVolume from "@/lib/block-volume-ratio.cjs"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"

const t = (r: number, i = 0) => ({ signedResultR: r, openedAt: 1_000 + i, closedAt: 2_000 + i })
const results = (rows: Array<{ signedResultR: number }>) => rows.map((r) => Number(r.signedResultR.toFixed(6)))

describe("Block derivation scales volume, never entries or exits", () => {
  test("the first trade runs at base volume — a Block add-on exists only after a settled loss", () => {
    expect(results(deriveBlockTrades([t(2)], { volumeRatio: 1, incrementSteps: 3, maxStack: 3 }))).toEqual([2])
  })

  test("a loss raises the count, so the next trade carries the additive multiplier", () => {
    const out = deriveBlockTrades([t(-1), t(2)], { volumeRatio: 1, incrementSteps: 3, maxStack: 3 })
    const multiplier = blockVolume.blockVolumeMultiplier(1, 1, 3, 1)
    expect(results(out)).toEqual([-1, Number((2 * multiplier).toFixed(6))])
    expect(multiplier).toBe(2)
  })

  test("Block magnifies losses that follow losses just as much as recovery wins", () => {
    const out = deriveBlockTrades([t(-1), t(-1), t(-1)], { volumeRatio: 1, incrementSteps: 3, maxStack: 3 })
    // Counts 0, 1, 2 -> multipliers 1, 2, and at least 3 on the third attempt.
    expect(out[0].signedResultR).toBe(-1)
    expect(out[1].signedResultR).toBeLessThan(-1)
    expect(out[2].signedResultR).toBeLessThan(out[1].signedResultR)
  })

  test("a positive result returns the lane to base volume", () => {
    const out = deriveBlockTrades([t(-1), t(1), t(3)], { volumeRatio: 1, incrementSteps: 3, maxStack: 3 })
    // After the win at index 1 the count resets, so index 2 runs at base.
    expect(out[2].signedResultR).toBe(3)
  })

  test("the count never exceeds the configured stack and timestamps are preserved", () => {
    const losses = Array.from({ length: 10 }, (_, i) => t(-1, i))
    const out = deriveBlockTrades(losses, { volumeRatio: 1, incrementSteps: 1, maxStack: 2 })
    const capped = blockVolume.blockVolumeMultiplier(2, 1, 1, 1)
    expect(Math.min(...out.map((r) => r.signedResultR))).toBe(-capped)
    expect(out[0].openedAt).toBe(1_000)
    expect(out[0].closedAt).toBe(2_000)
  })
})

describe("Axis derivation filters admissions, never results", () => {
  test("entries before the window is filled are admitted unchanged", () => {
    const rows = [t(1), t(-1), t(1)]
    expect(results(deriveAxisTrades(rows, { prev: 12, last: 4, cont: 8, pause: 8 }))).toEqual([1, -1, 1])
  })

  test("once the window is filled, admission needs the required positives inside it", () => {
    // Window of 2 requiring 2 positives: after two losses nothing is admitted.
    const rows = [t(-1), t(-1), t(5), t(5)]
    const out = deriveAxisTrades(rows, { prev: 2, last: 2, cont: 99, pause: 0 })
    // The first two fill the window; the third is judged on [-1,-1] -> refused;
    // the fourth on [-1,5] -> still short of 2 positives.
    expect(results(out)).toEqual([-1, -1])
  })

  test("consecutive losses trigger a pause that skips the configured number of entries", () => {
    const rows = [t(-1), t(-1), t(9), t(9), t(9)]
    const out = deriveAxisTrades(rows, { prev: 99, last: 0, cont: 2, pause: 2 })
    // Window never fills (prev 99) so admission is open, but the pause after
    // two consecutive losses skips the next two entries.
    expect(results(out)).toEqual([-1, -1, 9])
  })

  test("a skipped entry still counts in the outcome history, because the market happened anyway", () => {
    const rows = [t(-1), t(-1), t(-1), t(4)]
    const out = deriveAxisTrades(rows, { prev: 99, last: 0, cont: 2, pause: 1 })
    // Entry 3 is paused; its loss still feeds the history, so the streak continues.
    expect(results(out)).toEqual([-1, -1, 4])
  })

  test("results themselves are never altered by the axis", () => {
    const rows = [t(3), t(-2), t(7)]
    const out = deriveAxisTrades(rows, { prev: 1, last: 0, cont: 99, pause: 0 })
    expect(results(out)).toEqual([3, -2, 7])
  })
})

describe("each Block count is an independent config", () => {
  const { deriveBlockTrades } = require("@/lib/historic-test-family-derivations")
  const { parseBlockCountVariant } = require("@/lib/historic-test-replay")
  const baseline = [{ signedResultR: -1 }, { signedResultR: -1 }, { signedResultR: 2 }, { signedResultR: -1 }]

  test("a variant names the count it replays", () => {
    expect(parseBlockCountVariant("2")).toBe(2)
    expect(parseBlockCountVariant("count:3")).toBe(3)
    expect(parseBlockCountVariant("block:6")).toBe(6)
    expect(parseBlockCountVariant("")).toBeNull()
    expect(parseBlockCountVariant(undefined)).toBeNull()
    expect(parseBlockCountVariant("0")).toBeNull()
  })

  test("a fixed count runs every attempt at that count's add-on, unlike the evolving lane", () => {
    const evolving = deriveBlockTrades(baseline, { volumeRatio: 1, incrementSteps: 3, maxStack: 3 })
    const count2 = deriveBlockTrades(baseline, { volumeRatio: 1, incrementSteps: 3, maxStack: 3, fixedCount: 2 })
    // The evolving lane starts at base volume; count 2 never does.
    expect(evolving[0].signedResultR).toBeCloseTo(-1, 10)
    expect(count2[0].signedResultR).toBeCloseTo(-3, 10) // 1 + 2 x 1 x level 1 = 3
    // Different counts must produce different results — that is the point of
    // validating them independently.
    const count1 = deriveBlockTrades(baseline, { volumeRatio: 1, incrementSteps: 3, maxStack: 3, fixedCount: 1 })
    expect(count1.map((t) => t.signedResultR)).not.toEqual(count2.map((t) => t.signedResultR))
  })

  test("a positive result resets the level but never the count's identity", () => {
    const count2 = deriveBlockTrades([{ signedResultR: -1 }, { signedResultR: 5 }, { signedResultR: -1 }], {
      volumeRatio: 1, incrementSteps: 3, maxStack: 3, fixedCount: 2,
    })
    // After the win the lane is still count 2 at level 1 -> multiplier 3.
    expect(count2[2].signedResultR).toBeCloseTo(-3, 10)
  })
})
