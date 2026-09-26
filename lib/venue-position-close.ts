/**
 * Settling a position that the venue closed without one of our own orders.
 *
 * Rows closed as "exchange_externally_closed" were booked with PnL 0 and
 * accounting "incomplete": there is no own closing order to settle from, so
 * the deferred accounting could never resolve them, and history and stats
 * carried zeros. The venue's position history still records the close: on the
 * X02 demo test (WLDUSDT short closed by hand) it returned entry 0.5299, close
 * 0.5313, realised -123.12, net -155.05 for exactly the quantity of both own
 * rows on that slot.
 *
 * A history entry is used only when it matches ONE row unambiguously (symbol,
 * side, open before the row filled, closed around the row's close, quantity at
 * least the row's). The row's share of the venue's costs is prorated by
 * quantity. Nothing here guesses a price.
 */
import type { CloseSettlement } from "@/lib/close-accounting-backfill"

export interface VenuePositionClose {
  positionId: string
  symbol: string
  side: "long" | "short"
  openTime: number
  closeTime: number
  avgPrice: number
  avgClosePrice: number
  realisedProfit: number
  netProfit: number
  closedQuantity: number
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const sym = (v: unknown): string => String(v || "").replace(/[-_/]/g, "").toUpperCase()

export function normalizeVenuePositionHistory(rows: readonly any[]): VenuePositionClose[] {
  return (rows || []).map((r) => ({
    positionId: String(r?.positionId ?? ""),
    symbol: sym(r?.symbol),
    side: String(r?.positionSide || "").toLowerCase() === "short" ? "short" as const : "long" as const,
    openTime: num(r?.openTime),
    closeTime: num(r?.updateTime ?? r?.closeTime),
    avgPrice: num(r?.avgPrice),
    avgClosePrice: num(r?.avgClosePrice),
    realisedProfit: num(r?.realisedProfit),
    netProfit: num(r?.netProfit),
    closedQuantity: Math.abs(num(r?.closePositionAmt ?? r?.positionAmt)),
  })).filter((c) => c.symbol && c.avgClosePrice > 0 && c.closedQuantity > 0 && c.closeTime > 0)
}

const CLOSE_WINDOW_MS = 15 * 60_000
const AMBIGUITY_MS = 60_000

/** The one venue close this row belongs to, or null when none or several fit. */
export function matchVenuePositionClose(row: Record<string, any>, closes: readonly VenuePositionClose[]): VenuePositionClose | null {
  const qty = num(row?.executedQuantity)
  if (!(qty > 0)) return null
  const side = String(row?.direction || "").toLowerCase() === "short" ? "short" : "long"
  const fillTime = num(row?.filledAt) || num(row?.executedAt) || num(row?.createdAt)
  const closedAt = num(row?.closedAt)
  const fits = closes.filter((c) =>
    c.symbol === sym(row?.symbol) && c.side === side
    && c.openTime <= fillTime + 60_000
    && c.closeTime >= fillTime - 5_000
    && c.closedQuantity >= qty * (1 - 1e-6)
    && (!closedAt || Math.abs(c.closeTime - closedAt) <= CLOSE_WINDOW_MS),
  )
  if (fits.length === 0) return null
  const ranked = [...fits].sort((a, b) => Math.abs(a.closeTime - (closedAt || a.closeTime)) - Math.abs(b.closeTime - (closedAt || b.closeTime)))
  if (ranked.length > 1 && Math.abs(ranked[1].closeTime - ranked[0].closeTime) <= AMBIGUITY_MS && ranked[1].positionId !== ranked[0].positionId) return null
  return ranked[0]
}

/** The row's own settlement from its venue close: its quantity, the venue's close price, its prorated share of costs. */
export function venueCloseSettlement(row: Record<string, any>, close: VenuePositionClose): CloseSettlement {
  const qty = num(row?.executedQuantity)
  const entry = num(row?.averageExecutionPrice) || num(row?.entryPrice) || close.avgPrice
  const sign = String(row?.direction || "").toLowerCase() === "short" ? -1 : 1
  const gross = (close.avgClosePrice - entry) * qty * sign
  const costShare = Math.max(0, close.realisedProfit - close.netProfit) * (qty / close.closedQuantity)
  const entryFee = Math.max(0, num(row?.entryTradingFee))
  return {
    filledQuantity: qty,
    averageFillPrice: close.avgClosePrice,
    grossRealizedPnl: Number(gross.toFixed(12)),
    tradingFee: Number(Math.max(0, costShare - entryFee).toFixed(12)),
  }
}

export const OWN_TRIGGER_TOLERANCE_PCT = 0.25

/**
 * Every trigger price this row is known to have armed. A closed row's price
 * fields are cleared, so the armed prices are also read from its history
 * ("update_sl_tp ... SL 1.2% → 0.536100 (id) | TP 1.46% → 0.522100 (id)"),
 * which includes every trailing move, and derived from its configured
 * percentages. Using ALL of them makes a trailing or protective exit far less
 * likely to be mistaken for a manual close — that mistake would block a
 * legitimate signal for a week, while the opposite mistake only allows a
 * re-entry, as before.
 */
export function ownTriggerPrices(row: Record<string, any>): number[] {
  const prices = [row?.stopLossPrice, row?.takeProfitPrice, row?.securityStopPrice, row?.trailingStopPrice].map(num)
  const entry = num(row?.averageExecutionPrice) || num(row?.entryPrice)
  const short = String(row?.direction || "").toLowerCase() === "short"
  const slPct = num(row?.stopLoss), tpPct = num(row?.takeProfit)
  if (entry > 0 && slPct > 0) prices.push(entry * (1 + (short ? 1 : -1) * slPct / 100))
  if (entry > 0 && tpPct > 0) prices.push(entry * (1 + (short ? -1 : 1) * tpPct / 100))
  let steps: any[] = []
  try { steps = Array.isArray(row?.progression) ? row.progression : JSON.parse(String(row?.progression || "[]")) } catch { steps = [] }
  for (const step of steps) {
    const text = String(step?.details || "")
    if (!/update_sl_tp|security|trailing|stop/i.test(String(step?.step || "")) && !/SL |TP /.test(text)) continue
    for (const m of text.matchAll(/(?:SL|TP|security|stop)[^→\n]*→\s*([0-9]+(?:\.[0-9]+)?)/gi)) prices.push(num(m[1]))
  }
  return prices.filter((v) => v > 0)
}

/**
 * true  = closed by hand: the exit is far from EVERY own trigger price.
 * false = at one of our triggers (stop, take profit, security, trailing).
 * null  = unknown (no trigger price known) — callers keep today's behaviour.
 */
export function isManualCloseAtPrice(row: Record<string, any>, exitPrice: number, tolerancePct = OWN_TRIGGER_TOLERANCE_PCT): boolean | null {
  const triggers = ownTriggerPrices(row)
  if (!(exitPrice > 0) || triggers.length === 0) return null
  return !triggers.some((t) => (Math.abs(exitPrice - t) / t) * 100 <= tolerancePct)
}
