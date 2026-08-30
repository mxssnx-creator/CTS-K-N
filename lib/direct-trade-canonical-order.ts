import {
  beginDirectOrderControl,
  createLiveOrderConnector,
  loadLiveOrderConnection,
  updateDirectOrderControl,
  type DirectOrderControlRecord,
  type LiveOrderDirection,
} from "@/lib/live-order-service"
import {
  closeLivePosition,
  directTradeCanonicalPositionId,
  executeLivePosition,
  getLivePositionSnapshot,
  type LivePosition,
} from "@/lib/trade-engine/stages/live-stage"
import type { RealPosition } from "@/lib/trade-engine/stages/real-stage"
import {
  evaluateDirectTradeLiveReadiness,
  isDirectTradeVstConnection,
} from "@/lib/direct-trade-live-readiness"

export type DirectTradeCanonicalStage = "entry" | "block" | "dca"

export interface DirectTradeCanonicalOrderInput {
  kind: "open" | "close"
  stage: DirectTradeCanonicalStage
  connectionId: string
  positionId: string
  controlId: string
  symbol: string
  positionDirection: LiveOrderDirection
  quantity: number
  price?: number
  leverage?: number
  reconcileOnly?: boolean
  statePosition: Record<string, any>
  shouldContinue?: () => boolean | Promise<boolean>
}

function httpError(message: string, statusCode: number, mode: string): Error {
  return Object.assign(new Error(message), { statusCode, mode })
}

async function continuationAllowed(input: DirectTradeCanonicalOrderInput): Promise<boolean> {
  if (!input.shouldContinue) return true
  try {
    return (await input.shouldContinue()) !== false
  } catch {
    return false
  }
}

function parentSetKey(positionId: string): string {
  return `direct-trade:${positionId}`
}

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function buildRealPosition(input: DirectTradeCanonicalOrderInput): RealPosition {
  const state = input.statePosition
  const parent = parentSetKey(input.positionId)
  const stopLoss = finitePositive(state.stoploss ?? state.stopLoss)
  const takeProfit = finitePositive(state.takeprofit ?? state.takeProfit)
  if (!(stopLoss > 0) || !(takeProfit > 0)) {
    throw httpError(
      "Direct-Trade live entry requires finite positive Stop Loss and Take Profit percentages",
      409,
      "direct_trade_protection_invalid",
    )
  }

  const blockCount = input.stage === "block"
    ? Math.max(0, Math.floor(Number(state.blockPendingCount || state.blockAddedCount || 0)))
    : 0
  const dcaStep = input.stage === "dca"
    ? Math.max(0, Math.floor(Number(state.dcaPendingControlStep || 0)))
    : 0
  if (input.stage === "block" && blockCount <= 0) {
    throw httpError("Direct-Trade Block control is missing its exact count", 409, "direct_trade_block_identity_missing")
  }
  if (input.stage === "dca" && dcaStep <= 0) {
    throw httpError("Direct-Trade DCA control is missing its exact step", 409, "direct_trade_dca_identity_missing")
  }

  const blockVolumeRatio = Math.max(0.1, Number(state.blockVolumeRatio) || 1)
  const setKey = input.stage === "block"
    ? `${parent}#block:${blockCount}`
    : input.stage === "dca"
      ? `${parent}#dca`
      : `${parent}#entry`
  const positionCostPctOverride = finitePositive(state.positionCostPercent)

  return {
    id: `${parent}:${input.controlId}`,
    connectionId: input.connectionId,
    symbol: input.symbol,
    direction: input.positionDirection,
    entryPrice: finitePositive(input.price),
    quantity: input.quantity,
    requestedQuantityCap: input.quantity,
    requestedDcaStep: dcaStep || undefined,
    positionCostPctOverride: positionCostPctOverride || undefined,
    leverage: Math.max(1, Math.floor(Number(input.leverage) || 1)),
    riskAmount: 0,
    rewardTarget: takeProfit,
    stopLoss,
    takeProfit,
    mainPositionCount: 1,
    evaluationScore: 1,
    ratioMet: true,
    timestamp: Date.now(),
    ratios: {
      profitabilityRatio: Math.max(1, takeProfit / stopLoss),
      accountRiskRatio: 0,
      successRateRatio: 1,
      consistencyRatio: 1,
    },
    status: "ready",
    setKey,
    parentSetKey: parent,
    indicationType: "direct-trade",
    setVariant: input.stage === "block" ? "block" : input.stage === "dca" ? "dca" : "default",
    sizeMultiplier: input.stage === "block" ? 1 + blockCount * blockVolumeRatio : 1,
    blockCount: blockCount || undefined,
    blockBaseVolumeMultiplier: 1,
    blockVolumeRatio: input.stage === "block" ? blockVolumeRatio : undefined,
    blockVolumeIncrementRatio: input.stage === "block" ? blockCount * blockVolumeRatio : undefined,
    blockCalculatedVolumeMultiplier: input.stage === "block" ? 1 + blockCount * blockVolumeRatio : undefined,
    blockScope: input.stage === "block" ? "live_row" : undefined,
    blockLaneKind: input.stage === "block" ? "row-live" : undefined,
    blockLaneKey: input.stage === "block" ? parent : undefined,
    blockSourceId: input.stage === "block" ? input.positionId : undefined,
    dcaProfile: input.stage === "dca" ? state.dcaProfile : undefined,
  }
}

