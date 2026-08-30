import { getConnection } from "@/lib/redis-db"
import { createLiveOrderConnector } from "@/lib/live-order-service"
import { isExactSystemPositionOwner } from "@/lib/system-order-ownership"

const ACTIVE_EXCHANGE_LIFECYCLE_STATUSES = new Set([
  "open",
  "filled",
  "partially_filled",
  "placed",
  "pending",
  "pending_fill",
  "placed_unconfirmed",
  "closing",
  "closing_partial",
])

export interface DirectTradeLifecyclePositionLike {
  connectionId?: string
  connection_id?: string
  system_tracking_id?: string
  systemTrackingId?: string
  connection_tracking_id?: string
  connectionTrackingId?: string
  status?: string
  executionMode?: string
  executionIntent?: string
  indicationType?: string
}

/**
 * A Direct-Trade marker alone is not authority to select a mutating connector.
 * The row must be active, exchange-backed, and carry the exact CTS ownership
 * watermarks for the requested connection.
 */
export function isOwnedDirectTradeLifecyclePosition(
  position: DirectTradeLifecyclePositionLike | null | undefined,
  connectionId: string,
): boolean {
  if (!position || !isExactSystemPositionOwner(position as Record<string, any>, connectionId)) return false
  const status = String(position.status || "").trim().toLowerCase()
  if (!ACTIVE_EXCHANGE_LIFECYCLE_STATUSES.has(status)) return false
  if (status === "simulated" || String(position.executionMode || "").trim().toLowerCase() === "simulation") {
    return false
  }
  return String(position.executionIntent || "").trim().toLowerCase() === "direct"
    || String(position.indicationType || "").trim().toLowerCase() === "direct-trade"
}

/**
 * Re-select the independently scoped X02 Prod-VST connector whenever an owned
 * Direct position needs reconciliation, protection, or a reduce-only exit.
 * This is the lifecycle counterpart to Direct entry selection: global paper
 * mode may leave a SimulatedConnector in the normal cache, so accepting the
 * caller's connector would strand the real venue position after entry.
 */
export async function resolveDirectTradeLifecycleConnector(
  connectionId: string,
  positions: readonly DirectTradeLifecyclePositionLike[],
  fallbackConnector: any,
): Promise<any> {
  if (!positions.some((position) => isOwnedDirectTradeLifecyclePosition(position, connectionId))) {
    return fallbackConnector
  }

  const connection = await getConnection(connectionId)
  if (!connection) {
    throw Object.assign(new Error(`Direct-Trade lifecycle connection not found: ${connectionId}`), {
      statusCode: 503,
      mode: "direct_trade_lifecycle_connection_missing",
    })
  }

  const resolved = await createLiveOrderConnector(connection, {
    directTrade: true,
    reduceOnly: true,
    source: "direct-trade-lifecycle-reconcile",
    confirmLiveOrderPlacement: true,
  })
  if (!resolved.willUseRealExchange || !resolved.connector) {
    throw Object.assign(new Error("Direct-Trade lifecycle refused a simulated connector fallback"), {
      statusCode: 409,
      mode: "direct_trade_lifecycle_connector_not_real",
    })
  }
  return resolved.connector
}
