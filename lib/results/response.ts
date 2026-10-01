/**
 * Shapes the results ledger into the one results answer. Pure: the route only reads the
 * ledger and calls this.
 */
import { computeResultBook, groupResultBooks, type LedgerEntry, type ResultBook, type ResultLedger } from "@/lib/results/ledger"

const DAY = 86_400_000
export const RESULT_WINDOWS: Record<string, number | undefined> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, all: undefined }

/** Liquidation distance (100 / leverage, percent) against the stop: the stop can only act if it comes first. */
export function stopOrLiquidationFirst(e: LedgerEntry): string {
  if (!(e.lev > 0) || !(e.sl > 0)) return "unknown"
  return 100 / e.lev < e.sl ? "liquidation_before_stop" : "stop_first"
}

const GROUPS: Record<string, (e: LedgerEntry) => string> = {
  type: (e) => e.type,
  lane: (e) => e.lane,
  variant: (e) => e.variant,
  symbol: (e) => e.sym,
  reason: (e) => e.reason,
  direction: (e) => e.dir,
  intent: (e) => e.intent,
  risk: stopOrLiquidationFirst,
  leverage: (e) => (e.lev >= 300 ? ">=300x" : e.lev >= 150 ? "150-299x" : e.lev >= 75 ? "75-149x" : e.lev > 0 ? "<75x" : "unknown"),
  stop: (e) => (e.sl > 0 ? `${Math.round(e.sl * 10) / 10}%` : "unknown"),
}
export const RESULT_GROUPS = Object.keys(GROUPS)

export function buildResultsBookResponse(
  ledger: ResultLedger | null,
  query: { window?: string | null; group?: string | null },
  now: number = Date.now(),
) {
  const window = query.window && query.window in RESULT_WINDOWS ? query.window : "all"
  const group = query.group && query.group in GROUPS ? query.group : null
  if (!ledger) {
    return { success: true, ready: false, window, definition: DEFINITION, coverage: { complete: false, entries: 0, updatedAt: 0, keys: 0, remaining: 0 }, book: null, windows: {}, groups: null, funnel: {} }
  }
  const span = RESULT_WINDOWS[window]
  const since = span === undefined ? undefined : now - span
  const inWindow = since === undefined ? ledger.entries : ledger.entries.filter((e) => (e.status === "closed" ? e.closed : e.opened) >= since)
  const windows: Record<string, ResultBook> = {}
  for (const [name, ms] of Object.entries(RESULT_WINDOWS)) windows[name] = computeResultBook(ledger.entries, ms === undefined ? {} : { since: now - ms })
  const neverTraded = Object.entries(ledger.funnel).filter(([k]) => k.startsWith("never:")).reduce((s, [, c]) => s + c, 0)
  return {
    success: true,
    ready: ledger.meta.complete,
    window,
    definition: DEFINITION,
    coverage: { complete: ledger.meta.complete, entries: ledger.entries.length, updatedAt: ledger.meta.updatedAt, keys: ledger.meta.keys, remaining: ledger.meta.remaining, lag: ledger.meta.remaining },
    book: computeResultBook(inWindow),
    windows,
    groups: group ? groupResultBooks(inWindow, GROUPS[group]) : null,
    funnel: {
      executed: ledger.entries.length,
      neverTraded,
      simulated: ledger.funnel.simulated || 0,
      foreign: ledger.funnel.foreign || 0,
      neverTradedByReason: Object.fromEntries(Object.entries(ledger.funnel).filter(([k]) => k.startsWith("never:")).map(([k, c]) => [k.slice(6), c]).sort((a, b) => (b[1] as number) - (a[1] as number))),
    },
  }
}

const DEFINITION = "A result is a filled, real, own position (executedQuantity > 0, own tracking id, not simulated). Simulated rows, rows that never traded and rows of other systems are counted in the funnel and never in PnL, profit factor, win rate or trade counts. Settled = the realized pnl is final; closed rows without it are accounting pending and not valued."
