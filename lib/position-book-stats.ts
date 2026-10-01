/**
 * Independent position-book statistics.
 *
 * Real (exchange-confirmed) and simulated (paper / FORCE_SIMULATED /
 * simulated-connector) positions are aggregated into separate books by the
 * single shared predicate in `live-position-source`. A simulated result can
 * never enter real counts, PnL or PF, and vice versa.
 */
import {
  resolveConfirmedPositionQuantity,
  resolveKnownPositionCosts,
  resolvePositionNotionalUsd,
  resolveSettledRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { getLivePositionSource, type LivePositionSource } from "@/lib/live-position-source"
import { isLiveOpenStatus } from "@/lib/live-position-status"

export interface PositionBookBucket {
  open: number
  closed: number
  wins: number
  losses: number
  netPnl: number
}

export interface PositionBookStats {
  total: number
  open: number
  closed: number
  /** Closed rows whose realized result is settled (enters W/L/PF). */
  settledClosed: number
  accountingPending: number
  wins: number
  losses: number
  breakEven: number
  /** Percent of decided (win+loss) trades; 0 when none are decided. */
  winRate: number
  grossProfit: number
  grossLoss: number
  /** Realized PnL before known costs (net + fees/funding). */
  grossPnl: number
  fees: number
  /** Realized PnL after known costs. */
  netPnl: number
  unrealizedPnl: number
  totalPnl: number
  /** grossProfit / grossLoss; null when there are no losses (see profitFactorUnbounded). */
  profitFactor: number | null
  /** True when there are winning trades but no losing trade (PF = infinity). */
  profitFactorUnbounded: boolean
  avgWin: number
  avgLoss: number
  largestWin: number
  largestLoss: number
  /** Peak-to-trough decline of cumulative realized net PnL, as positive USD. */
  maxDrawdown: number
  openNotionalUsd: number
  openSymbols: number
  bySymbol: Record<string, PositionBookBucket>
  byStrategy: Record<string, PositionBookBucket>
  /** UTC close hour (0-23) for closed rows; open rows are not bucketed. */
  byHour: Record<string, PositionBookBucket>
}

export interface SplitPositionBookStats {
  real: PositionBookStats
  simulated: PositionBookStats
  unknown: PositionBookStats
}

type Row = Record<string, any>

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n < 10_000_000_000 ? n * 1000 : n
    return 0
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function closedTimestamp(position: Row): number {
  return timestampMs(
    position.closedAt ?? position.closed_at ?? position.exitTime ?? position.exit_time ??
    position.updatedAt ?? position.updated_at,
  )
}

export function positionStrategyFamily(position: Row): string {
  const raw = String(
    position.executionIntent ?? position.strategyFamily ?? position.strategy ??
    position.indicationType ?? position.source ?? "",
  ).trim().toLowerCase()
  if (raw.includes("direct")) return "direct"
  if (raw.includes("signal")) return "signal"
  if (raw.includes("preset")) return "preset"
  if (raw.includes("main")) return "main"
  if (position.presetId) return "preset"
  if (position.setKey || position.parentSetKey) return "main"
  return raw || "unknown"
}

function isClosedRow(position: Row): boolean {
  return String(position.status || "").trim().toLowerCase() === "closed"
    && (resolveConfirmedPositionQuantity(position, true) ?? 0) > 0
}

function isOpenRow(position: Row): boolean {
  return String(position.status || "").trim().toLowerCase() !== "closed"
    && isLiveOpenStatus(position.status)
    && (resolveConfirmedPositionQuantity(position) ?? 0) > 0
}

/**
 * Book state of a row: executed open exposure, executed closed lifecycle, or
 * null (pending/rejected/never filled). Lists shown next to book counters must
 * use this same classifier so counters always equal list lengths.
 */
export function positionBookRowState(position: Row | null | undefined): "open" | "closed" | null {
  if (!position || typeof position !== "object") return null
  if (isClosedRow(position)) return "closed"
  if (isOpenRow(position)) return "open"
  return null
}

function emptyBucket(): PositionBookBucket {
  return { open: 0, closed: 0, wins: 0, losses: 0, netPnl: 0 }
}

function bucket(map: Record<string, PositionBookBucket>, key: string): PositionBookBucket {
  const k = key || "unknown"
  if (!map[k]) map[k] = emptyBucket()
  return map[k]
}

export function emptyPositionBookStats(): PositionBookStats {
  return computePositionBookStats([])
}

/** Aggregate one book. Callers must pass rows of a single source only. */
export function computePositionBookStats(positions: Row[]): PositionBookStats {
  const bySymbol: Record<string, PositionBookBucket> = {}
  const byStrategy: Record<string, PositionBookBucket> = {}
  const byHour: Record<string, PositionBookBucket> = {}
  const openSymbols = new Set<string>()
  const settled: Array<{ at: number; pnl: number }> = []
  let open = 0
  let closed = 0
  let accountingPending = 0
  let wins = 0
  let losses = 0
  let breakEven = 0
  let grossProfit = 0
  let grossLoss = 0
  let fees = 0
  let netPnl = 0
  let unrealizedPnl = 0
  let openNotionalUsd = 0
  let largestWin = 0
  let largestLoss = 0

  for (const position of Array.isArray(positions) ? positions : []) {
    if (!position || typeof position !== "object") continue
    const symbol = String(position.symbol || "unknown").trim().toUpperCase() || "UNKNOWN"
    const strategy = positionStrategyFamily(position)
    if (isClosedRow(position)) {
      closed++
      const pnl = resolveSettledRealizedPnl(position)
      const sym = bucket(bySymbol, symbol)
      const strat = bucket(byStrategy, strategy)
      sym.closed++
      strat.closed++
      if (pnl === undefined) {
        accountingPending++
        continue
      }
      const at = closedTimestamp(position)
      const hour = bucket(byHour, at > 0 ? String(new Date(at).getUTCHours()) : "unknown")
      hour.closed++
      settled.push({ at, pnl })
      netPnl += pnl
      fees += resolveKnownPositionCosts(position)
      for (const b of [sym, strat, hour]) b.netPnl += pnl
      if (pnl > 0) {
        wins++
        grossProfit += pnl
        largestWin = Math.max(largestWin, pnl)
        for (const b of [sym, strat, hour]) b.wins++
      } else if (pnl < 0) {
        losses++
        grossLoss += -pnl
        largestLoss = Math.min(largestLoss, pnl)
        for (const b of [sym, strat, hour]) b.losses++
      } else {
        breakEven++
      }
    } else if (isOpenRow(position)) {
      open++
      openSymbols.add(symbol)
      bucket(bySymbol, symbol).open++
      bucket(byStrategy, strategy).open++
      unrealizedPnl += resolveUnrealizedPnl(position) ?? 0
      const qty = resolveConfirmedPositionQuantity(position) ?? 0
      if (qty > 0) {
        const entry = Number(position.averageExecutionPrice ?? position.entryPrice) || 0
        const notional = resolvePositionNotionalUsd(position, qty, entry)
        if (Number.isFinite(notional)) openNotionalUsd += Math.abs(notional)
      }
    }
  }

  // Drawdown over realized equity in close order (unknown timestamps first,
  // stable by input order).
  settled.sort((a, b) => a.at - b.at)
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  for (const row of settled) {
    equity += row.pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }

  const decided = wins + losses
  const roundBuckets = (map: Record<string, PositionBookBucket>) => {
    for (const b of Object.values(map)) b.netPnl = round(b.netPnl)
    return map
  }
  return {
    total: open + closed,
    open,
    closed,
    settledClosed: settled.length,
    accountingPending,
    wins,
    losses,
    breakEven,
    winRate: decided > 0 ? round((wins / decided) * 100, 4) : 0,
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    grossPnl: round(netPnl + fees),
    fees: round(fees),
    netPnl: round(netPnl),
    unrealizedPnl: round(unrealizedPnl),
    totalPnl: round(netPnl + unrealizedPnl),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 6) : null,
    profitFactorUnbounded: grossLoss === 0 && grossProfit > 0,
    avgWin: wins > 0 ? round(grossProfit / wins) : 0,
    avgLoss: losses > 0 ? round(-grossLoss / losses) : 0,
    largestWin: round(largestWin),
    largestLoss: round(largestLoss),
    maxDrawdown: round(maxDrawdown),
    openNotionalUsd: round(openNotionalUsd),
    openSymbols: openSymbols.size,
    bySymbol: roundBuckets(bySymbol),
    byStrategy: roundBuckets(byStrategy),
    byHour: roundBuckets(byHour),
  }
}

