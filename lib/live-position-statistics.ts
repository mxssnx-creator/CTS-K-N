import {
  resolvePositionQuantity,
  resolveRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"

export type LiveStrategySource = "direct-trade" | "main-trade" | "preset-trade" | "signal-trade" | "unknown"

export interface LivePositionStatisticsLane {
  positions: number
  filled: number
  open: number
  closed: number
  partialExecutions: number
  lifetimeQuantity: number
  openQuantity: number
  closedQuantity: number
  lifetimeVolumeUsd: number
  openVolumeUsd: number
  realizedPnl: number
  unrealizedPnl: number
  fees: number
}

export interface LivePositionStatistics extends LivePositionStatisticsLane {
  wins: number
  losses: number
  breakeven: number
  winRate: number
  averageRealizedRoi: number
  bySource: Record<string, LivePositionStatisticsLane>
  byVariant: Record<string, LivePositionStatisticsLane>
  byIndicationType: Record<string, LivePositionStatisticsLane>
  protection: {
    exchangeControl: number
    hybridControlSystem: number
    systemClose: number
    systemCloseFallback: number
    missingVenueLegsHandledBySystem: number
  }
  relationIntegrity: {
    success: boolean
    checkedPositions: number
    mismatchCount: number
    mismatches: string[]
  }
}

const OPEN_STATUSES = new Set([
  "pending", "placed", "pending_fill", "placed_unconfirmed", "partially_filled", "filled", "open", "simulated",
])

type ProtectionLeg = "stop_loss" | "take_profit"

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function rounded(value: number, precision = 12): number {
  const factor = 10 ** precision
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function strategySource(position: Record<string, any>): LiveStrategySource {
  const intent = String(position.executionIntent || position.source || "").toLowerCase()
  if (intent.includes("direct")) return "direct-trade"
  if (position.presetId || intent.includes("preset")) return "preset-trade"
  if (
    String(position.indicationType || "").toLowerCase() === "signal"
    || position.signalRisk
    || intent.includes("signal")
  ) return "signal-trade"
  if (position.setKey || position.parentSetKey || intent.includes("main")) return "main-trade"
  return "unknown"
}

function strategyVariant(position: Record<string, any>): string {
  if (position.combinedPosCounts === true) return "combined-pos-count"
  return String(position.setVariant || position.variant || "default").trim().toLowerCase() || "default"
}

function emptyLane(): LivePositionStatisticsLane {
  return {
    positions: 0,
    filled: 0,
    open: 0,
    closed: 0,
    partialExecutions: 0,
    lifetimeQuantity: 0,
    openQuantity: 0,
    closedQuantity: 0,
    lifetimeVolumeUsd: 0,
    openVolumeUsd: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    fees: 0,
  }
}

function positionMeasures(position: Record<string, any>): LivePositionStatisticsLane {
  const status = String(position.status || "").toLowerCase()
  const isClosed = status === "closed"
  const isOpen = OPEN_STATUSES.has(status) && !isClosed
  const executed = Math.max(0, resolvePositionQuantity(position) ?? 0)
  const closedQuantity = Math.max(0, finite(position.closedQuantity))
  const totalExecuted = Math.max(
    0,
    resolvePositionQuantity(position, true) ?? 0,
    isClosed ? executed : executed + closedQuantity,
  )
  const entryPrice = Math.max(0, finite(position.averageExecutionPrice ?? position.entryPrice))
  const fills = Array.isArray(position.fills) ? position.fills : []
  const exchangeQuantityAdjustments = Array.isArray(position.exchangeQuantityAdjustments)
    ? position.exchangeQuantityAdjustments
    : []
  const fillVolume = fills.reduce(
    (sum: number, fill: any) => sum + Math.max(0, finite(fill?.quantity)) * Math.max(0, finite(fill?.price)),
    0,
  )
  const adjustmentQuantity = exchangeQuantityAdjustments.reduce(
    (sum: number, adjustment: any) => sum + Math.max(0, finite(adjustment?.quantity)),
    0,
  )
  const adjustmentVolume = exchangeQuantityAdjustments.reduce(
    (sum: number, adjustment: any) => sum + Math.max(0, finite(adjustment?.quantity)) * Math.max(0, finite(adjustment?.price)),
    0,
  )
  const accountedQuantity = fills.reduce(
    (sum: number, fill: any) => sum + Math.max(0, finite(fill?.quantity)),
    0,
  ) + adjustmentQuantity
  const quantityTolerance = Math.max(1e-10, Math.abs(finite(position.quantityStep)) / 2)
  const lifetimeVolumeUsd = accountedQuantity > 0 && Math.abs(accountedQuantity - totalExecuted) <= quantityTolerance
    ? fillVolume + adjustmentVolume
    : totalExecuted * entryPrice
  const openQuantity = isOpen ? executed : 0
  const openVolumeUsd = openQuantity * entryPrice
  return {
    positions: 1,
    filled: totalExecuted > 0 ? 1 : 0,
    open: isOpen ? 1 : 0,
    closed: isClosed ? 1 : 0,
    partialExecutions: Array.isArray(position.partialOrderExecutions)
      ? position.partialOrderExecutions.length
      : 0,
    lifetimeQuantity: totalExecuted,
    openQuantity,
    closedQuantity: isClosed ? totalExecuted : closedQuantity,
    lifetimeVolumeUsd,
    openVolumeUsd,
    realizedPnl: resolveRealizedPnl(position) ?? 0,
    unrealizedPnl: isOpen
      ? resolveUnrealizedPnl(position) ?? 0
      : 0,
    fees: fills.reduce((sum: number, fill: any) => sum + Math.max(0, finite(fill?.fee)), 0),
  }
}

function addLane(target: LivePositionStatisticsLane, source: LivePositionStatisticsLane): void {
  for (const field of Object.keys(target) as Array<keyof LivePositionStatisticsLane>) {
    target[field] = rounded(target[field] + source[field])
  }
}

function addBucket(
  buckets: Record<string, LivePositionStatisticsLane>,
  key: string,
  measures: LivePositionStatisticsLane,
): void {
  const normalized = String(key || "unknown").trim().toLowerCase() || "unknown"
  buckets[normalized] ||= emptyLane()
  addLane(buckets[normalized], measures)
}

function quantityTolerance(position: Record<string, any>): number {
  return Math.max(1e-10, Math.abs(finite(position.quantityStep)) / 2)
}

function hasPositiveProtectionValue(...values: unknown[]): boolean {
  return values.some((value) => finite(value) > 0)
}

function configuredProtectionLegs(position: Record<string, any>): Set<ProtectionLeg> {
  const legs = new Set<ProtectionLeg>()
  const manual = position.manualProtectionOverride || {}
  const hasManualSl = Object.prototype.hasOwnProperty.call(manual, "stopLossPrice")
  const hasManualTp = Object.prototype.hasOwnProperty.call(manual, "takeProfitPrice")
  const hasStopLoss = position.trailingActive === true
    ? hasPositiveProtectionValue(position.trailingStopPrice)
    : hasManualSl
      ? hasPositiveProtectionValue(manual.stopLossPrice)
      : hasPositiveProtectionValue(position.stopLoss)
  const hasTakeProfit = hasManualTp
    ? hasPositiveProtectionValue(manual.takeProfitPrice)
    : hasPositiveProtectionValue(position.dcaTakeProfitPrice, position.takeProfit)
  if (hasStopLoss) legs.add("stop_loss")
  if (hasTakeProfit) legs.add("take_profit")
  return legs
}

function usesSimulatedSystemLifecycle(position: Record<string, any>): boolean {
  return String(position.status || "").toLowerCase() === "simulated"
    || String(position.executionMode || "").toLowerCase() === "simulation"
    || position.isSimulated === true
}

/**
 * Return the protection legs that are durably handled by the in-process
 * lifecycle. New paper positions persist these explicitly. The simulation
 * inference keeps pre-migration paper rows honest because their SL/TP cross
 * is also evaluated by processSimulatedPositions; it intentionally never
 * applies to a real venue position.
 */
function effectiveSystemProtectionLegs(position: Record<string, any>): Set<ProtectionLeg> {
  const legs = new Set<ProtectionLeg>()
  for (const value of Array.isArray(position.systemProtectionLegs) ? position.systemProtectionLegs : []) {
    if (value === "stop_loss" || value === "take_profit") legs.add(value)
  }
  if (
    usesSimulatedSystemLifecycle(position)
    && finite(position.averageExecutionPrice ?? position.entryPrice) > 0
  ) {
    for (const leg of configuredProtectionLegs(position)) legs.add(leg)
  }
  return legs
}

function positionRelationMismatches(position: Record<string, any>, index: number): string[] {
  const id = String(position.id || `index-${index}`)
  const label = `${id}/${String(position.symbol || "missing")}/${String(position.direction || position.side || "missing")}`
  const mismatches: string[] = []
  const status = String(position.status || "").toLowerCase()
  const executed = finite(position.executedQuantity ?? position.quantity)
  const closed = finite(position.closedQuantity)
  const total = finite(position.totalExecutedQuantity)
  const tolerance = quantityTolerance(position)
  if (!position.id || !position.symbol || !["long", "short"].includes(String(position.direction || position.side || "").toLowerCase())) {
    mismatches.push(`${label}: identity relation is incomplete`)
  }
  if (executed < -tolerance || closed < -tolerance || total < -tolerance) {
    mismatches.push(`${label}: negative quantity relation`)
  }
  if (status === "closed") {
    if (total > 0 && (Math.abs(executed - total) > tolerance || Math.abs(closed - total) > tolerance)) {
      mismatches.push(`${label}: closed quantity ${executed}/${closed} != lifetime ${total}`)
    }
  } else if (total > 0 && Math.abs(total - (Math.max(0, executed) + Math.max(0, closed))) > tolerance) {
    mismatches.push(`${label}: open+closed quantity ${executed + closed} != lifetime ${total}`)
  }
  const fillQuantity = (Array.isArray(position.fills) ? position.fills : [])
    .reduce((sum: number, fill: any) => sum + Math.max(0, finite(fill?.quantity)), 0)
  const adjustmentQuantity = (Array.isArray(position.exchangeQuantityAdjustments)
    ? position.exchangeQuantityAdjustments
    : [])
    .reduce((sum: number, adjustment: any) => sum + Math.max(0, finite(adjustment?.quantity)), 0)
  const accountedQuantity = fillQuantity + adjustmentQuantity
  if (total > 0 && Math.abs(accountedQuantity - total) > tolerance) {
    mismatches.push(
      `${label}: fill quantity ${fillQuantity} + exchange adjustment ${adjustmentQuantity} != lifetime ${total}`,
    )
  }
  const terminalWithoutFillLedger = new Set(["error", "rejected", "cancelled", "canceled"])
  const simulated = usesSimulatedSystemLifecycle(position)
  if (
    total > tolerance &&
    accountedQuantity <= tolerance &&
    !simulated &&
    !terminalWithoutFillLedger.has(status)
  ) {
    mismatches.push(`${label}: entry quantity has no fill or exchange adjustment ledger`)
  }
  if (position.combinedPosCounts === true) {
    const allocation = (Object.values(position.posCountsSetQuantities || {}) as unknown[])
      .reduce<number>((sum, value) => sum + Math.max(0, finite(value)), 0)
    const expectedAllocation = status === "closed" ? 0 : Math.max(0, executed)
    if (Math.abs(allocation - expectedAllocation) > tolerance) {
      mismatches.push(`${label}: member allocation ${allocation} != physical open quantity ${expectedAllocation}`)
    }
    if (!Array.isArray(position.accumulatedSetKeys)) {
      mismatches.push(`${label}: combined position has no member lineage`)
    }
  } else if (position.setKey && !(position.accumulatedSetKeys || []).includes(position.setKey)) {
    mismatches.push(`${label}: originating Set is absent from accumulated lineage`)
  }
  if (OPEN_STATUSES.has(status) && Math.max(0, executed) > 0) {
    const averageExecutionPrice = finite(position.averageExecutionPrice ?? position.entryPrice)
    if (averageExecutionPrice <= 0) {
      mismatches.push(`${label}: open execution has no authoritative average price`)
    }
    const configuredLegs = configuredProtectionLegs(position)
    const systemLegs = effectiveSystemProtectionLegs(position)
    if (configuredLegs.has("stop_loss") && !position.stopLossOrderId && !systemLegs.has("stop_loss")) {
      mismatches.push(`${label}: stop-loss has neither venue order nor system handling`)
    }
    if (configuredLegs.has("take_profit") && !position.takeProfitOrderId && !systemLegs.has("take_profit")) {
      mismatches.push(`${label}: take-profit has neither venue order nor system handling`)
    }
  }
  const orderIds = [position.orderId, position.stopLossOrderId, position.takeProfitOrderId]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
  if (new Set(orderIds).size !== orderIds.length) mismatches.push(`${label}: entry/protection order IDs are not unique`)
  return mismatches
}

export function calculateLivePositionStatistics(
  positions: readonly Record<string, any>[],
): LivePositionStatistics {
  const aggregate = emptyLane()
  const bySource: Record<string, LivePositionStatisticsLane> = {}
  const byVariant: Record<string, LivePositionStatisticsLane> = {}
  const byIndicationType: Record<string, LivePositionStatisticsLane> = {}
  const mismatches: string[] = []
  const protection = {
    exchangeControl: 0,
    hybridControlSystem: 0,
    systemClose: 0,
    systemCloseFallback: 0,
    missingVenueLegsHandledBySystem: 0,
  }
  let wins = 0
  let losses = 0
  let breakeven = 0
  let realizedRoiSum = 0
  let realizedRoiCount = 0
  positions.forEach((position, index) => {
    const measures = positionMeasures(position)
    addLane(aggregate, measures)
    addBucket(bySource, strategySource(position), measures)
    addBucket(byVariant, strategyVariant(position), measures)
    addBucket(byIndicationType, String(position.indicationType || "unknown"), measures)
    mismatches.push(...positionRelationMismatches(position, index))
    if (measures.closed > 0) {
      if (measures.realizedPnl > 0) wins++
      else if (measures.realizedPnl < 0) losses++
      else breakeven++
      const roi = Number(position.realizedRoi ?? position.roi)
      if (Number.isFinite(roi)) {
        realizedRoiSum += roi
        realizedRoiCount++
      }
    }
    const systemLegs = effectiveSystemProtectionLegs(position)
    const mode = String(position.protectionMode || (
      usesSimulatedSystemLifecycle(position) && systemLegs.size > 0 ? "system_close" : ""
    ))
    if (mode === "exchange_control") protection.exchangeControl++
    if (mode === "hybrid_control_system") protection.hybridControlSystem++
    if (mode === "system_close") protection.systemClose++
    if (mode === "system_close_fallback") protection.systemCloseFallback++
    protection.missingVenueLegsHandledBySystem += systemLegs.size
  })
  const decisive = wins + losses
  return {
    ...aggregate,
    wins,
    losses,
    breakeven,
    winRate: decisive > 0 ? rounded((wins / decisive) * 100, 4) : 0,
    averageRealizedRoi: realizedRoiCount > 0 ? rounded(realizedRoiSum / realizedRoiCount, 4) : 0,
    bySource,
    byVariant,
    byIndicationType,
    protection,
    relationIntegrity: {
      success: mismatches.length === 0,
      checkedPositions: positions.length,
      mismatchCount: mismatches.length,
      mismatches,
    },
  }
}