function fillForStage(
  position: LivePosition,
  input: DirectTradeCanonicalOrderInput,
): { orderId: string; quantity: number; price: number; fee: number; settlementSource?: string } | null {
  const parent = parentSetKey(input.positionId)
  if (input.stage === "block") {
    const count = Math.max(0, Math.floor(Number(input.statePosition.blockPendingCount || input.statePosition.blockAddedCount || 0)))
    const setKey = `${parent}#block:${count}`
    const leg = [...(position.blockLegs || [])].reverse().find((candidate: any) => candidate?.setKey === setKey) as any
    if (leg && Number(leg.quantity) > 0) {
      const matchingFill = [...(position.fills || [])].reverse().find((fill) => String(fill.orderId || "") === String(leg.orderId || ""))
      return {
        orderId: String(leg.orderId || matchingFill?.orderId || ""),
        quantity: Number(leg.quantity),
        price: finitePositive(leg.filledPrice ?? matchingFill?.price ?? position.averageExecutionPrice),
        fee: Math.max(0, Number(matchingFill?.fee) || 0),
        settlementSource: matchingFill?.settlementSource,
      }
    }
    return null
  }
  if (input.stage === "dca") {
    const step = Math.max(0, Math.floor(Number(input.statePosition.dcaPendingControlStep || 0)))
    const leg = [...(position.dcaLegs || [])].reverse().find((candidate: any) => Number(candidate?.step) === step) as any
    if (leg && Number(leg.quantity) > 0) {
      const matchingFill = [...(position.fills || [])].reverse().find((fill) => String(fill.orderId || "") === String(leg.orderId || ""))
      return {
        orderId: String(leg.orderId || matchingFill?.orderId || ""),
        quantity: Number(leg.quantity),
        price: finitePositive(leg.filledPrice ?? matchingFill?.price ?? position.averageExecutionPrice),
        fee: Math.max(0, Number(matchingFill?.fee) || 0),
        settlementSource: matchingFill?.settlementSource,
      }
    }
    return null
  }

  const firstOrderId = String(position.orderId || position.fills?.[0]?.orderId || "")
  const fill = (position.fills || []).find((candidate) => (
    firstOrderId ? String(candidate.orderId || "") === firstOrderId : true
  )) || position.fills?.[0]
  const quantity = finitePositive(position.initialExecutedQuantity ?? fill?.quantity)
  const price = finitePositive(position.initialEntryPrice ?? fill?.price ?? position.averageExecutionPrice)
  return quantity > 0 && price > 0
    ? {
        orderId: firstOrderId,
        quantity,
        price,
        fee: Math.max(0, Number(fill?.fee) || 0),
        settlementSource: fill?.settlementSource,
      }
    : null
}

function entrySettlement(
  position: LivePosition,
  fill: ReturnType<typeof fillForStage>,
): Record<string, any> | null {
  if (!fill?.orderId || !fill.settlementSource) return null
  return {
    orderId: fill.orderId,
    symbol: position.symbol,
    filledQuantity: fill.quantity,
    averageFillPrice: fill.price,
    grossRealizedPnl: 0,
    tradingFee: fill.fee,
    netRealizedPnl: -fill.fee,
    netIncludesEntryFee: true,
    source: fill.settlementSource,
    settledAt: Date.now(),
    fills: [],
  }
}

