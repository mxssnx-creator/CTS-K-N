import { applyBaseGate, BACKTEST_BASE_GATE, type BacktestTrade } from "@/lib/connection-backtest"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { explainBaseGate } from "@/lib/trade-simulation/gate-explain"
import {
  SIM_MINUTE_MS,
  bucketLedger,
  buildEquitySeries,
  equityStats,
  ledgerStats,
  markUsd,
  realizedUsd,
  type SimPosition,
} from "@/lib/trade-simulation/ledger"

const MIN = SIM_MINUTE_MS
const START = 1000
const STAKE = 10
const FROM = Date.parse("2026-11-22T00:00:00Z")
const TO = FROM + 6 * 60 * MIN

/** Deterministic pseudo-random source so every run sees the same positions. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function randomPositions(count: number, seed: number): SimPosition[] {
  const next = rng(seed)
  const out: SimPosition[] = []
  for (let i = 0; i < count; i++) {
    const openedAt = FROM - 30 * MIN + Math.floor(next() * (TO - FROM + 30 * MIN) / MIN) * MIN
    const closedAt = openedAt + (1 + Math.floor(next() * 90)) * MIN
    out.push({
      family: "normal",
      variant: "trend",
      symbol: next() < 0.5 ? "BTC-USDT" : "ETH-USDT",
      direction: next() < 0.5 ? "long" : "short",
      openedAt,
      closedAt,
      entryPrice: 100 + next() * 10,
      netPct: (next() - 0.45) * 2,
      mult: 0.5 + next(),
    })
  }
  return out
}

/** Prices move on a deterministic path; gaps (undefined) appear at a fixed minute. */
function priceFor(symbol: string, barStart: number): number | undefined {
  const minute = Math.round((barStart - FROM) / MIN)
  if (symbol === "ETH-USDT" && minute === 100) return undefined
  return 100 + 5 * Math.sin(minute / 17) + (symbol === "ETH-USDT" ? 1 : 0)
}

/** The original O(minutes × positions) reference: every minute scans every position. */
function naiveSeries(positions: SimPosition[]) {
  const rows: { t: number; balance: number; equity: number; open: number }[] = []
  for (let t = FROM + MIN; t <= TO; t += MIN) {
    let balance = START
    let unrealized = 0
    let open = 0
    for (const p of positions) {
      if (p.closedAt <= t) balance += realizedUsd(p, STAKE)
      else if (p.openedAt <= t) {
        open++
        const price = priceFor(p.symbol, t - MIN)
        if (price !== undefined) unrealized += markUsd(p, price, STAKE)
      }
    }
    rows.push({ t, balance, equity: balance + unrealized, open })
  }
  return rows
}

describe("trade simulation ledger", () => {
  const options = { startBalance: START, stakeUsd: STAKE, fromMs: FROM, toMs: TO, priceAt: priceFor }

  test("the linear equity sweep matches the per-minute reference exactly", () => {
    const positions = randomPositions(400, 7)
    const fast = buildEquitySeries(positions, options)
    const slow = naiveSeries(positions)
    expect(fast).toHaveLength(slow.length)
    for (let i = 0; i < slow.length; i++) {
      expect(fast[i].t).toBe(slow[i].t)
      expect(fast[i].balance).toBeCloseTo(slow[i].balance, 9)
      expect(fast[i].equity).toBeCloseTo(slow[i].equity, 9)
      expect(fast[i].open).toBe(slow[i].open)
    }
  })

  test("exposure equals the stake times multiplier of the positions open at each minute", () => {
    const positions = randomPositions(300, 19)
    const rows = buildEquitySeries(positions, options)
    for (const row of rows.filter((_, i) => i % 37 === 0)) {
      const direct = positions
        .filter((p) => p.openedAt <= row.t && p.closedAt > row.t)
        .reduce((sum, p) => sum + STAKE * p.mult, 0)
      expect(row.exposureUsd).toBeCloseTo(direct, 6)
    }
    expect(rows.every((r) => r.exposureUsd >= -1e-9)).toBe(true)
  })

  test("drawdown is measured from the running peak in one pass", () => {
    const positions = randomPositions(300, 11)
    const rows = buildEquitySeries(positions, options)
    let peak = START
    let maxDd = 0
    for (const r of rows) {
      peak = Math.max(peak, r.equity)
      maxDd = Math.max(maxDd, peak > 0 ? ((peak - r.equity) / peak) * 100 : 0)
    }
    expect(equityStats(rows, START).maxDrawdownPct).toBeCloseTo(maxDd, 9)
  })

  test("bucket closes add up to the window totals and the cumulative view ends on them", () => {
    const positions = randomPositions(500, 23)
    const rows = buildEquitySeries(positions, options)
    const bucketMs = 2 * 60 * MIN
    const buckets = bucketLedger(positions, rows, FROM, TO, bucketMs, STAKE, START)
    expect(buckets).toHaveLength(3)
    const closedInBuckets = buckets.reduce((sum, b) => sum + b.stats.closed, 0)
    const whole = ledgerStats(positions, FROM, TO, STAKE, TO, true)
    expect(closedInBuckets).toBe(whole.closed)
    const last = buckets[buckets.length - 1].cumulative
    expect(last.closed).toBe(whole.closed)
    expect(last.netUsd).toBeCloseTo(whole.netUsd, 9)
    expect(buckets[buckets.length - 1].equityEnd).toBeCloseTo(rows[rows.length - 1].equity, 9)
  })

  test("a position that closes exactly at the window end is booked in the last bucket", () => {
    const edge: SimPosition[] = [{
      family: "normal", variant: "x", symbol: "BTC-USDT", direction: "long", openedAt: TO - 10 * MIN, closedAt: TO,
      entryPrice: 100, netPct: 0.5, mult: 1,
    }]
    const rows = buildEquitySeries(edge, options)
    const buckets = bucketLedger(edge, rows, FROM, TO, 3 * 60 * MIN, STAKE, START)
    expect(buckets.reduce((sum, b) => sum + b.stats.closed, 0)).toBe(1)
    expect(buckets[buckets.length - 1].stats.closed).toBe(1)
    expect(buckets[buckets.length - 1].stats.openAtEnd ?? 0).toBe(0)
    expect(equityStats(rows, START).openAtEnd).toBe(0)
  })

  test("profit factor is infinite without losses and absent without closes", () => {
    const winners: SimPosition[] = [{
      family: "normal", variant: "x", symbol: "BTC-USDT", direction: "long", openedAt: FROM, closedAt: FROM + 5 * MIN,
      entryPrice: 1, netPct: 1, mult: 1,
    }]
    const won = ledgerStats(winners, FROM, TO, STAKE, TO)
    expect(won.profitFactor).toEqual({ value: null, infinite: true })
    expect(ledgerStats([], FROM, TO, STAKE, TO).profitFactor).toEqual({ value: null, infinite: false })
  })
})

