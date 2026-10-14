/**
 * One definition per statistic (operator decision 2026-10-14): venue-net,
 * win rate without break-evens, profit factor without a 999 sentinel,
 * percentages within 0–100, counters that never go backwards within a run,
 * and one value per statistic across the progression stats payload.
 */
import {
  canonicalizeProgressionStats,
  clampPct,
  closedWindowStats,
  monotonic,
  pct,
  profitFactor,
  profitFactorOf,
  resetMonotonicForTests,
  winRatePct,
} from "@/lib/stats-canonical"

describe("canonical statistics", () => {
  beforeEach(() => resetMonotonicForTests())

  test("win rate excludes break-evens and is null without a decided trade", () => {
    expect(winRatePct(3, 1)).toBe(75)
    expect(winRatePct(0, 0)).toBeNull()
    expect(winRatePct(2, 0)).toBe(100)
    expect(winRatePct(-1, 4)).toBe(0)
  })

  test("profit factor is gross profit / gross loss; infinite instead of a 999 sentinel", () => {
    expect(profitFactor(30, 10)).toEqual({ value: 3, infinite: false })
    expect(profitFactor(30, 0)).toEqual({ value: null, infinite: true })
    expect(profitFactor(0, 0)).toEqual({ value: null, infinite: false })
    expect(profitFactorOf([10, -5, 0, 5])).toEqual({ value: 3, infinite: false })
  })

  test("percentages are finite, clamped to 0..100 and null on an empty total", () => {
    expect(pct(5, 10)).toBe(50)
    expect(pct(15, 10)).toBe(100)
    expect(pct(1, 0)).toBeNull()
    expect(clampPct("NaN")).toBeNull()
    expect(clampPct(140)).toBe(100)
    expect(clampPct(-3)).toBe(0)
  })

  test("a counter never goes backwards within a run and restarts with a new run", () => {
    expect(monotonic("c1:cycles", "run-1", 10)).toBe(10)
    expect(monotonic("c1:cycles", "run-1", 4)).toBe(10)
    expect(monotonic("c1:cycles", "run-1", 12)).toBe(12)
    expect(monotonic("c1:cycles", "run-2", 3)).toBe(3)
  })

  test("closed windows count venue-net results, newest first", () => {
    const rows = [{ realizedPnL: 2 }, { realized_pnl: -1 }, { pnl: 0 }, { realizedPnL: 4 }]
    expect(closedWindowStats(rows)).toMatchObject({ trades: 4, wins: 2, losses: 1, winRate: 66.7, profitFactor: { value: 6 } })
    expect(closedWindowStats(rows, 2)).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 50, profitFactor: { value: 2 } })
  })

  test("every block of the stats payload shows the same open count, win rate, PF and PnL", () => {
    const body = canonicalizeProgressionStats({
      openPositions: { live: { open: 3 } },
      liveExecution: { openPositions: 5, wins: 6, losses: 2, breakEven: 4, realizedPnl: 12.5, avgWin: 3, avgLoss: -2.75 },
      performanceTiers: { live: { totalRunning: 9, totalPnl: 1, winRate: 50, avgProfitFactor: 999 } },
      strategyDetail: { live: { openPositions: 7, setsRunningNow: 7, winRate: 37.5, avgProfitFactor: 999, totalPnl: 2, passRatio: 140, evalPct: 50 } },
      realtime: { positions: { open: 8, winRate: { all: 37.5 }, profitFactor: { all: 999 } }, successRate: 250 },
      cycleSuccessRate: Number.NaN,
    } as any)
    // wins 6, losses 2 (break-evens excluded): 75 %; PF 18 / 5.5
    for (const open of [body.openPositions.live.open, body.liveExecution.openPositions, body.performanceTiers.live.totalRunning,
      body.strategyDetail.live.openPositions, body.strategyDetail.live.setsRunningNow, body.realtime.positions.open]) {
      expect(open).toBe(3)
    }
    expect(body.liveExecution.pendingEntries).toBe(2)
    for (const winRate of [body.liveExecution.winRate, body.performanceTiers.live.winRate, body.strategyDetail.live.winRate,
      body.realtime.positions.winRate.all]) {
      expect(winRate).toBe(75)
    }
    for (const value of [body.liveExecution.profitFactor, body.performanceTiers.live.avgProfitFactor,
      body.strategyDetail.live.avgProfitFactor, body.realtime.positions.profitFactor.all]) {
      expect(value).toBeCloseTo(18 / 5.5, 3)
    }
    expect(body.strategyDetail.live.avgProfitFactorR).toBe(999)
    expect(body.performanceTiers.live.totalPnl).toBe(12.5)
    expect(body.strategyDetail.live.totalPnl).toBe(12.5)
    expect(body.strategyDetail.live.passRatio).toBe(100)
    expect(body.realtime.successRate).toBe(100)
    expect(body.cycleSuccessRate).toBeNull()
    expect(body.dataIntegrity).toEqual({ violations: [], consistent: true })
  })

  test("a negative counter is reported, not hidden", () => {
    const body = canonicalizeProgressionStats({ liveExecution: { wins: 0, losses: 0 }, realtime: { indicationCycles: -4 } } as any, ["base.passed (5) > base.evaluated (3)"])
    expect(body.dataIntegrity.consistent).toBe(false)
    expect(body.dataIntegrity.violations).toEqual(expect.arrayContaining([
      "base.passed (5) > base.evaluated (3)",
      "realtime.indicationCycles=-4 is negative",
    ]))
  })
})
