import {
  isRealizedPnlAccountingPending,
  resolveConfirmedPositionQuantity,
  resolveRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import {
  collectArmedSecurityStopOrderIds,
  resolveEffectiveSecurityStop,
} from "@/lib/security-stop-projection"

export type LiveStrategySource = "direct-trade" | "main-trade" | "preset-trade" | "signal-trade" | "unknown"

export interface LivePositionStatisticsLane {
  positions: number
  filled: number
  open: number
  closed: number
  accountingPending: number
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
    venueLegsQuantityCovered: number
    venueLegsQuantityUnknown: number
    venueLegsQuantityDrifted: number
    securityStopsRequired: number
    securityStopsArmed: number
    securityStopsMissing: number
  }
  relationIntegrity: {
    success: boolean
    checkedPositions: number
    mismatchCount: number
    mismatches: string[]
  }
}

type ProtectionLeg = "stop_loss" | "take_profit"
type ProtectionQuantityState = "covered" | "unknown" | "drifted"

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
  if (intent.includes("signal")) return "signal-trade"
  if (intent.includes("preset")) return "preset-trade"
  if (intent.includes("main")) return "main-trade"
  if (
    String(position.indicationType || "").toLowerCase() === "signal"
    || position.signalRisk
  ) return "signal-trade"
  if (position.presetId) return "preset-trade"
  if (position.setKey || position.parentSetKey) return "main-trade"
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
    accountingPending: 0,
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
  const status = String(position.status || "").trim().toLowerCase()
  const isClosed = status === "closed"
  const isOpen = isLiveOpenStatus(status) && !isClosed
  const accountingPending = isClosed && isRealizedPnlAccountingPending(position)
  const executed = Math.max(0, resolveConfirmedPositionQuantity(position) ?? 0)
  const closedQuantity = Math.max(0, finite(position.closedQuantity))
  const totalExecuted = Math.max(
    0,
    resolveConfirmedPositionQuantity(position, true) ?? 0,
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
    accountingPending: accountingPending ? 1 : 0,
    partialExecutions: Array.isArray(position.partialOrderExecutions)
      ? position.partialOrderExecutions.length
      : 0,
    lifetimeQuantity: totalExecuted,
    openQuantity,
    closedQuantity: isClosed ? totalExecuted : closedQuantity,
    lifetimeVolumeUsd,
    openVolumeUsd,
    realizedPnl: accountingPending ? 0 : resolveRealizedPnl(position) ?? 0,
    unrealizedPnl: isOpen && executed > 0
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
  const hasManualSl = hasPositiveProtectionValue(manual.stopLossPrice)
  const hasManualTp = hasPositiveProtectionValue(manual.takeProfitPrice)
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

function venueProtectionQuantityState(
  position: Record<string, any>,
  leg: ProtectionLeg,
): ProtectionQuantityState | null {
  if (!isLiveOpenStatus(position.status)) return null
  const orderId = leg === "stop_loss" ? position.stopLossOrderId : position.takeProfitOrderId
  if (!String(orderId || "").trim()) return null
  const expected = Math.max(0, resolveConfirmedPositionQuantity(position) ?? 0)
  if (!(expected > 0)) return null
  const specific = leg === "stop_loss"
    ? position.stopLossArmedQuantity
    : position.takeProfitArmedQuantity
  const raw = specific === undefined || specific === null || specific === ""
    ? position.protectionArmedQuantity
    : specific
  if (raw === undefined || raw === null || raw === "") return "unknown"
  const armed = Number(raw)
  if (!Number.isFinite(armed)) return "unknown"
  return Math.abs(Math.max(0, armed) - expected) <= quantityTolerance(position)
    ? "covered"
    : "drifted"
}

function effectiveSecurityProtection(position: Record<string, any>): {
  required: boolean
  orderId: string
  price: number
  status: string
  armed: boolean
} {
  return resolveEffectiveSecurityStop(position)
}

function positionRelationMismatches(position: Record<string, any>, index: number): string[] {
  const id = String(position.id || `index-${index}`)
  const label = `${id}/${String(position.symbol || "missing")}/${String(position.direction || position.side || "missing")}`
  const mismatches: string[] = []
  const status = String(position.status || "").trim().toLowerCase()
  const executed = Math.max(0, resolveConfirmedPositionQuantity(position) ?? 0)
  const lifetime = Math.max(0, resolveConfirmedPositionQuantity(position, true) ?? 0)
  const rawExecuted = finite(position.executedQuantity)
  const closed = finite(position.closedQuantity)
  const rawTotal = finite(position.totalExecutedQuantity)
  const tolerance = quantityTolerance(position)
  if (!position.id || !position.symbol || !["long", "short"].includes(String(position.direction || position.side || "").toLowerCase())) {
    mismatches.push(`${label}: identity relation is incomplete`)
  }
  if (rawExecuted < -tolerance || closed < -tolerance || rawTotal < -tolerance) {
    mismatches.push(`${label}: negative quantity relation`)
  }
  if (status === "closed") {
    if (lifetime > 0 && (Math.abs(executed - lifetime) > tolerance || Math.abs(closed - lifetime) > tolerance)) {
      mismatches.push(`${label}: closed quantity ${executed}/${closed} != lifetime ${lifetime}`)
    }
  } else if (rawTotal > 0 && Math.abs(rawTotal - (Math.max(0, executed) + Math.max(0, closed))) > tolerance) {
    mismatches.push(`${label}: open+closed quantity ${executed + closed} != lifetime ${rawTotal}`)
  }
  const fillQuantity = (Array.isArray(position.fills) ? position.fills : [])
    .reduce((sum: number, fill: any) => sum + Math.max(0, finite(fill?.quantity)), 0)
  const adjustmentQuantity = (Array.isArray(position.exchangeQuantityAdjustments)
    ? position.exchangeQuantityAdjustments
    : [])
    .reduce((sum: number, adjustment: any) => sum + Math.max(0, finite(adjustment?.quantity)), 0)
  const accountedQuantity = fillQuantity + adjustmentQuantity
  if (lifetime > 0 && Math.abs(accountedQuantity - lifetime) > tolerance) {
    mismatches.push(
      `${label}: fill quantity ${fillQuantity} + exchange adjustment ${adjustmentQuantity} != lifetime ${lifetime}`,
    )
  }
  const terminalWithoutFillLedger = new Set(["error", "rejected", "cancelled", "canceled"])
  const simulated = usesSimulatedSystemLifecycle(position)
  if (
    lifetime > tolerance &&
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
  if (isLiveOpenStatus(status) && Math.max(0, executed) > 0) {
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
    for (const leg of ["stop_loss", "take_profit"] as const) {
      const quantityState = venueProtectionQuantityState(position, leg)
      const legLabel = leg === "stop_loss" ? "stop-loss" : "take-profit"
      if (quantityState === "unknown") {
        mismatches.push(`${label}: ${legLabel} venue order has no authoritative armed quantity`)
      } else if (quantityState === "drifted") {
        const armed = leg === "stop_loss"
          ? position.stopLossArmedQuantity ?? position.protectionArmedQuantity
          : position.takeProfitArmedQuantity ?? position.protectionArmedQuantity
        mismatches.push(`${label}: ${legLabel} venue quantity ${finite(armed)} != open quantity ${Math.max(0, executed)}`)
      }
    }
    const security = effectiveSecurityProtection(position)
    if (security.required) {
      const armed = security.armed
      if (!armed) mismatches.push(`${label}: required slot security stop is not armed`)
      const rowStop = finite(position.stopLossPrice)
      const direction = String(position.direction || position.side || "").toLowerCase()
      if (armed && rowStop > 0) {
        if (direction === "long" && !(security.price < rowStop)) {
          mismatches.push(`${label}: long security stop ${security.price} is not farther than row stop ${rowStop}`)
        }
        if (direction === "short" && !(security.price > rowStop)) {
          mismatches.push(`${label}: short security stop ${security.price} is not farther than row stop ${rowStop}`)
        }
      }
    }
  }
  const effectiveSecurity = effectiveSecurityProtection(position)
  const orderIds = [position.orderId, position.stopLossOrderId, position.takeProfitOrderId, effectiveSecurity.orderId]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
  if (new Set(orderIds).size !== orderIds.length) mismatches.push(`${label}: entry/protection order IDs are not unique`)
  return mismatches
}

export function calculateLivePositionStatistics(
  positions: readonly Record<string, any>[],
): LivePositionStatistics {
  const aggregate = emptyLane()
  const bySource: Record<string, LivePositionStatisticsLane> = Object.fromEntries(
    ["direct-trade", "main-trade", "preset-trade", "signal-trade", "unknown"]
      .map((source) => [source, emptyLane()]),
  )
  const byVariant: Record<string, LivePositionStatisticsLane> = {}
  const byIndicationType: Record<string, LivePositionStatisticsLane> = {}
  const mismatches: string[] = []
  const protection = {
    exchangeControl: 0,
    hybridControlSystem: 0,
    systemClose: 0,
    systemCloseFallback: 0,
    missingVenueLegsHandledBySystem: 0,
    venueLegsQuantityCovered: 0,
    venueLegsQuantityUnknown: 0,
    venueLegsQuantityDrifted: 0,
    securityStopsRequired: 0,
    securityStopsArmed: 0,
    securityStopsMissing: 0,
  }
  const securitySlots = new Map<string, {
    symbol: string
    direction: string
    required: boolean
    armed: boolean
    orderId: string
    price: number
    armedOrderIds: Set<string>
    rows: Array<{
      id: string
      entry: number
      stop: number
      tick: number
      liquidation: number
    }>
  }>()
  const exclusiveOrderOwners = new Map<string, Set<string>>()
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
    const rowLabel = String(position.id || `index-${index}`)
    for (const [kind, value] of [
      ["entry", position.orderId],
      ["stop-loss", position.stopLossOrderId],
      ["take-profit", position.takeProfitOrderId],
    ] as const) {
      const orderId = String(value || "").trim()
      if (!orderId) continue
      const owners = exclusiveOrderOwners.get(orderId) || new Set<string>()
      owners.add(`${rowLabel}:${kind}`)
      exclusiveOrderOwners.set(orderId, owners)
    }
    if (measures.closed > 0 && measures.accountingPending === 0) {
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
    for (const leg of ["stop_loss", "take_profit"] as const) {
      const quantityState = venueProtectionQuantityState(position, leg)
      if (quantityState === "covered") protection.venueLegsQuantityCovered++
      if (quantityState === "unknown") protection.venueLegsQuantityUnknown++
      if (quantityState === "drifted") protection.venueLegsQuantityDrifted++
    }
    if (isLiveOpenStatus(position.status) && measures.openQuantity > 0) {
      const security = effectiveSecurityProtection(position)
      const symbol = String(position.symbol || "").toUpperCase().replace(/[-/_:]/g, "")
      const direction = String(position.direction || position.side || "").toLowerCase()
      const key = `${symbol}|${direction}`
      const prior = securitySlots.get(key) || {
        symbol,
        direction,
        required: false,
        armed: false,
        orderId: "",
        price: 0,
        armedOrderIds: new Set<string>(),
        rows: [],
      }
      for (const orderId of collectArmedSecurityStopOrderIds(position)) {
        prior.armedOrderIds.add(orderId)
      }
      securitySlots.set(key, {
        ...prior,
        required: prior.required || security.required,
        armed: prior.armed || security.armed,
        orderId: prior.armed ? prior.orderId : security.armed ? security.orderId : prior.orderId || security.orderId,
        price: prior.armed ? prior.price : security.armed ? security.price : prior.price || security.price,
        rows: [...prior.rows, {
          id: rowLabel,
          entry: finite(position.averageExecutionPrice ?? position.entryPrice),
          stop: finite(position.stopLossPrice),
          tick: finite(position.priceTick),
          liquidation: finite(position.liquidationPrice ?? position.exchangeData?.liquidationPrice),
        }],
      })
    }
  })
  for (const [orderId, owners] of exclusiveOrderOwners) {
    if (owners.size > 1) {
      mismatches.push(`order ${orderId}: exclusive entry/row control is shared by ${[...owners].sort().join(", ")}`)
    }
  }
  const securityOrderSlots = new Map<string, Set<string>>()
  for (const [key, security] of securitySlots) {
    if (!security.required) continue
    protection.securityStopsRequired++
    if (security.armed) protection.securityStopsArmed++
    else protection.securityStopsMissing++
    if (!security.armed) continue

    if (security.armedOrderIds.size !== 1) {
      mismatches.push(`slot ${key}: expected one security order, found ${security.armedOrderIds.size}`)
    }
    for (const orderId of security.armedOrderIds) {
      const securitySlotsForOrder = securityOrderSlots.get(orderId) || new Set<string>()
      securitySlotsForOrder.add(key)
      securityOrderSlots.set(orderId, securitySlotsForOrder)
      if (exclusiveOrderOwners.has(orderId)) {
        mismatches.push(`slot ${key}: security order ${orderId} is also used by an entry/row control`)
      }
    }

    const completeRows = security.rows.filter((row) => row.entry > 0 && row.stop > 0)
    if (completeRows.length !== security.rows.length || completeRows.length === 0) {
      mismatches.push(`slot ${key}: security range cannot be verified for every open row`)
      continue
    }
    const ticks = security.rows.map((row) => row.tick)
    if (ticks.some((tick) => !(tick > 0))) {
      mismatches.push(`slot ${key}: security range has no authoritative price tick for every open row`)
      continue
    }
    const priceTick = Math.max(...ticks)
    const outerStop = security.direction === "long"
      ? Math.min(...completeRows.map((row) => row.stop))
      : Math.max(...completeRows.map((row) => row.stop))
    const maximumRange = Math.max(...completeRows.map((row) => Math.abs(row.entry - row.stop)))
    const requiredGap = Math.max(priceTick * 2, maximumRange * 0.1)
    const actualGap = security.direction === "long"
      ? outerStop - security.price
      : security.price - outerStop
    const tolerance = Math.max(1e-12, priceTick * 1e-8)
    if (actualGap + tolerance < requiredGap) {
      mismatches.push(
        `slot ${key}: security gap ${actualGap} < required ${requiredGap} from maximum row range ${maximumRange}`,
      )
    }

    const liquidations = security.rows.map((row) => row.liquidation).filter((value) => value > 0)
    if (liquidations.length > 0 && security.direction === "long") {
      const floor = Math.max(...liquidations) + priceTick * 2
      if (security.price + tolerance < floor) {
        mismatches.push(`slot ${key}: long security stop ${security.price} is not liquidation-safe above ${floor}`)
      }
    }
    if (liquidations.length > 0 && security.direction === "short") {
      const ceiling = Math.min(...liquidations) - priceTick * 2
      if (security.price - tolerance > ceiling) {
        mismatches.push(`slot ${key}: short security stop ${security.price} is not liquidation-safe below ${ceiling}`)
      }
    }
  }
  for (const [orderId, slots] of securityOrderSlots) {
    if (slots.size > 1) {
      mismatches.push(`security order ${orderId}: shared across physical slots ${[...slots].sort().join(", ")}`)
    }
  }
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
