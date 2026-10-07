/**
 * View model of the "Real results" card: the settled exchange results of one
 * window of `/api/results/book` (lib/results/ledger.ts ResultBook), formatted
 * for display. Pure, so the figures are testable without rendering.
 */

/** Subset of `ResultBook` the card shows. */
export interface ResultBookWindow {
  settled: number
  accountingPending: number
  wins: number
  losses: number
  net: number
  fees: number
  profitFactor: number | null
  winRate: number | null
  hours?: { active: number; profitable: number; losing: number; profitableShare: number | null; closesPerActiveHour: number | null }
}

export interface ResultBookResponse {
  ready: boolean
  coverage?: { entries: number; remaining: number }
  windows?: Record<string, ResultBookWindow>
}

export type MetricTone = "good" | "warn" | "bad"

export interface ResultMetric {
  label: string
  value: string
  tone?: MetricTone
  title?: string
}

export type RealResultsView =
  | { state: "loading" | "error" | "empty"; message: string }
  | { state: "ready"; metrics: ResultMetric[] }

const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`
const known = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value)

export function buildRealResultsView(
  data: ResultBookResponse | null,
  error: string | null,
  windowKey: string,
  settlementAsset = "USDT",
): RealResultsView {
  if (!data) return error ? { state: "error", message: `Results ledger ${error}.` } : { state: "loading", message: "Loading results…" }
  const book = data.windows?.[windowKey]
  if (!book || !(book.settled > 0)) {
    const parts = ["No settled real close in this window"]
    if (book && book.accountingPending > 0) parts.push(`${book.accountingPending} closed, accounting pending`)
    if (data.ready === false) parts.push(`ledger still building (${data.coverage?.remaining ?? 0} rows left)`)
    return { state: "empty", message: `${parts.join(" · ")}.` }
  }
  const pf = book.profitFactor
  const hours = book.hours
  const share = hours?.profitableShare
  return {
    state: "ready",
    metrics: [
      { label: "Trades", value: book.settled.toLocaleString("en-US"), title: `${book.wins} wins · ${book.losses} losses` },
      {
        label: "PF",
        value: known(pf) ? pf.toFixed(2) : book.wins > 0 ? "∞" : "—",
        tone: known(pf) ? (pf >= 1.3 ? "good" : pf >= 1 ? "warn" : "bad") : book.wins > 0 ? "good" : undefined,
        title: "Gross profit / gross loss of the settled closes (∞: no losing close yet)",
      },
      { label: "Win rate", value: known(book.winRate) ? `${book.winRate.toFixed(1)}%` : "—" },
      {
        label: `Net ${settlementAsset}`,
        value: signed(book.net),
        tone: book.net > 0 ? "good" : book.net < 0 ? "bad" : undefined,
        title: `Venue-net realized PnL; fees ${book.fees.toFixed(2)}`,
      },
      {
        label: "Profitable hours",
        value: hours && hours.active > 0 ? `${hours.profitable}/${hours.active}` : "—",
        tone: known(share) ? (share >= 60 ? "good" : share >= 50 ? "warn" : "bad") : undefined,
        title: "UTC clock hours with settled closes whose net was positive",
      },
      { label: "Hour share", value: known(share) ? `${share.toFixed(0)}%` : "—" },
      { label: "Closes / active h", value: known(hours?.closesPerActiveHour) ? (hours!.closesPerActiveHour as number).toFixed(1) : "—" },
      {
        label: "Accounting pending",
        value: book.accountingPending.toLocaleString("en-US"),
        title: "Closed rows whose realized PnL is not final yet; they are not valued",
      },
    ],
  }
}
