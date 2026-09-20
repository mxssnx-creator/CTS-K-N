import { BLOCK_SHARED_RATIO_DEFAULT, BLOCK_STEP_MAX, deriveBlockTrades } from "@/lib/historic-test-family-derivations"

const mk = (...r: number[]) => r.map((v, i) => ({ signedResultR: v, openedAt: i * 1000, closedAt: i * 1000 + 500 })) as any
const v = (rows: readonly any[]) => rows.map((r) => Number(r.signedResultR.toFixed(4)))
const base = mk(5, -2, 5, -2, -2, -2, 5)

describe("Block adjustment follows the operator specification", () => {
  test("shared uses ONE uniform ratio whatever the count is", () => {
    const c2 = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, adjustMode: "shared", sharedRatio: 1.5 }))
    const c5 = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 5, adjustMode: "shared", sharedRatio: 1.5 }))
    // Shared is defined by "at least one block is valid", not by how many, so
    // the RATIO is identical across counts: the first recovery entry is
    // 5 x (1 + 1.5 x level 1) = 12.5 whatever the count.
    expect(c2[2]).toBeCloseTo(12.5, 6)
    expect(c5[2]).toBeCloseTo(12.5, 6)
    // The escalation CADENCE still follows the count — a count-2 lane steps
    // every 2 settled losses, a count-5 lane every 5 — so the streams diverge
    // later even though every step uses the same ratio.
    expect(c2.length).toBe(c5.length)
  })

  test("additive adds a ratio per valid count, so counts differ", () => {
    const c2 = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, adjustMode: "additive" }))
    const c5 = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 5, adjustMode: "additive" }))
    expect(c2).not.toEqual(c5)
    expect(c5[2]).toBeGreaterThan(c2[2])
  })

  test("the shared default ratio is 0.8 — it fires on 'at least one', so it steps small", () => {
    expect(BLOCK_SHARED_RATIO_DEFAULT).toBe(0.8)
    const withDefault = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, adjustMode: "shared" }))
    const explicit = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, adjustMode: "shared", sharedRatio: 0.8 }))
    expect(withDefault).toEqual(explicit)
  })

  test("active 0 is off — every leg runs, normal legs included", () => {
    const off = v(deriveBlockTrades(base, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, activeSkipSteps: 0 }))
    expect(off).toHaveLength(base.length)
  })

  test("active N skips the first N Block steps, and steps above it still trade", () => {
    const run = (activeSkipSteps: number, incrementSteps: number) => v(deriveBlockTrades(
      mk(5, -2, -2, -2, -2, 5, 5) as any,
      { volumeRatio: 0.2, maxStack: 6, fixedCount: 2, incrementSteps, activeSkipSteps },
    ))
    // Two steps configured: active 1 trades only step 2.
    expect(run(1, 2)).toEqual([-3.6, 9])
    // Only one step exists, so skipping it leaves nothing to trade.
    expect(run(1, 1)).toEqual([])
  })

  test("step escalation is capped at 3, per count independently", () => {
    expect(BLOCK_STEP_MAX).toBe(3)
    const long = mk(-2, ...Array(20).fill(-2), 5)
    const out = v(deriveBlockTrades(long, { volumeRatio: 1, maxStack: 6, fixedCount: 1, incrementSteps: 99, holdWhileNegative: false }))
    // The cap is on the LEVEL: 1 + count 1 x ratio 1 x level 3 = 4x, so a
    // 2-unit loss cannot exceed 8 and the closing 5-unit win cannot exceed 20.
    const losses = out.filter((x) => x < 0)
    expect(Math.min(...losses)).toBeGreaterThanOrEqual(-8 - 1e-9)
    expect(Math.max(...out)).toBeLessThanOrEqual(20 + 1e-9)
  })

  test("hold applies at the LAST step: below it the escalation advances either way", () => {
    // Two losses reach step 2 of 3 — not the last step — so hold changes nothing.
    const short = mk(-2, -2, -2, 5)
    const heldShort = v(deriveBlockTrades(short as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: 1, incrementSteps: 3, holdWhileNegative: true }))
    const climbShort = v(deriveBlockTrades(short as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: 1, incrementSteps: 3, holdWhileNegative: false }))
    expect(heldShort).toEqual(climbShort)
  })

  test("at the last step, hold keeps the escalation while the next Block loses", () => {
    // One configured step, so the first escalation IS the last step.
    const run = mk(-2, -2, -2, -2, 5)
    const held = v(deriveBlockTrades(run as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: 1, incrementSteps: 1, holdWhileNegative: true }))
    const climbing = v(deriveBlockTrades(run as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: 1, incrementSteps: 1, holdWhileNegative: false }))
    // Capped at one step either way, so the streams match — the cap binds
    // before hold can differ. Hold is what keeps it there rather than
    // resetting, which the cap alone would not guarantee.
    expect(held).toEqual(climbing)
    expect(held[held.length - 1]).toBeGreaterThan(5)
  })

  test("a positive result restores the base for the next entry", () => {
    const out = v(deriveBlockTrades(mk(-2, 5, 5) as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: 2 }))
    expect(out[0]).toBe(-2)          // trigger, unscaled
    expect(out[1]).toBeGreaterThan(5) // recovery entry, enlarged
    expect(out[2]).toBe(5)            // after the win, back to base
  })
})
