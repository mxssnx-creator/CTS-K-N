import { timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { directOrderControlKey, placeLiveOrder, type LiveOrderDirection } from "@/lib/live-order-service"
import { directTradeKeyspace } from "@/lib/direct-trade-keyspace"
import { isConnectionOwnedClientOrderId } from "@/lib/system-order-ownership"
import {
  DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
  DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON,
  DIRECT_TRADE_LIVE_EXECUTION_READY,
} from "@/lib/direct-trade-live-readiness"

export const dynamic = "force-dynamic"

function sameSecret(received: string | null, expected: string): boolean {
  if (!received || !expected) return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function safeText(value: unknown, maximum = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : ""
}

function direction(value: unknown): LiveOrderDirection | null {
  const normalized = safeText(value, 12).toLowerCase()
  return normalized === "long" || normalized === "short" ? normalized : null
}

const DIRECT_FOREX_CODES = new Set([
  "AUD", "CAD", "CHF", "CNH", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "JPY", "MXN", "NOK", "NZD", "PLN", "RUB", "SEK", "SGD",
  "TRY", "USD", "XAG", "XAU", "ZAR",
])

function isDirectTradeSymbol(value: string): boolean {
  if (/^[A-Z0-9]{2,20}USDT$/.test(value)) return true
  if (!/^[A-Z]{6}$/.test(value)) return false
  return DIRECT_FOREX_CODES.has(value.slice(0, 3))
    && DIRECT_FOREX_CODES.has(value.slice(3))
}

function controlId(value: unknown, kind: string, positionId: string): string | null {
  // Timeframe-combination position IDs can contain `+` (for example
  // `5m+15m`). Canonicalize those legacy IDs instead of rejecting a durable
  // retry at the validation boundary; the current worker generates the same
  // canonical form for new orders.
  const candidate = safeText(value || `dt-${kind}-${positionId}`, 160)
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 48)
  return /^[A-Za-z0-9_-]{3,48}$/.test(candidate) ? candidate : null
}

function positionControlIds(position: Record<string, any>): Set<string> {
  const ids = new Set<string>()
  for (const value of [
    position.openControlId,
    position.blockPendingControlId,
    position.dcaPendingControlId,
    position.closeControlId,
    position.lastAppliedCloseControlId,
  ]) {
    const id = safeText(value)
    if (id) ids.add(id)
  }
  for (const collection of [position.positionLegs, position.blockLegs, position.dcaLegs]) {
    if (!Array.isArray(collection)) continue
    for (const leg of collection) {
      const id = safeText(leg?.controlId)
      if (id) ids.add(id)
    }
  }
  return ids
}

/**
 * Internal Direct-Trade control-order gateway. It accepts calls only from the
 * installed worker token *and* the exact current Redis lease owner. This keeps
 * a browser/API client from bypassing the Direct-Trade lifecycle and prevents
 * a restarted standby worker from issuing duplicate closes.
 */
export async function POST(request: NextRequest) {
  try {
    const processorToken = String(process.env.DIRECT_TRADE_PROCESSOR_TOKEN || "")
    if (processorToken.length < 24) {
      return NextResponse.json({ success: false, error: "Direct-Trade worker token is not configured" }, { status: 503 })
    }
    if (!sameSecret(request.headers.get("x-direct-trade-processor-token"), processorToken)) {
      return NextResponse.json({ success: false, error: "Direct-Trade worker authentication failed" }, { status: 401 })
    }

    const body = await request.json()
    const kind = body?.kind === "close" ? "close" : body?.kind === "open" ? "open" : ""
    const instanceId = safeText(body?.instanceId)
    const connectionId = safeText(body?.connectionId)
    const positionId = safeText(body?.positionId)
    const positionDirection = direction(body?.positionDirection)
    const quantity = Number(body?.quantity)
    const leverage = Math.max(1, Math.min(125, Math.floor(Number(body?.leverage) || 1)))
    const price = Number(body?.price)
    const clientOrderId = controlId(body?.controlId, kind, positionId)
    const reconcileOnly = body?.reconcileOnly === true
    const stage = body?.stage === "block" || body?.stage === "dca" ? "accumulation" : "entry"

    const symbol = safeText(body?.symbol, 40).toUpperCase()
    // The gateway is shared by crypto and Forex. Keep malformed/unsupported
    // symbols out at the API boundary while allowing compact broker pairs
    // such as EURUSD and XAUUSD to reach the selected Forex connector.
    const validSymbol = isDirectTradeSymbol(symbol)
    if (!kind || !instanceId || !connectionId || !positionId || !positionDirection || !validSymbol || !Number.isFinite(quantity) || quantity <= 0 || !clientOrderId) {
      return NextResponse.json({ success: false, error: "Invalid Direct-Trade control order" }, { status: 400 })
    }
    if (kind === "open" && stage === "entry" && !reconcileOnly && (!Number.isFinite(price) || price <= 0)) {
      return NextResponse.json({ success: false, error: "Direct-Trade entries require a valid reference price" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient() as any
    const keys = directTradeKeyspace(connectionId)
    let [leaseOwner, stateRaw] = await Promise.all([
      client.get(keys.processorLease),
      client.get(keys.state),
    ])
    // Compatibility for the exact pre-keyspace worker during a rolling
    // upgrade. It is accepted only when the legacy state's selected
    // connection matches this order; once scoped state exists no fallback is
    // possible, preventing two lease domains from authorising one order.
    if (!stateRaw) {
      const legacy = directTradeKeyspace()
      const [legacyLeaseOwner, legacyStateRaw] = await Promise.all([
        client.get(legacy.processorLease),
        client.get(legacy.state),
      ])
      const legacyState = legacyStateRaw ? JSON.parse(legacyStateRaw) : null
      if (legacyState?.connectionId === connectionId) {
        leaseOwner = legacyLeaseOwner
        stateRaw = legacyStateRaw
      }
    }
    if (leaseOwner !== instanceId) {
      return NextResponse.json({ success: false, error: "Direct-Trade processor lease is not held" }, { status: 409 })
    }
    const state = stateRaw ? JSON.parse(stateRaw) : {}
    const statePosition = Array.isArray(state?.positions)
      ? state.positions.find((position: any) => String(position?.id || "") === positionId)
      : null
    if (
      !statePosition
      || String(state?.connectionId || "") !== connectionId
      || String(statePosition?.connectionId || connectionId) !== connectionId
      || safeText(statePosition?.symbol, 40).toUpperCase() !== symbol
      || direction(statePosition?.direction) !== positionDirection
      || !positionControlIds(statePosition).has(clientOrderId)
    ) {
      return NextResponse.json({
        success: false,
        error: "Direct-Trade order is not owned by the exact persisted position/control",
      }, { status: 409 })
    }

    const durableControlExists = Boolean(
      await client.get(directOrderControlKey(connectionId, clientOrderId)),
    )
    if (
      kind === "open"
      && !DIRECT_TRADE_LIVE_EXECUTION_READY
      && !(reconcileOnly && durableControlExists)
    ) {
      return NextResponse.json({
        success: false,
        error: DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON,
        code: DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
      }, { status: 409 })
    }
    if (
      !isConnectionOwnedClientOrderId(clientOrderId, connectionId)
      && !(reconcileOnly && durableControlExists)
    ) {
      return NextResponse.json({
        success: false,
        error: "Direct-Trade control id is missing the exact connection watermark",
      }, { status: 409 })
    }
    if (kind === "open" && (!state?.enabled || !state?.liveMode || state?.connectionId !== connectionId)) {
      // Stop blocks every new exposure immediately. It must not, however,
      // prevent a durable ACK from being reconciled after the operator stops
      // the worker. `reconcileOnly` is accepted only when the exact control id
      // already exists, so this branch can never place a fresh order.
      if (!reconcileOnly || !durableControlExists) {
        return NextResponse.json({ success: false, error: "Direct-Trade live entry is not currently authorised for this connection" }, { status: 409 })
      }
    }

    const side = kind === "open"
      ? positionDirection
      : positionDirection === "long" ? "short" : "long"
    const result = await placeLiveOrder({
      connectionId,
      symbol,
      side,
      positionDirection,
      quantity,
      leverage,
      price: Number.isFinite(price) && price > 0 ? price : undefined,
      orderType: "market",
      reduceOnly: kind === "close",
      // If live entry is enabled in a future rollout, Direct-Trade must still
      // carry exact direction-aware controls into the shared service. The
      // current readiness gate remains fail-closed until ownership is unified.
      requireProtection: kind === "open",
      stopLossPrice: Number.isFinite(Number(body?.stopLossPrice)) && Number(body?.stopLossPrice) > 0
        ? Number(body.stopLossPrice)
        : undefined,
      takeProfitPrice: Number.isFinite(Number(body?.takeProfitPrice)) && Number(body?.takeProfitPrice) > 0
        ? Number(body.takeProfitPrice)
        : undefined,
      protectionStopLossPercent: Number.isFinite(Number(body?.protectionStopLossPercent ?? body?.stopLossPercent))
        && Number(body?.protectionStopLossPercent ?? body?.stopLossPercent) > 0
        ? Number(body?.protectionStopLossPercent ?? body?.stopLossPercent)
        : undefined,
      protectionTakeProfitPercent: Number.isFinite(Number(body?.protectionTakeProfitPercent ?? body?.takeProfitPercent))
        && Number(body?.protectionTakeProfitPercent ?? body?.takeProfitPercent) > 0
        ? Number(body?.protectionTakeProfitPercent ?? body?.takeProfitPercent)
        : undefined,
      positionTicket: Number.isInteger(Number(body?.positionTicket)) && Number(body?.positionTicket) > 0
        ? Number(body.positionTicket)
        : undefined,
      clientOrderId,
      positionId,
      // Direct Trade owns the position-stage rows itself. The shared live
      // service still owns connector safety, precision, audit and counters.
      persistPosition: false,
      updateCounters: kind === "open",
      countPositionCreated: kind === "open" && stage === "entry",
      countAccumulated: kind === "open" && stage === "accumulation",
      source: `direct-trade-${kind}`,
      safetyPayload: {
        confirmLiveOrderPlacement: true,
        directTrade: true,
        controlOrder: kind,
      },
    })
    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.error,
        mode: result.mode,
        controlState: result.controlState,
        pendingReconciliation: result.pendingReconciliation === true,
      })
    }
    return NextResponse.json({
      success: true,
      mode: result.mode,
      orderId: result.orderId,
      quantity: result.quantity,
      fill: result.fill,
      details: result.details,
      // The worker must receive the exact venue PnL/fee settlement already
      // resolved by live-order-service. Omitting it made real fills look
      // complete while every accounting row remained provisional.
      settlement: result.settlement,
      controlId: clientOrderId,
      controlState: result.controlState,
      pendingReconciliation: result.pendingReconciliation === true,
      idempotentReplay: result.idempotentReplay === true,
      alreadyClosed: result.alreadyClosed === true,
    })
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Direct-Trade control order failed", mode: error?.mode },
      { status: Number(error?.statusCode || 500) },
    )
  }
}
