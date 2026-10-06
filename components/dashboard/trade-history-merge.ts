import type { TradeHistoryRow } from "@/lib/trade-history"

/**
 * Accumulate trade-history pages across polls with exactly one row per
 * position. `id` is the stable position id (own rows: the live position id,
 * which the results ledger reuses; venue-only rows: `exchange:<orderId>`).
 * The close order id must not be part of the key: a row first seen while
 * settlement is pending carries none and gains it once settled, so keying by
 * it kept both versions of the same trade. `incoming` is the newer read of the
 * server, so its version of a position replaces the previous one.
 */
export function mergeTradeHistoryRows(
  previous: readonly TradeHistoryRow[],
  incoming: readonly TradeHistoryRow[],
): TradeHistoryRow[] {
  const byPosition = new Map<string, TradeHistoryRow>()
  for (const row of [...previous, ...incoming]) {
    if (!row) continue
    const key = row.id
      ? `id:${row.id}`
      : `close:${row.closeOrderId || ""}:${row.symbol}:${row.closedAt}`
    byPosition.set(key, row)
  }
  return [...byPosition.values()].sort((left, right) => Number(right.closedAt) - Number(left.closedAt))
}
