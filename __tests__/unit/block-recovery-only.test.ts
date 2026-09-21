import { deriveBlockTrades } from "@/lib/historic-test-family-derivations"

const stream = (...results: number[]) =>
  results.map((signedResultR, i) => ({ signedResultR, openedAt: i * 1000, closedAt: i * 1000 + 500 }))
const values = (rows: readonly any[]) => rows.map((r) => Number(r.signedResultR.toFixed(6)))

describe("Block enlarges recovery entries only", () => {
  test("a loss is never enlarged — it is what starts the recovery", () => {
    for (const fixedCount of [undefined, 1, 2, 3]) {
      const out = deriveBlockTrades(stream(5, 5, -2, 5, 5) as any, {
        volumeRatio: 0.2, incrementSteps: 3, maxStack: 3, ...(fixedCount ? { fixedCount } : {}),
      })
      expect([fixedCount, values(out)[2]]).toEqual([fixedCount, -2])
    }
  })

  test("entries after a win run at base size, with and without a fixed count", () => {
    expect(values(deriveBlockTrades(stream(5, 5, -2, 5, 5) as any, { volumeRatio: 0.2, incrementSteps: 3, maxStack: 3 })))
      .toEqual([5, 5, -2, 6, 5])
    // The regression: a fixed count used to multiply EVERY trade, producing
    // 7, 7, -2.8, 7, 7 — a constant leverage, not a recovery mechanism.
    expect(values(deriveBlockTrades(stream(5, 5, -2, 5, 5) as any, { volumeRatio: 0.2, incrementSteps: 3, maxStack: 3, fixedCount: 2 })))
      .toEqual([5, 5, -2, 7, 5])
  })

  test("the first entry of a stream is never a recovery entry", () => {
    for (const fixedCount of [1, 3]) {
      const out = deriveBlockTrades(stream(5, 5) as any, { volumeRatio: 0.5, incrementSteps: 3, maxStack: 3, fixedCount })
      expect([fixedCount, values(out)]).toEqual([fixedCount, [5, 5]])
    }
  })

  test("a fixed count still sizes its own lane — higher counts recover harder", () => {
    const at = (fixedCount: number) => values(deriveBlockTrades(
      stream(-2, 5) as any, { volumeRatio: 0.2, incrementSteps: 3, maxStack: 6, fixedCount },
    ))[1]
    expect(at(1)).toBeLessThan(at(2))
    expect(at(2)).toBeLessThan(at(3))
  })

  test("a loss run escalates, and a larger recovery entry that also loses loses more", () => {
    const out = values(deriveBlockTrades(stream(-2, -2, -2, 5) as any, {
      volumeRatio: 0.2, incrementSteps: 3, maxStack: 3, fixedCount: 1,
    }))
    // Only the FIRST loss is unscaled — it is the trigger. Every entry after
    // it is a recovery entry and carries the larger size whether it wins or
    // loses, which is precisely the risk the strategy takes on.
    expect(out[0]).toBe(-2)
    expect(out[1]).toBeLessThan(-2)
    expect(out[2]).toBeLessThan(out[1])
    expect(out[3]).toBeGreaterThan(5)
  })
})
