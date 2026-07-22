import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { SimulatedConnector } from "@/lib/exchange-connectors/simulated-connector"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import {
  closeLivePosition,
  getLivePositions,
  recalculateAndApplySLTP,
} from "@/lib/trade-engine/stages/live-stage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

function positionDirection(position: any): "long" | "short" {
  return String(position?.direction ?? position?.side ?? "long").toLowerCase().includes("short")
    ? "short"
    : "long"
}

function currentMark(position: any): number {
  const candidates = [
    position?.exchangeData?.markPrice,
    position?.markPrice,
    position?.current_price,
    position?.currentPrice,
    position?.averageExecutionPrice,
    position?.entryPrice,
  ]
  for (const candidate of candidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function isSimulatedPosition(position: any): boolean {
  return position?.status === "simulated" ||
    position?.executionMode === "simulation" ||
    position?.isSimulated === true ||
    String(position?.statusReason || "").includes("live_trade disabled")
}

function parseOptionalPrice(body: Record<string, any>, key: string): {
  provided: boolean
  value?: number | null
  error?: string
} {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { provided: false }
  const raw = body[key]
  if (raw === null || raw === "" || raw === false) return { provided: true, value: null }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return { provided: true, error: `${key} must be a positive price or null` }
  }
  return { provided: true, value }
}

async function findOpenPosition(connectionId: string, positionId: string): Promise<any | null> {
  const positions = await getLivePositions(connectionId)
  return positions.find((position: any) =>
    String(position.id) === positionId && isLiveOpenStatus(position.status),
  ) || null
}

async function connectorForPosition(connectionId: string, position: any): Promise<any | null> {
  if (isSimulatedPosition(position)) {
    return new SimulatedConnector({ apiKey: "", apiSecret: "", isTestnet: true }, "simulated")
  }
  return exchangeConnectorFactory.getOrCreateConnector(connectionId)
}

/**
 * PATCH /api/trading/live-positions/:id
 *
 * Applies durable, absolute operator protection levels. The live-stage owns
 * all exchange cancellation/replacement, idempotency, locks, and recovery.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as Record<string, any>
    const connectionId = String(body.connectionId ?? body.connection_id ?? "").trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId required" }, { status: 400 })
    }

    await initRedis()
    const position = await findOpenPosition(connectionId, id)
    if (!position) {
      return NextResponse.json({ success: false, error: "Open live position not found" }, { status: 404 })
    }

    const reset = body.reset === true || body.action === "restore_strategy"
    if (reset) {
      const connector = await connectorForPosition(connectionId, position)
      const restored = await recalculateAndApplySLTP(connectionId, id, connector, {
        clearManualProtection: true,
        stopLossPct: Number(position.assignedStopLoss ?? position.stopLoss ?? 0) || undefined,
        takeProfitPct: Number(position.assignedTakeProfit ?? position.takeProfit ?? 0) || undefined,
        trailingActive: false,
        trailingStopPrice: 0,
      })
      if (!restored) {
        return NextResponse.json(
          { success: false, error: "Position is busy; strategy protection was not changed" },
          { status: 409, headers: { "Retry-After": "1" } },
        )
      }
      return NextResponse.json({
        success: true,
        state: connector ? "applied" : "queued",
        message: connector ? "Strategy protection restored" : "Strategy protection queued for reconciliation",
        position: restored,
      }, { status: connector ? 200 : 202 })
    }

    const stopLoss = parseOptionalPrice(body, "stopLossPrice")
    const takeProfit = parseOptionalPrice(body, "takeProfitPrice")
    if (stopLoss.error || takeProfit.error) {
      return NextResponse.json(
        { success: false, error: stopLoss.error || takeProfit.error },
        { status: 400 },
      )
    }

    const trailingProvided = Object.prototype.hasOwnProperty.call(body, "trailingEnabled")
    if (trailingProvided && typeof body.trailingEnabled !== "boolean") {
      return NextResponse.json(
        { success: false, error: "trailingEnabled must be a boolean" },
        { status: 400 },
      )
    }
    const trailingEnabled = trailingProvided
      ? body.trailingEnabled === true
      : position.manualProtectionOverride?.trailingEnabled === true || position.trailingActive === true
    const trailingDistanceProvided = Object.prototype.hasOwnProperty.call(body, "trailingDistancePct")
    const previousTrailingDistancePct = Number(position.manualProtectionOverride?.trailingDistancePct)
    const trailingDistancePct = trailingDistanceProvided
      ? Number(body.trailingDistancePct)
      : previousTrailingDistancePct
    if ((trailingProvided || trailingDistanceProvided) && trailingEnabled && (!Number.isFinite(trailingDistancePct) || trailingDistancePct < 0.05 || trailingDistancePct > 25)) {
      return NextResponse.json(
        { success: false, error: "trailingDistancePct must be between 0.05 and 25" },
        { status: 400 },
      )
    }
    if (!stopLoss.provided && !takeProfit.provided && !trailingProvided && !trailingDistanceProvided) {
      return NextResponse.json({ success: false, error: "No protection change supplied" }, { status: 400 })
    }

    // Browser validation is only a convenience. Enforce the invariant again
    // at the authoritative API boundary so a direct request can never leave a
    // live position without either a fixed SL or an active trailing stop.
    const previousManual = position.manualProtectionOverride
    const previousManualHasStop = previousManual &&
      Object.prototype.hasOwnProperty.call(previousManual, "stopLossPrice")
    const previousManualStop = Number(previousManual?.stopLossPrice)
    const strategyOrExchangeStop = Number(position.stopLossPrice) > 0 ||
      Number(position.stopLoss) > 0 ||
      Number(position.assignedStopLoss) > 0
    const effectiveFixedStop = stopLoss.provided
      ? stopLoss.value != null && stopLoss.value > 0
      : previousManualHasStop
        ? Number.isFinite(previousManualStop) && previousManualStop > 0
        : strategyOrExchangeStop
    if (!effectiveFixedStop && !trailingEnabled) {
      return NextResponse.json(
        { success: false, error: "Keep a stop loss or enable trailing protection" },
        { status: 400 },
      )
    }

    const mark = currentMark(position)
    if (mark <= 0) {
      return NextResponse.json({ success: false, error: "Position mark price unavailable" }, { status: 409 })
    }
    const direction = positionDirection(position)
    if (stopLoss.value != null) {
      const valid = direction === "long" ? stopLoss.value < mark : stopLoss.value > mark
      if (!valid) {
        return NextResponse.json({
          success: false,
          error: direction === "long"
            ? `Long stop loss must be below current mark ${mark}`
            : `Short stop loss must be above current mark ${mark}`,
        }, { status: 400 })
      }
    }
    if (takeProfit.value != null) {
      const valid = direction === "long" ? takeProfit.value > mark : takeProfit.value < mark
      if (!valid) {
        return NextResponse.json({
          success: false,
          error: direction === "long"
            ? `Long take profit must be above current mark ${mark}`
            : `Short take profit must be below current mark ${mark}`,
        }, { status: 400 })
      }
    }

    const manualProtection: {
      stopLossPrice?: number | null
      takeProfitPrice?: number | null
      trailingEnabled?: boolean
      trailingDistancePct?: number
    } = {}
    if (stopLoss.provided) manualProtection.stopLossPrice = stopLoss.value ?? null
    if (takeProfit.provided) manualProtection.takeProfitPrice = takeProfit.value ?? null
    if (trailingProvided) manualProtection.trailingEnabled = trailingEnabled
    if (trailingEnabled && (trailingProvided || trailingDistanceProvided)) {
      manualProtection.trailingDistancePct = trailingDistancePct
    }

    const connector = await connectorForPosition(connectionId, position)
    const updated = await recalculateAndApplySLTP(connectionId, id, connector, { manualProtection })
    if (!updated) {
      return NextResponse.json(
        { success: false, error: "Position is busy; protection was not changed" },
        { status: 409, headers: { "Retry-After": "1" } },
      )
    }

    const deferred = !connector || Boolean(
      updated.pendingSystemAction ||
      updated.pendingReduction ||
      updated.pendingAccumulation ||
      updated.pendingQuantityMutation,
    )
    return NextResponse.json({
      success: true,
      state: deferred ? "queued" : "applied",
      message: deferred
        ? "Protection saved and queued for authoritative reconciliation"
        : "Protection updated",
      position: updated,
    }, { status: deferred ? 202 : 200 })
  } catch (error) {
    console.error("[LivePositionAction] PATCH failed:", error)
    return NextResponse.json(
      { success: false, error: "Failed to update live position protection" },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/trading/live-positions/:id?connectionId=...
 *
 * Performs a coordinated reduce-only close. A venue acknowledgement is not
 * reported as closed until the live-stage has authoritative quantity proof.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const connectionId = String(
      request.nextUrl.searchParams.get("connectionId") ||
      request.nextUrl.searchParams.get("connection_id") ||
      "",
    ).trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId required" }, { status: 400 })
    }

    await initRedis()
    const position = await findOpenPosition(connectionId, id)
    if (!position) {
      return NextResponse.json({ success: true, alreadyClosed: true, message: "Position already closed" })
    }
    const mark = currentMark(position)
    if (mark <= 0) {
      return NextResponse.json({ success: false, error: "Position mark price unavailable" }, { status: 409 })
    }

    const simulated = isSimulatedPosition(position)
    const connector = simulated ? undefined : await connectorForPosition(connectionId, position)
    if (!simulated && !connector) {
      return NextResponse.json(
        { success: false, error: "Exchange connector unavailable; position remains open" },
        { status: 503 },
      )
    }

    const result = await closeLivePosition(connectionId, id, mark, connector, "manual_dashboard_close")
    if (!result) {
      return NextResponse.json(
        { success: false, error: "Position close is busy; no duplicate order was submitted" },
        { status: 409, headers: { "Retry-After": "1" } },
      )
    }

    if (result.status === "closed") {
      return NextResponse.json({ success: true, state: "closed", position: result })
    }
    if (result.status === "closing" || result.status === "closing_partial") {
      return NextResponse.json({
        success: true,
        state: result.status,
        message: "Close accepted; authoritative exchange reconciliation is still active",
        position: result,
      }, { status: 202 })
    }

    return NextResponse.json({
      success: false,
      state: result.status,
      error: result.statusReason || "Exchange close was not confirmed; position remains protected and open",
      position: result,
    }, { status: 409 })
  } catch (error) {
    console.error("[LivePositionAction] DELETE failed:", error)
    return NextResponse.json(
      { success: false, error: "Failed to close live position; position remains under reconciliation" },
      { status: 500 },
    )
  }
}