describe("base gate explanation", () => {
  /** Random candidates across a few buckets, with PF and costs in the range the engine produces. */
  function candidates(count: number, seed: number): BacktestTrade[] {
    const next = rng(seed)
    const types = ["trend", "move", "direction"]
    const out: BacktestTrade[] = []
    for (let i = 0; i < count; i++) {
      const entryTime = FROM - 2 * 60 * MIN + Math.floor(next() * 600) * MIN
      const duration = (1 + Math.floor(next() * 60)) * MIN
      out.push({
        symbol: next() < 0.5 ? "BTC-USDT" : "SOL-USDT",
        type: types[Math.floor(next() * types.length)],
        direction: next() < 0.5 ? "long" : "short",
        rule: next() < 0.5 ? "tf5" : "default",
        entryTime,
        exitTime: entryTime + duration,
        entryPrice: 100,
        exitPrice: 100,
        takeProfitPct: 0.5,
        stopLossPct: 0.3,
        grossPct: (next() - 0.4) * 1.2,
        costPct: 0.15,
        netPct: (next() - 0.4) * 1.2 - 0.15,
        reason: "take_profit",
        exitLeg: "taker",
        profitFactor: 0.9 + next() * 1.2,
      } as BacktestTrade)
    }
    return out
  }

  test("explanation admits exactly the candidates applyBaseGate admits in the window", () => {
    const all = candidates(900, 31)
    const fromMs = FROM
    const toMs = FROM + 12 * 60 * MIN
    const gate = applyBaseGate(all, 0.1, BACKTEST_BASE_GATE, movePctToMainTradePfRatio)
    const admittedInWindow = gate.admitted.filter((t) => t.entryTime >= fromMs && t.entryTime < toMs).length
    const cells = explainBaseGate(all, {
      positionCostPct: 0.1,
      gate: BACKTEST_BASE_GATE,
      toRatio: movePctToMainTradePfRatio,
      fromMs,
      toMs,
    })
    const explained = [...cells.values()].reduce((sum, c) => sum + c.admitted, 0)
    let callbackAdmitted = 0
    explainBaseGate(all, { positionCostPct: 0.1, gate: BACKTEST_BASE_GATE, toRatio: movePctToMainTradePfRatio, fromMs, toMs }, (_t, reason) => {
      if (reason === "admitted") callbackAdmitted++
    })
    expect(callbackAdmitted).toBe(explained)
    expect(explained).toBe(admittedInWindow)
    const reasons = [...cells.values()].reduce((sum, c) => sum + c.admitted + c.historyShort + c.pfBelowStage, 0)
    expect(reasons).toBe(all.filter((t) => t.entryTime >= fromMs && t.entryTime < toMs).length)
  })
})
