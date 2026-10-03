import { isConnectionOwnedClientOrderId } from "@/lib/system-order-ownership"

/**
 * Own protection orders that no open row carries any more.
 *
 * X02, 2026-10-03: 14 own stop / take-profit orders sat on the venue without being the active control of any open row
 * (NEAR short: 5 surplus stops and a take profit for a 3 NEAR position). They are left behind when a hand-off re-arms the
 * shared controls and the cancellation of the old ones does not complete; the existing sweep runs only when a position
 * closes and only for ids recorded on that row, so replaced ids are never caught. On a slot that also holds another
 * system's position such a reduce-only order closes FOREIGN quantity when it triggers (the -279 VST NEAR case).
 *
 * Selected: protection order types, the connection's exact client id watermark (third-party and manual orders are never
 * touched), not the active control (any *OrderId field) of a non-terminal row, not a pending protection submission, and
 * older than `minAgeMs` so a control placed moments ago and not yet persisted is never hit.
 */
export const STALE_CONTROL_MIN_AGE_MS = 10 * 60_000
export const STALE_CONTROL_SWEEP_SECONDS = 300
const PROTECTION_TYPES = new Set(["STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT", "TRAILING_STOP_MARKET"])
const TERMINAL = new Set(["closed", "rejected", "cancelled", "canceled", "expired", "error", "failed"])

export function activeControlReferences(rows: ReadonlyArray<Record<string, any>>): { ids: Set<string>; clientIds: Set<string> } {
  const ids = new Set<string>()
  const clientIds = new Set<string>()
  for (const row of rows || []) {
    if (TERMINAL.has(String(row?.status || "").toLowerCase())) continue
    for (const [key, value] of Object.entries(row || {})) {
      if (/OrderId$/i.test(key) && value !== null && value !== undefined && String(value).trim()) ids.add(String(value).trim())
    }
    let pending: any = row?.pendingProtectionOrders
    if (typeof pending === "string") { try { pending = JSON.parse(pending) } catch { pending = null } }
    if (pending && typeof pending === "object") {
      for (const entry of Object.values(pending as Record<string, any>)) if (entry?.clientOrderId) clientIds.add(String(entry.clientOrderId))
    }
  }
  return { ids, clientIds }
}

export function selectStaleOwnControlOrders(
  orders: ReadonlyArray<Record<string, any>>,
  rows: ReadonlyArray<Record<string, any>>,
  connectionId: string,
  now: number = Date.now(),
  minAgeMs: number = STALE_CONTROL_MIN_AGE_MS,
): Record<string, any>[] {
  const { ids, clientIds } = activeControlReferences(rows)
  return (orders || []).filter((order) => {
    const type = String(order?.type ?? order?.orderType ?? "").toUpperCase()
    if (!PROTECTION_TYPES.has(type)) return false
    const clientOrderId = String(order?.clientOrderId ?? order?.clientOrderID ?? "")
    if (!isConnectionOwnedClientOrderId(clientOrderId, connectionId)) return false
    const orderId = String(order?.orderId ?? order?.id ?? "")
    if (!orderId || ids.has(orderId) || ids.has(clientOrderId) || clientIds.has(clientOrderId)) return false
    const placedAt = Number(order?.time ?? order?.createdAt ?? order?.updateTime ?? 0)
    if (!(placedAt > 0) || now - placedAt < minAgeMs) return false
    return true
  })
}

/** Reads the open orders once (skips when the list is not authoritative) and cancels the selected ones. */
export async function sweepStaleOwnControlOrders(
  connector: any,
  connectionId: string,
  rows: ReadonlyArray<Record<string, any>>,
  now: number = Date.now(),
): Promise<{ scanned: number; cancelled: string[]; failed: number }> {
  const result = { scanned: 0, cancelled: [] as string[], failed: 0 }
  if (!connector || typeof connector.getOpenOrders !== "function" || typeof connector.cancelOrder !== "function") return result
  let orders: any[] = []
  try {
    orders = (await connector.getOpenOrders()) || []
  } catch {
    return result
  }
  const status = typeof connector.getLastOpenOrdersSnapshotStatus === "function" ? connector.getLastOpenOrdersSnapshotStatus() : null
  if (status && status.ok === false) return result // a partial or failed list proves nothing
  result.scanned = orders.length
  for (const order of selectStaleOwnControlOrders(orders, rows, connectionId, now)) {
    const symbol = String(order.symbol || "").replace(/-/g, "")
    try {
      const res: any = await connector.cancelOrder(symbol, String(order.orderId))
      if (res && res.success === false) result.failed++
      else result.cancelled.push(`${symbol}:${order.positionSide || order.side}:${order.type}`)
    } catch {
      result.failed++
    }
  }
  return result
}