function protectionResponse(position: LivePosition): Record<string, any> {
  const coverage = Object.values(position.controlOrderSetCoverage || {})
    .find((entry) => entry?.protected)
  return {
    stopLossOrderId: position.stopLossOrderId || null,
    takeProfitOrderId: position.takeProfitOrderId || null,
    securityStopOrderId: position.securityStopOrderId || coverage?.securityStopOrderId || null,
    stopLossPrice: finitePositive(position.stopLossPrice) || null,
    takeProfitPrice: finitePositive(position.takeProfitPrice) || null,
    securityStopPrice: finitePositive(position.securityStopPrice ?? coverage?.securityStopPrice) || null,
    securityStopStatus: position.securityStopStatus || coverage?.securityStopStatus || null,
    aggregateProtectionOwner: position.aggregateProtectionOwner === true,
  }
}

function exactStageProtectionCoverage(
  position: LivePosition,
  input: DirectTradeCanonicalOrderInput,
): NonNullable<LivePosition["controlOrderSetCoverage"]>[string] | null {
  const parent = parentSetKey(input.positionId)
  const stageKey = input.stage === "block"
    ? `${parent}#block:${Math.max(0, Math.floor(Number(input.statePosition.blockPendingCount || input.statePosition.blockAddedCount || 0)))}`
    : input.stage === "dca"
      ? `${parent}#dca#step:${Math.max(0, Math.floor(Number(input.statePosition.dcaPendingControlStep || 0)))}`
      : `${parent}#entry`
  return position.controlOrderSetCoverage?.[stageKey] || null
}

function hasCanonicalDirectProtection(
  position: LivePosition,
  input: DirectTradeCanonicalOrderInput,
): boolean {
  const coverage = exactStageProtectionCoverage(position, input)
  return coverage?.protected === true
    && Boolean(coverage.stopLossOrderId)
    && Boolean(coverage.takeProfitOrderId)
    && coverage.securityStopRequired === true
    && coverage.securityStopStatus === "armed"
    && Boolean(coverage.securityStopOrderId)
}

function pendingOpenResponse(
  position: LivePosition | null,
  input: DirectTradeCanonicalOrderInput,
  canonicalPositionId: string,
): Record<string, any> {
  return {
    success: true,
    mode: "live",
    orderId: position?.orderId || "N/A",
    symbol: input.symbol,
    direction: input.positionDirection,
    quantity: input.quantity,
    fill: { filled: false, filledQty: 0, filledPrice: 0, status: position?.status || "pending_reconciliation" },
    details: { status: position?.status || "pending_reconciliation", statusReason: position?.statusReason || null },
    settlement: null,
    protection: position ? protectionResponse(position) : null,
    canonicalLivePositionId: canonicalPositionId,
    pendingReconciliation: true,
    controlState: "acknowledged",
  }
}

function completedOpenResponse(
  position: LivePosition,
  input: DirectTradeCanonicalOrderInput,
  canonicalPositionId: string,
  fill: NonNullable<ReturnType<typeof fillForStage>>,
): Record<string, any> {
  const settlement = entrySettlement(position, fill)
  return {
    success: true,
    mode: "live",
    orderId: fill.orderId || position.orderId || "N/A",
    symbol: input.symbol,
    direction: input.positionDirection,
    quantity: fill.quantity,
    fill: { filled: true, filledQty: fill.quantity, filledPrice: fill.price, status: "filled" },
    details: { status: position.status, avgPrice: fill.price, filledQty: fill.quantity },
    settlement,
    protection: protectionResponse(position),
    canonicalLivePositionId: canonicalPositionId,
    pendingReconciliation: false,
    // A confirmed/protected fill is enough for the worker to start managing
    // the position, but the durable control remains replayable until exact
    // exchange fee accounting is available.
    controlState: settlement ? "completed" : "acknowledged",
  }
}

