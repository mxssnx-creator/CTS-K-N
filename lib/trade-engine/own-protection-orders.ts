/**
 * Verify our own protection orders one by one when the venue's open-order LIST cannot be read.
 *
 * X02, 2026-10-01: the BingX open-orders endpoint stayed in its 100410 "disabled period" for hours (still tripped
 * 3 s after the end the venue named; another system on the same API key keeps calling it). The protection audit
 * needs an authoritative list, so entries were deferred and a genuine halt set at 19:12 UTC, when a check
 * that did get through found two missing controls, could not be cleared: clearing needs the same list. The
 * controls themselves were on the venue (STOP_MARKET / TAKE_PROFIT_MARKET, status NEW).
 *
 * The audit only asks "is this control order id alive?" (live-entry-protection-admission compares the ids stored in our
 * own rows with the set of live ids). That question can be answered per id with getOrderDetails, a different endpoint.
 * Used ONLY when the list is refused for a rate limit, never for another failure; an id that cannot be resolved
 * (lookup cooldown, network error) makes the whole fallback unavailable instead of counting as "missing"; and by default
 * only on testnet accounts (CTS_PROTECTION_OWN_ORDER_FALLBACK=1 / 0 forces it on / off). Foreign orders and the control
 * order capacity of the venue are not seen in this mode; the venue itself refuses an order beyond its limit.
 */
import { isRateLimitedSnapshotError } from "@/lib/trade-engine/admission-cooldown"

const ACTIVE_STATUSES = new Set(["NEW", "PENDING", "PARTIALLY_FILLED", "WORKING", "UNTRIGGERED", "ACCEPTED"])
const LOOKUP_CACHE_MS = 15_000
const LOOKUP_CONCURRENCY = 4

const cache = new Map<string, { at: number; order: Record<string, any> | null }>()

export function clearOwnProtectionOrderCache(): void {
  cache.clear()
}

export function ownProtectionFallbackEnabled(connector: any, env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.CTS_PROTECTION_OWN_ORDER_FALLBACK
  if (flag === "0") return false
  if (flag === "1") return true
  return connector?.credentials?.isTestnet === true
}

const text = (value: unknown): string => String(value ?? "").trim()

/** The control order ids of our own open rows, as the audit reads them. */
export function ownControlOrderRefs(rows: ReadonlyArray<Record<string, any>>): Array<{ symbol: string; id: string }> {
  const seen = new Set<string>()
  const refs: Array<{ symbol: string; id: string }> = []
  const add = (symbol: string, id: string) => {
    if (!symbol || !id) return
    const key = `${symbol}|${id}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ symbol, id })
  }
  for (const row of rows) {
    const status = text(row?.status).toLowerCase()
    if (status === "closed" || status === "rejected" || status === "cancelled" || status === "canceled" || status === "error") continue
    if (!(Number(row?.executedQuantity) > 0)) continue
    const symbol = text(row.symbol).toUpperCase()
    add(symbol, text(row.stopLossOrderId))
    add(symbol, text(row.takeProfitOrderId))
    add(symbol, text(row.securityStopOrderId))
    const coverage = row.controlOrderSetCoverage
    if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
      for (const value of Object.values(coverage as Record<string, any>)) add(symbol, text(value?.securityStopOrderId))
    }
  }
  return refs
}

/** True when a failed lookup means "the venue does not know this order" (including its negative cache), not "we could not ask". */
function isOrderGone(error: unknown): boolean {
  return /109421|does not exist|order not exist|not found/i.test(text(error))
}

async function lookup(connector: any, symbol: string, id: string, now: number): Promise<{ order: Record<string, any> | null } | "unknown"> {
  const key = `${symbol}|${id}`
  const hit = cache.get(key)
  if (hit && now - hit.at < LOOKUP_CACHE_MS) return { order: hit.order }
  let result: { success?: boolean; order?: any; error?: string }
  try {
    result = await connector.getOrderDetails(symbol, id)
  } catch (error) {
    if (isRateLimitedSnapshotError(error) || !isOrderGone(error)) return "unknown"
    cache.set(key, { at: now, order: null })
    return { order: null }
  }
  if (result?.success && result.order) {
    const status = text(result.order.status).toUpperCase()
    const live = ACTIVE_STATUSES.has(status)
    const order = live
      ? {
          orderId: text(result.order.orderId ?? result.order.orderID ?? id),
          clientOrderId: text(result.order.clientOrderId ?? result.order.clientOrderID),
          symbol,
          status,
          type: result.order.type,
          side: result.order.side,
          positionSide: result.order.positionSide,
          origQty: result.order.origQty ?? result.order.quantity,
          stopPrice: result.order.stopPrice,
          __ownLookup: true,
        }
      : null
    cache.set(key, { at: now, order })
    return { order }
  }
  // The venue answered "no such order" (a negative cache is the same answer), or we could not ask.
  if (!isRateLimitedSnapshotError(result?.error) && isOrderGone(result?.error)) {
    cache.set(key, { at: now, order: null })
    return { order: null }
  }
  return "unknown"
}

/**
 * The live subset of our own control orders, in the shape of an open-orders list, or null when any id could not be resolved.
 */
export async function readOwnControlOrdersById(
  connector: any,
  rows: ReadonlyArray<Record<string, any>>,
  now: number = Date.now(),
): Promise<Record<string, any>[] | null> {
  if (!connector || typeof connector.getOrderDetails !== "function") return null
  const refs = ownControlOrderRefs(rows)
  const live: Record<string, any>[] = []
  for (let i = 0; i < refs.length; i += LOOKUP_CONCURRENCY) {
    const results = await Promise.all(refs.slice(i, i + LOOKUP_CONCURRENCY).map((ref) => lookup(connector, ref.symbol, ref.id, now)))
    for (const result of results) {
      if (result === "unknown") return null
      if (result.order) live.push(result.order)
    }
  }
  return live
}
