import { computeResultBook, type ResultLedger } from "@/lib/results/ledger"
import { calculateDrawdownTime } from "@/lib/live-trading-analytics"

/** Same window as the trade-history analytics' drawdown3d. */
export const DRAWDOWN_LOOKBACK_DAYS = 3

/**
 * Realized performance of one connection, computed from its results ledger:
 * filled, real, own positions whose pnl is settled (lib/results/ledger.ts).
 * Every figure is null when there is nothing to compute it from; `reason`
 * says why, so the UI never shows a fabricated 0.
 */
export interface EnginePerformance {
  source: "results-ledger"
  available: boolean
  /** The ledger backfill has covered every position key. */
  complete: boolean
  settledTrades: number
  accountingPending: number
  profitFactor: number | null
  /** Gross profit without any loss: PF is unbounded. */
  profitFactorInfinite: boolean
  winRate: number | null
  /** Deepest peak-to-trough of cumulative settled pnl (USDT) in the lookback. */
  maxDrawdownUsd: number | null
  /** Longest time below a previous pnl peak (minutes) in the lookback. */
  maxDrawdownMinutes: number | null
  drawdownLookbackDays: number
  reason: string | null
}

export function buildEnginePerformance(ledger: ResultLedger | null, now = Date.now()): EnginePerformance {
  const empty: EnginePerformance = {
    source: "results-ledger",
    available: false,
    complete: false,
    settledTrades: 0,
    accountingPending: 0,
    profitFactor: null,
    profitFactorInfinite: false,
    winRate: null,
    maxDrawdownUsd: null,
    maxDrawdownMinutes: null,
    drawdownLookbackDays: DRAWDOWN_LOOKBACK_DAYS,
    reason: "No results ledger for this connection yet",
  }
  if (!ledger) return empty

  const book = computeResultBook(ledger.entries)
  const settled = ledger.entries.filter(
    (entry) => entry.status === "closed" && entry.settled && entry.pnl !== null,
  )
  const drawdown = calculateDrawdownTime(
    settled.map((entry) => ({ realizedPnl: Number(entry.pnl), closedAt: entry.closed })),
    now,
    DRAWDOWN_LOOKBACK_DAYS,
  )
  const hasDrawdownSamples = drawdown.samples > 0

  return {
    ...empty,
    available: true,
    complete: ledger.meta.complete,
    settledTrades: book.settled,
    accountingPending: book.accountingPending,
    profitFactor: book.profitFactor,
    profitFactorInfinite: book.grossProfit > 0 && book.grossLoss === 0,
    winRate: book.winRate,
    maxDrawdownUsd: hasDrawdownSamples ? drawdown.maxDepth : null,
    maxDrawdownMinutes: hasDrawdownSamples ? Math.round(drawdown.maxDurationMs / 60_000) : null,
    reason: book.settled === 0
      ? "No settled trades yet"
      : hasDrawdownSamples
        ? null
        : `No settled trades in the last ${DRAWDOWN_LOOKBACK_DAYS} days`,
  }
}
