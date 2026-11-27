/**
 * Trade-simulation ledger.
 *
 * Pure bookkeeping for the multi-day trade simulation (scripts/simulate-trade-window.ts):
 * money per position, the minute-by-minute equity curve and the bucketed
 * ledger. Every function is linear in its input (positions x minutes at most,
 * with a running peak), so cost grows with the simulated window, not with its
 * square. Nothing here touches the venue, Redis or the engine state.
 */
import { profitFactorOf, winRatePct } from "@/lib/stats-canonical"

export const SIM_MINUTE_MS = 60_000

export interface SimPosition {
  /** Strategy family: normal, axis, block, trailing or dca. */
  family: string
  /** Sub-variant inside the family (indication type, DCA entry model, ...). */
  variant: string
  symbol: string
  direction: "long" | "short"
  openedAt: number
  closedAt: number
  entryPrice: number
  /** Net percent return of the stake after round-trip costs. */
  netPct: number
  /** Stake multiplier: Block volume, DCA exposure ratio. */
  mult: number
}

export interface SimLedgerOptions {
  startBalance: number
  stakeUsd: number
  /** Trading window start (exclusive of the first decision minute). */
  fromMs: number
  /** Trading window end; the last equity minute. */
  toMs: number
  /** Price of `symbol` for the minute bar starting at `barStartMs`, carried forward over gaps. */
  priceAt: (symbol: string, barStartMs: number) => number | undefined
}

export interface EquityRow {
  t: number
  balance: number
  equity: number
  open: number
  /** Gross stake exposure of the open positions (stake x multiplier), USD. */
  exposureUsd: number
  peakEquity: number
  drawdownPct: number
}

export function realizedUsd(position: SimPosition, stakeUsd: number): number {
  return stakeUsd * position.netPct * position.mult / 100
}

export function markUsd(position: SimPosition, price: number, stakeUsd: number): number {
  const side = position.direction === "long" ? 1 : -1
  return stakeUsd * position.mult * side * (price / position.entryPrice - 1)
}

/**
 * Equity curve, one row per minute from `fromMs + 1 minute` to `toMs`.
 *
 * Positions are swept once in open and close order and kept in an active set,
 * so each minute costs O(open positions) instead of O(all positions). The
 * running peak makes drawdown a single pass.
 */
export function buildEquitySeries(positions: readonly SimPosition[], options: SimLedgerOptions): EquityRow[] {
  const byOpen = [...positions].sort((a, b) => a.openedAt - b.openedAt)
  const byClose = [...positions].sort((a, b) => a.closedAt - b.closedAt)
  const active = new Set<SimPosition>()
  const rows: EquityRow[] = []
  let oi = 0
  let ci = 0
  let realized = 0
  let exposure = 0
  let peak = options.startBalance
  for (let t = options.fromMs + SIM_MINUTE_MS; t <= options.toMs; t += SIM_MINUTE_MS) {
    while (oi < byOpen.length && byOpen[oi].openedAt <= t) {
      const opened = byOpen[oi++]
      active.add(opened)
      exposure += options.stakeUsd * opened.mult
    }
    while (ci < byClose.length && byClose[ci].closedAt <= t) {
      const closed = byClose[ci++]
      realized += realizedUsd(closed, options.stakeUsd)
      if (active.delete(closed)) exposure -= options.stakeUsd * closed.mult
    }
    let unrealized = 0
    for (const position of active) {
      const price = options.priceAt(position.symbol, t - SIM_MINUTE_MS)
      if (price !== undefined) unrealized += markUsd(position, price, options.stakeUsd)
    }
    const balance = options.startBalance + realized
    const equity = balance + unrealized
    if (equity > peak) peak = equity
    rows.push({
      t,
      balance,
      equity,
      open: active.size,
      exposureUsd: active.size > 0 ? exposure : 0,
      peakEquity: peak,
      drawdownPct: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    })
  }
  return rows
}

export interface LedgerStats {
  opened: number
  closed: number
  open: number
  wins: number
  losses: number
  winRatePct: number | null
  netUsd: number
  grossWinUsd: number
  grossLossUsd: number
  profitFactor: { value: number | null; infinite: boolean }
  avgNetPct: number | null
  avgHoldMinutes: number | null
}

/** Statistics of positions closed inside [fromMs, toMs) (closed) and opened inside it (opened). */
/**
 * `inclusiveEnd` makes the window closed on the right (used for the last
 * bucket and the whole window, so a position that closes exactly at the window
 * end is booked rather than dropped). Inner buckets stay half-open [from, to).
 */
