import {
  evaluateRealTradeReadiness,
  isBingXVirtualFundsDemo,
  type RealTradeReadiness,
} from "@/lib/real-trade-gates"

/**
 * Direct-Trade now delegates every venue mutation to the canonical Live stage,
 * including exact row TP/SL, one aggregate security stop per physical slot,
 * durable client IDs, quantity barriers, and shared ownership reconciliation.
 * Runtime placement still fails closed unless the one authorised Prod-VST
 * connection is explicitly enabled below.
 */
export const DIRECT_TRADE_LIVE_EXECUTION_READY = true

export const DIRECT_TRADE_VST_CONNECTION_ID = "bingx-x02"

export const DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE =
  "direct_live_runtime_not_ready"

export const DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON =
  "Direct-Trade live execution is not authorised for the selected connection; paper evaluation remains available."

function allowedConnectionIds(): Set<string> {
  return new Set(
    String(process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS || "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
}

function resolvedConnectionId(connection: Record<string, any> | null | undefined, connectionId?: string): string {
  return String(connectionId || connection?.id || connection?.connectionId || "").trim().toLowerCase()
}

/** Exact immutable environment boundary shared by entry and close paths. */
export function isDirectTradeVstConnection(
  connection: Record<string, any> | null | undefined,
  connectionId?: string,
): boolean {
  return DIRECT_TRADE_LIVE_EXECUTION_READY
    && resolvedConnectionId(connection, connectionId) === DIRECT_TRADE_VST_CONNECTION_ID
    && isBingXVirtualFundsDemo(connection || {})
}

/** New exposure needs both the immutable X02 boundary and an explicit opt-in. */
export function isDirectTradeVstEntryAuthorized(
  connection: Record<string, any> | null | undefined,
  connectionId?: string,
): boolean {
  const id = resolvedConnectionId(connection, connectionId)
  return isDirectTradeVstConnection(connection, id)
    && process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT === "1"
    && allowedConnectionIds().has(id)
}

export function evaluateDirectTradeLiveReadiness(
  connection: Record<string, any> | null | undefined,
  connectionId?: string,
): RealTradeReadiness {
  const id = resolvedConnectionId(connection, connectionId)
  const settings = {
    ...(connection || {}),
    id,
    // The Direct-Trade switch/lease is the explicit request. Do not couple it
    // to Main's persisted toggle merely to reuse the common safety evaluator.
    is_live_trade: true,
    live_trade_requested: true,
  }
  const readiness = evaluateRealTradeReadiness(settings, "main", {
    allowForcedSimulationForAuthorizedVst: isDirectTradeVstEntryAuthorized(settings, id),
  })
  if (!isDirectTradeVstEntryAuthorized(settings, id)) {
    return {
      ...readiness,
      requested: true,
      enabled: false,
      canPlaceRealOrders: false,
      executionMode: "blocked",
      blockCode: "placement_disabled",
      blockReason: !id
        ? "Select the BingX X02 Prod-VST connection before enabling Direct-Trade live execution"
        : id !== DIRECT_TRADE_VST_CONNECTION_ID
          ? "Direct-Trade live execution is restricted to the BingX X02 Prod-VST connection"
          : !isBingXVirtualFundsDemo(settings)
            ? "Direct-Trade live execution requires the BingX Prod-VST virtual-funds connection"
            : process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT !== "1"
              ? "Direct-Trade X02 live placement is disabled on this server"
              : "Direct-Trade X02 is not present in the explicit live connection allow-list",
    }
  }
  return readiness
}

export function directTradeLiveExecutionReadiness(
  connection?: Record<string, any> | null,
  connectionId?: string,
) {
  const runtime = evaluateDirectTradeLiveReadiness(connection, connectionId)
  return {
    ready: DIRECT_TRADE_LIVE_EXECUTION_READY && runtime.canPlaceRealOrders,
    capabilityReady: DIRECT_TRADE_LIVE_EXECUTION_READY,
    connectionId: resolvedConnectionId(connection, connectionId) || null,
    virtualFundsOnly: true,
    blockCode: runtime.canPlaceRealOrders ? null : runtime.blockCode || DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
    blockReason: runtime.canPlaceRealOrders ? null : runtime.blockReason || DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON,
  }
}