/** Split rows by the shared source predicate and aggregate each book separately. */
export function splitPositionBookStats(positions: Row[]): SplitPositionBookStats {
  const lanes: Record<LivePositionSource, Row[]> = { real: [], simulated: [], unknown: [] }
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!position || typeof position !== "object") continue
    lanes[getLivePositionSource(position)].push(position)
  }
  return {
    real: computePositionBookStats(lanes.real),
    simulated: computePositionBookStats(lanes.simulated),
    unknown: computePositionBookStats(lanes.unknown),
  }
}

/** Sum books from several connections (drawdown/PF recomputed conservatively). */
export function mergePositionBookStats(
  input: Array<PositionBookStats | null | undefined>,
): PositionBookStats {
  const books = (Array.isArray(input) ? input : []).filter(
    (book): book is PositionBookStats => Boolean(book && typeof book === "object"),
  )
  const out = emptyPositionBookStats()
  const addMap = (target: Record<string, PositionBookBucket>, src: Record<string, PositionBookBucket>) => {
    for (const [k, b] of Object.entries(src)) {
      const t = bucket(target, k)
      t.open += b.open; t.closed += b.closed; t.wins += b.wins; t.losses += b.losses
      t.netPnl = round(t.netPnl + b.netPnl)
    }
  }
  let symbolsUpper = 0
  for (const b of books) {
    out.open += b.open; out.closed += b.closed; out.settledClosed += b.settledClosed
    out.accountingPending += b.accountingPending
    out.wins += b.wins; out.losses += b.losses; out.breakEven += b.breakEven
    out.grossProfit += b.grossProfit; out.grossLoss += b.grossLoss; out.fees += b.fees
    out.netPnl += b.netPnl; out.unrealizedPnl += b.unrealizedPnl
    out.openNotionalUsd += b.openNotionalUsd
    // Drawdowns of independent connections are summed as an upper bound.
    out.maxDrawdown += b.maxDrawdown
    out.largestWin = Math.max(out.largestWin, b.largestWin)
    out.largestLoss = Math.min(out.largestLoss, b.largestLoss)
    symbolsUpper += b.openSymbols
    addMap(out.bySymbol, b.bySymbol); addMap(out.byStrategy, b.byStrategy); addMap(out.byHour, b.byHour)
  }
  const decided = out.wins + out.losses
  out.total = out.open + out.closed
  out.openSymbols = symbolsUpper
  out.winRate = decided > 0 ? round((out.wins / decided) * 100, 4) : 0
  for (const f of ["grossProfit", "grossLoss", "fees", "netPnl", "unrealizedPnl", "openNotionalUsd", "maxDrawdown"] as const) {
    out[f] = round(out[f])
  }
  out.grossPnl = round(out.netPnl + out.fees)
  out.totalPnl = round(out.netPnl + out.unrealizedPnl)
  out.profitFactor = out.grossLoss > 0 ? round(out.grossProfit / out.grossLoss, 6) : null
  out.profitFactorUnbounded = out.grossLoss === 0 && out.grossProfit > 0
  out.avgWin = out.wins > 0 ? round(out.grossProfit / out.wins) : 0
  out.avgLoss = out.losses > 0 ? round(-out.grossLoss / out.losses) : 0
  return out
}

/**
 * Simulated (paper) rows are not results of the system: their pnl is a calculation,
 * not an executed order. On X02 their sum was -14.5 billion (10,491 rows, no regard for
 * the balance), and it reached the dashboard, the statistics page and every overview
 * as if it were a result. By default the simulated book is delivered WITHOUT valuation:
 * the activity counts stay, every money and ratio field is zero. CTS_SIMULATED_BOOK_VALUATION=1
 * restores the full book (diagnosis only).
 */
export function simulatedBookValuationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CTS_SIMULATED_BOOK_VALUATION === "1"
}

export function withoutBookValuation(book: PositionBookStats): PositionBookStats {
  return {
    ...emptyPositionBookStats(),
    total: book.total,
    open: book.open,
    closed: book.closed,
    settledClosed: 0,
    accountingPending: 0,
    openSymbols: book.openSymbols,
  }
}

export function simulatedBookForDisplay(book: PositionBookStats, env: Record<string, string | undefined> = process.env): PositionBookStats {
  return simulatedBookValuationEnabled(env) ? book : withoutBookValuation(book)
}