function closeResponse(
  position: LivePosition,
  input: DirectTradeCanonicalOrderInput,
  canonicalPositionId: string,
): Record<string, any> {
  const terminal = String(position.status || "").toLowerCase() === "closed"
  if (!terminal) {
    return {
      success: true,
      mode: "live",
      orderId: position.closeOrderId || "N/A",
      symbol: input.symbol,
      direction: input.positionDirection,
      quantity: input.quantity,
      fill: { filled: false, filledQty: 0, filledPrice: 0, status: position.status || "closing" },
      details: { status: position.status || "closing", statusReason: position.statusReason || null },
      settlement: null,
      canonicalLivePositionId: canonicalPositionId,
      pendingReconciliation: true,
      controlState: "acknowledged",
    }
  }

  const quantity = finitePositive(position.totalExecutedQuantity ?? position.executedQuantity ?? input.quantity)
  const price = finitePositive(position.closePrice)
  const orderId = String(position.closeOrderId || "")
  const accountingComplete = position.realizedPnlComplete === true && Boolean(orderId) && price > 0
  const settlement = accountingComplete
    ? {
        orderId,
        symbol: position.symbol,
        filledQuantity: quantity,
        averageFillPrice: price,
        grossRealizedPnl: Number(position.realizedPnlGross || 0),
        tradingFee: Math.max(0, Number(position.tradingFees || 0)),
        netRealizedPnl: Number(position.realizedPnL || 0),
        netIncludesEntryFee: true,
        source: position.realizedPnlSource || "exchange_settlement",
        settledAt: position.closedAt || Date.now(),
        fills: [],
      }
    : null
  const alreadyClosed = !orderId || !(price > 0)
  const controlComplete = accountingComplete || alreadyClosed
  return {
    success: true,
    mode: "live",
    orderId: orderId || "N/A",
    symbol: input.symbol,
    direction: input.positionDirection,
    quantity,
    fill: {
      filled: !alreadyClosed,
      filledQty: alreadyClosed ? 0 : quantity,
      filledPrice: alreadyClosed ? 0 : price,
      status: alreadyClosed ? "already_closed" : "filled",
    },
    details: { status: "closed", avgPrice: price || null, filledQty: alreadyClosed ? 0 : quantity },
    settlement,
    canonicalLivePositionId: canonicalPositionId,
    pendingReconciliation: !controlComplete,
    controlState: controlComplete ? "completed" : "acknowledged",
    alreadyClosed,
  }
}

async function persistControlResponse(
  control: DirectOrderControlRecord,
  canonicalPositionId: string,
  response: Record<string, any>,
): Promise<Record<string, any>> {
  const state = response.controlState === "completed"
    ? "completed"
    : response.controlState === "failed"
      ? "failed"
      : "acknowledged"
  const stored = await updateDirectOrderControl(control, {
    state,
    response,
    orderId: response.orderId && response.orderId !== "N/A" ? String(response.orderId) : undefined,
    canonicalPositionId,
    lastError: response.success === false ? String(response.error || "Direct-Trade canonical order failed") : undefined,
  })
  return stored.response || response
}

/**
 * One Direct-Trade control generation delegated to the canonical Live stage.
 * No order is submitted outside the exact X02 Prod-VST boundary, and every
 * completed entry has already passed the row TP/SL plus shared-slot security
 * audit before this function acknowledges it to the worker.
 */
