import { resolveConfirmedPositionQuantity } from "./live-position-pnl"
import { isRealExchangePosition } from "./live-position-source"
import { isLiveOpenStatus } from "./live-position-status"

/** Executed members only: a combined row's parent is lineage, not a member. */
export function liveRowSetKeys(position: Record<string, any>): string[] {
  const primary = String(position.setKey || "").trim()
  const members = Array.isArray(position.accumulatedSetKeys)
    ? position.accumulatedSetKeys.map((key: unknown) => String(key || "").trim()).filter(Boolean)
    : []
  return [...new Set<string>((position.combinedPosCounts && members.length > 0
    ? members : [primary, ...members]).filter(Boolean))]
}

/** Counts ledger rows and exact Set membership, never venue symbol/side slots. */
export function summarizeLiveExecutionRows(positions: readonly Record<string, any>[]) {
  const rows = new Set<string>()
  const pending = new Set<string>()
  const sets = new Set<string>()
  let unresolvedRows = 0
  positions.forEach((position, index) => {
    if (!isLiveOpenStatus(position.status) || !isRealExchangePosition(position)) return
    const connection = String(position.connectionId || position.connection_id || "")
    const identity = `${connection}|${String(position.id || `index:${index}`)}`
    if ((resolveConfirmedPositionQuantity(position) ?? 0) <= 0) {
      if (["pending", "placed", "pending_fill", "placed_unconfirmed"].includes(String(position.status || "").trim().toLowerCase())) {
        pending.add(identity)
      }
      return
    }
    if (rows.has(identity)) return
    rows.add(identity)
    const members = liveRowSetKeys(position)
    if (members.length === 0) unresolvedRows++
    for (const key of members) sets.add(`${connection}|${key}`)
  })
  return { openRows: rows.size, pendingEntries: pending.size, runningSets: sets.size, unresolvedRows }
}
