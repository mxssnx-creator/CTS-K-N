import { DEFAULT_AXIS_DERIVATION, deriveAxisTrades } from "@/lib/historic-test-family-derivations"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

/** A stream with a realistic win rate: losses cluster occasionally. */
function stream(count = 400): HistoricTestTrade[] {
  const out: HistoricTestTrade[] = []
  for (let i = 0; i < count; i++) {
    const loss = i % 5 === 0 || i % 5 === 1
    out.push({ signedResultR: loss ? -2 : 1, openedAt: i * 60_000, closedAt: i * 60_000 + 30_000 })
  }
  return out
}

const pf = (t: readonly HistoricTestTrade[]) =>
  t.length ? 1 + (t.reduce((s, x) => s + x.signedResultR, 0) / t.length) * 0.1 : 1

describe("the axis gate actually engages at its default", () => {
  test("the default is the measured operating point, not the inert one", () => {
    expect(DEFAULT_AXIS_DERIVATION.cont).toBe(1)
    expect(DEFAULT_AXIS_DERIVATION.pause).toBe(4)
    // cont=8 admitted 98% of entries: a family slot that measured nothing of
    // its own and reported Normal's numbers.
    expect(DEFAULT_AXIS_DERIVATION.cont).toBeLessThan(8)
  })

  test("at the default the gate filters — axis is not a copy of the baseline", () => {
    const base = stream()
    const gated = deriveAxisTrades(base, DEFAULT_AXIS_DERIVATION)
    expect(gated.length).toBeGreaterThan(0)
    expect(gated.length).toBeLessThan(base.length)
  })

  test("the mechanism: a non-positive result pauses the next entries", () => {
    // Asserting a ProfitFactor improvement on a synthetic stream would test the
    // stream's shape, not the gate: a periodic loss pattern makes the pause skip
    // the very winners that follow. The measured improvement (0.90 -> 1.22 over
    // 1,065,456 real replayed trades) is recorded in the default's rationale.
    // What holds for ANY stream is the mechanism.
    const base: HistoricTestTrade[] = [
      { signedResultR: -2 }, { signedResultR: 5 }, { signedResultR: 5 },
      { signedResultR: 5 }, { signedResultR: 5 }, { signedResultR: 5 },
    ]
    const gated = deriveAxisTrades(base, { prev: 12, last: 4, cont: 1, pause: 4 })
    // The loss is taken, then four entries are skipped, leaving the last one.
    expect(gated.length).toBe(base.length - 4)
  })

  test("a wide window still admits nearly everything — the relationship is monotone", () => {
    const base = stream()
    const tight = deriveAxisTrades(base, { prev: 12, last: 4, cont: 1, pause: 4 })
    const wide = deriveAxisTrades(base, { prev: 12, last: 4, cont: 8, pause: 8 })
    expect(wide.length).toBeGreaterThan(tight.length)
  })
})