export async function executeDirectTradeCanonicalOrder(
  input: DirectTradeCanonicalOrderInput,
): Promise<Record<string, any>> {
  const connection = await loadLiveOrderConnection(input.connectionId)
  if (!isDirectTradeVstConnection(connection, input.connectionId)) {
    throw httpError(
      "Direct-Trade exchange mutations are restricted to the BingX X02 Prod-VST virtual-funds connection",
      409,
      "direct_trade_connection_read_only",
    )
  }
  if (input.kind === "open") {
    const readiness = evaluateDirectTradeLiveReadiness(connection, input.connectionId)
    if (!readiness.canPlaceRealOrders) {
      throw httpError(readiness.blockReason, 409, readiness.blockCode || "direct_trade_live_not_ready")
    }
  }

  const canonicalPositionId = directTradeCanonicalPositionId(
    input.connectionId,
    input.symbol,
    input.positionDirection,
    parentSetKey(input.positionId),
  )
  const orderDirection: LiveOrderDirection = input.kind === "open"
    ? input.positionDirection
    : input.positionDirection === "long" ? "short" : "long"
  const claim = await beginDirectOrderControl({
    connectionId: input.connectionId,
    clientOrderId: input.controlId,
    positionId: input.positionId,
    canonicalPositionId,
    symbol: input.symbol,
    direction: orderDirection,
    positionDirection: input.positionDirection,
    reduceOnly: input.kind === "close",
    quantity: input.quantity,
    orderType: "market",
  })
  if ((claim.record.state === "completed" || claim.record.state === "failed") && claim.record.response) {
    return { ...claim.record.response, idempotentReplay: true, canonicalLivePositionId: canonicalPositionId }
  }

  let snapshot = await getLivePositionSnapshot(input.connectionId, canonicalPositionId)
  if (
    input.kind === "open"
    && input.stage !== "entry"
    && (!snapshot || !["open", "filled", "partially_filled"].includes(String(snapshot.status || "")))
  ) {
    const response = {
      success: false,
      error: `Canonical Direct-Trade parent is unavailable for ${input.stage}; no exchange quantity was mutated`,
      mode: "live",
      controlState: "failed",
      pendingReconciliation: false,
      canonicalLivePositionId: canonicalPositionId,
    }
    return persistControlResponse(claim.record, canonicalPositionId, response)
  }

  const { connector, willUseRealExchange } = await createLiveOrderConnector(connection, {
    directTrade: true,
    reduceOnly: input.kind === "close",
    source: `direct-trade-${input.kind}`,
    confirmLiveOrderPlacement: true,
  })
  if (!willUseRealExchange) {
    throw httpError(
      "Direct-Trade live control refused a simulated connector fallback",
      409,
      "direct_trade_live_connector_not_real",
    )
  }

  if (input.kind === "close") {
    if (!snapshot) {
      const response = {
        success: false,
        error: "Canonical Direct-Trade ownership row is unavailable; no exchange quantity was mutated",
        mode: "live",
        controlState: "failed",
        pendingReconciliation: false,
        canonicalLivePositionId: canonicalPositionId,
      }
      return persistControlResponse(claim.record, canonicalPositionId, response)
    }
    if (String(snapshot.status || "").toLowerCase() !== "closed") {
      const closed = await closeLivePosition(
        input.connectionId,
        canonicalPositionId,
        finitePositive(input.price),
        connector,
        String(input.statePosition.closeReason || "direct_trade_exit"),
      )
      snapshot = closed || await getLivePositionSnapshot(input.connectionId, canonicalPositionId) || snapshot
    }
    return persistControlResponse(
      claim.record,
      canonicalPositionId,
      closeResponse(snapshot, input, canonicalPositionId),
    )
  }

  if (!await continuationAllowed(input)) {
    const response = snapshot
      ? pendingOpenResponse(snapshot, input, canonicalPositionId)
      : {
          success: false,
          error: "Direct-Trade processor lease or live state stopped before canonical venue submission",
          mode: "live",
          controlState: "failed",
          pendingReconciliation: false,
          canonicalLivePositionId: canonicalPositionId,
        }
    return persistControlResponse(claim.record, canonicalPositionId, response)
  }

  const existingFill = snapshot ? fillForStage(snapshot, input) : null
  if (!existingFill) {
    const realPosition = buildRealPosition(input)
    snapshot = await executeLivePosition(
      input.connectionId,
      realPosition,
      connector,
      input.shouldContinue,
    )
  }
  const fill = snapshot ? fillForStage(snapshot, input) : null
  if (
    snapshot
    && fill
    && ["open", "filled", "partially_filled"].includes(String(snapshot.status || ""))
    && hasCanonicalDirectProtection(snapshot, input)
  ) {
    return persistControlResponse(
      claim.record,
      canonicalPositionId,
      completedOpenResponse(snapshot, input, canonicalPositionId, fill),
    )
  }
  if (snapshot && ["error", "rejected", "closed", "cancelled"].includes(String(snapshot.status || ""))) {
    const response = {
      success: false,
      error: snapshot.statusReason || `Canonical Direct-Trade entry ended with status ${snapshot.status}`,
      mode: "live",
      orderId: snapshot.orderId || "N/A",
      controlState: "failed",
      pendingReconciliation: false,
      canonicalLivePositionId: canonicalPositionId,
      protection: protectionResponse(snapshot),
    }
    return persistControlResponse(claim.record, canonicalPositionId, response)
  }
  return persistControlResponse(
    claim.record,
    canonicalPositionId,
    pendingOpenResponse(snapshot, input, canonicalPositionId),
  )
}