export function ledgerStats(
  positions: readonly SimPosition[],
  fromMs: number,
  toMs: number,
  stakeUsd: number,
  openAt: number = toMs,
  inclusiveEnd = false,
): LedgerStats {
  let opened = 0
  let closed = 0
  let open = 0
  const pnls: number[] = []
  let netPctSum = 0
  let holdSum = 0
  const inWindow = (t: number) => t >= fromMs && (inclusiveEnd ? t <= toMs : t < toMs)
  for (const position of positions) {
    if (inWindow(position.openedAt)) opened++
    if (position.openedAt <= openAt && position.closedAt > openAt) open++
    if (inWindow(position.closedAt)) {
      closed++
      pnls.push(realizedUsd(position, stakeUsd))
      netPctSum += position.netPct
      holdSum += (position.closedAt - position.openedAt) / SIM_MINUTE_MS
    }
  }
  let wins = 0
  let losses = 0
  let grossWin = 0
  let grossLoss = 0
  let net = 0
  for (const pnl of pnls) {
    net += pnl
    if (pnl > 0) { wins++; grossWin += pnl }
    else if (pnl < 0) { losses++; grossLoss -= pnl }
  }
  return {
    opened,
    closed,
    open,
    wins,
    losses,
    winRatePct: winRatePct(wins, losses),
    netUsd: net,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    profitFactor: profitFactorOf(pnls),
    avgNetPct: closed > 0 ? netPctSum / closed : null,
    avgHoldMinutes: closed > 0 ? holdSum / closed : null,
  }
}

export interface EquityStats {
  endBalance: number
  endEquity: number
  peakEquity: number
  maxDrawdownPct: number
  openAtEnd: number
  openPeak: number
  exposurePeakUsd: number
  exposureEndUsd: number
}

/** Max drawdown of a whole curve, measured from the running peak (single pass). */
export function equityStats(rows: readonly EquityRow[], startBalance: number): EquityStats {
  let peak = startBalance
  let maxDd = 0
  let openPeak = 0
  let exposurePeakUsd = 0
  for (const row of rows) {
    if (row.equity > peak) peak = row.equity
    const dd = peak > 0 ? ((peak - row.equity) / peak) * 100 : 0
    if (dd > maxDd) maxDd = dd
    if (row.open > openPeak) openPeak = row.open
    if (row.exposureUsd > exposurePeakUsd) exposurePeakUsd = row.exposureUsd
  }
  const last = rows[rows.length - 1]
  return {
    endBalance: last ? last.balance : startBalance,
    endEquity: last ? last.equity : startBalance,
    peakEquity: last ? last.peakEquity : startBalance,
    maxDrawdownPct: maxDd,
    openAtEnd: last ? last.open : 0,
    openPeak,
    exposurePeakUsd,
    exposureEndUsd: last ? last.exposureUsd : 0,
  }
}

export interface BucketRow {
  index: number
  fromMs: number
  toMs: number
  equityEnd: number
  balanceEnd: number
  /** Most positions open at any minute inside the bucket. */
  openPeak: number
  /** Largest gross stake exposure at any minute inside the bucket, USD. */
  exposurePeakUsd: number
  /** Deepest drawdown from the running peak at any minute inside the bucket. */
  maxDrawdownPct: number
  /** Drawdown from the running peak at the bucket end. */
  drawdownAtEndPct: number
  stats: LedgerStats
  cumulative: LedgerStats
}

/**
 * Bucketed ledger: one row per `bucketMs` slice of [fromMs, toMs).
 *
 * `cumulative` reports the same measures from `fromMs` to the bucket end, so
 * the last row equals the whole-window totals.
 */
export function bucketLedger(
  positions: readonly SimPosition[],
  series: readonly EquityRow[],
  fromMs: number,
  toMs: number,
  bucketMs: number,
  stakeUsd: number,
  startBalance: number,
): BucketRow[] {
  const rows: BucketRow[] = []
  let cursor = 0
  let lastRow: EquityRow | undefined
  // Series rows are sorted by minute; one cursor walks them once for all buckets.
  for (let from = fromMs; from < toMs; from += bucketMs) {
    const to = Math.min(toMs, from + bucketMs)
    const isLast = to >= toMs
    let maxDd = 0
    let openPeak = 0
    let exposurePeak = 0
    while (cursor < series.length && series[cursor].t <= to) {
      const row = series[cursor++]
      if (row.drawdownPct > maxDd) maxDd = row.drawdownPct
      if (row.open > openPeak) openPeak = row.open
      if (row.exposureUsd > exposurePeak) exposurePeak = row.exposureUsd
      lastRow = row
    }
    rows.push({
      index: rows.length,
      fromMs: from,
      toMs: to,
      equityEnd: lastRow ? lastRow.equity : startBalance,
      balanceEnd: lastRow ? lastRow.balance : startBalance,
      openPeak,
      exposurePeakUsd: exposurePeak,
      maxDrawdownPct: maxDd,
      drawdownAtEndPct: lastRow ? lastRow.drawdownPct : 0,
      stats: ledgerStats(positions, from, to, stakeUsd, to, isLast),
      cumulative: ledgerStats(positions, fromMs, to, stakeUsd, to, isLast),
    })
  }
  return rows
}
