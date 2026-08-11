import { timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { directOrderControlKey, placeLiveOrder, type LiveOrderDirection } from "@/lib/live-order-service"

export const dynamic = "force-dynamic"

const STATE_KEY = "direct_trade:state"
const PROCESSOR_LEASE_KEY = "direct_trade:processor:lease"

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

function controlId(value: unknown, kind: string, positionId: string): string | null {
  const candidate = safeText(value || `dt-${kind}-${positionId}`, 48)
  return /^[A-Za-z0-9_-]{3,48}$/.test(candidate) ? candidate : null
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

    if (!kind || !instanceId || !connectionId || !positionId || !positionDirection || !Number.isFinite(quantity) || quantity <= 0 || !clientOrderId) {
      return NextResponse.json({ success: false, error: "Invalid Direct-Trade control order" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient() as any
    const [leaseOwner, stateRaw] = await Promise.all([
      client.get(PROCESSOR_LEASE_KEY),
      client.get(STATE_KEY),
    ])
    if (leaseOwner !== instanceId) {
      return NextResponse.json({ success: false, error: "Direct-Trade processor lease is not held" }, { status: 409 })
    }
    const state = stateRaw ? JSON.parse(stateRaw) : {}
    if (kind === "open" && (!state?.enabled || !state?.liveMode || state?.connectionId !== connectionId)) {
      // Stop blocks every new exposure immediately. It must not, however,
      // prevent a durable ACK from being reconciled after the operator stops
      // the worker. `reconcileOnly` is accepted only when the exact control id
      // already exists, so this branch can never place a fresh order.
      const durableControlExists = reconcileOnly
        ? Boolean(await client.get(directOrderControlKey(connectionId, clientOrderId)))
        : false
      if (!durableControlExists) {
        return NextResponse.json({ success: false, error: "Direct-Trade live entry is not currently authorised for this connection" }, { status: 409 })
      }
    }

    const side = kind === "open"
      ? positionDirection
      : positionDirection === "long" ? "short" : "long"
    const result = await placeLiveOrder({
      connectionId,
      symbol: safeText(body?.symbol, 40),
      side,
      positionDirection,
      quantity,
      leverage,
      price: Number.isFinite(price) && price > 0 ? price : undefined,
      orderType: "market",
      reduceOnly: kind === "close",
      clientOrderId,
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
      controlId: clientOrderId,
      controlState: result.controlState,
      pendingReconciliation: result.pendingReconciliation === true,
      idempotentReplay: result.idempotentReplay === true,
    })
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Direct-Trade control order failed", mode: error?.mode },
      { status: Number(error?.statusCode || 500) },
    )
  }
}
