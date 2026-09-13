import type { AggregateProtectionPlan } from "@/lib/aggregate-protection-coordination"

export type ProtectionSlotDirection = "long" | "short"

export interface ProtectionSlotMemberSnapshot {
  id: string
  controlOrderScope?: "per_order" | "symbol_direction"
  aggregateProtectionOwner?: boolean
  symbol: string
  direction?: ProtectionSlotDirection
  side?: string
  executedQuantity?: number
  quantity?: number
  quantityStep?: number
  priceTick?: number
  stopLossOrderId?: string
  takeProfitOrderId?: string
  securityStopOrderId?: string
  stopLossPrice?: number
  takeProfitPrice?: number
  securityStopPrice?: number
  stopLossArmedQuantity?: number
  takeProfitArmedQuantity?: number
  securityStopArmedQuantity?: number
}

export interface ProtectionSlotOrphanOrder {
  orderId: string
  clientOrderId: string
  order: Record<string, any>
}

export interface ProtectionSlotOrderAudit {
  expectedComplete: boolean
  complete: boolean
  rowCount: number
  expectedControlOrderCount: number
  observedExpectedControlOrderCount: number
  exactStopLossOrders: number
  exactTakeProfitOrders: number
  exactSecurityOrders: number
  connectionOwnedSlotControlOrders: number
  externalOrUnknownSlotControlOrdersPreserved: number
  orphanOrders: ProtectionSlotOrphanOrder[]
  expectedOrderIds: Set<string>
  violations: string[]
}

/**
 * A proof that an already-open venue position is protected by one complete
 * CTS-owned physical slot.  This is deliberately stricter than the normal
 * row audit: it is used only when Redis lost the local position lineage and
 * the engine must decide whether it may safely recover the venue state.
 */
export interface ConnectionOwnedProtectionBook {
  safe: boolean
  reason: string
  quantity: number
  positionIdentity?: string
  stopLossOrder: Record<string, any> | null
  takeProfitOrder: Record<string, any> | null
  securityStopOrder: Record<string, any> | null
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const normalized = text(value)
    if (normalized) return normalized
  }
  return ""
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = finite(value)
    if (parsed > 0) return parsed
  }
  return 0
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase())
}

export function normalizeProtectionSlotSymbol(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function protectionClientOrderPrefix(connectionId: unknown): string {
  const connection = text(connectionId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  return `cts${connection || "x"}`.toLowerCase()
}

export function protectionOrderVenueId(order: Record<string, any>): string {
  return firstText(order?.id, order?.orderId, order?.orderID, order?.ordId)
}

export function protectionOrderClientId(order: Record<string, any>): string {
  return firstText(
    order?.clientOrderId,
    order?.clientOrderID,
    order?.client_order_id,
    order?.client_oid,
    order?.clOrdId,
  )
}

export function protectionOrderIdentifiers(order: Record<string, any>): Set<string> {
  return new Set([
    protectionOrderVenueId(order),
    protectionOrderClientId(order),
  ].filter(Boolean))
}

function protectionOrderKindFromText(value: unknown): "stop_loss" | "take_profit" | null {
  const type = text(value).toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!type) return null
  if (type.includes("TAKEPROFIT") || type === "TP") return "take_profit"
  if (
    type.includes("STOPLOSS")
    || type.includes("TRAILINGSTOP")
    || type === "STOP"
    || type === "SL"
    || type.includes("STOPMARKET")
    || type.includes("STOPLIMIT")
  ) return "stop_loss"
  return null
}

function protectionOrderKind(
  order: Record<string, any>,
  direction?: ProtectionSlotDirection,
): "stop_loss" | "take_profit" | null {
  // Bybit puts the conditional family in stopOrderType while the common
  // connector type remains `market`. Check the native family first so a
  // normalized conditional order is not mistaken for an ordinary market
  // order during recovery.
  for (const value of [
    order?.stopOrderType,
    order?.stop_order_type,
    order?.conditionalOrderType,
    order?.conditional_order_type,
    order?.triggerOrderType,
    order?.trigger_order_type,
    order?.type,
    order?.orderType,
    order?.order_type,
  ]) {
    const kind = protectionOrderKindFromText(value)
    if (kind) return kind
  }

  // Some Bybit responses expose only triggerDirection for an active
  // conditional order. Direction 1 means price rises through the trigger and
  // direction 2 means it falls; the TP/SL meaning depends on the hedge leg.
  const trigger = firstPositive(
    order?.triggerPrice,
    order?.trigger_price,
    order?.stopPrice,
    order?.stop_price,
  )
  const triggerDirection = Number(order?.triggerDirection ?? order?.trigger_direction)
  const resolvedDirection = direction || protectionOrderDirection(order)
  if (trigger > 0 && (triggerDirection === 1 || triggerDirection === 2) && resolvedDirection) {
    const isTakeProfit = resolvedDirection === "long"
      ? triggerDirection === 1
      : triggerDirection === 2
    return isTakeProfit ? "take_profit" : "stop_loss"
  }
  return null
}

function protectionOrderQuantity(order: Record<string, any>): number {
  return firstPositive(
    Math.abs(finite(order?.origQty)),
    Math.abs(finite(order?.quantity)),
    Math.abs(finite(order?.orderQty)),
    Math.abs(finite(order?.qty)),
    Math.abs(finite(order?.size)),
  )
}

function protectionOrderTrigger(order: Record<string, any>): number {
  return firstPositive(
    order?.stopPrice,
    order?.triggerPrice,
    order?.trigger_price,
    order?.stop_price,
    order?.price,
  )
}

function protectionOrderDirection(
  order: Record<string, any>,
  options: { requireExplicitPositionSide?: boolean } = {},
): ProtectionSlotDirection | null {
  const positionSide = firstText(order?.positionSide, order?.position_side).toLowerCase()
  if (positionSide === "long") return "long"
  if (positionSide === "short") return "short"
  const rawPositionIdx = order?.positionIdx ?? order?.position_idx
  const positionIdx = rawPositionIdx === undefined || rawPositionIdx === null || rawPositionIdx === ""
    ? Number.NaN
    : finite(rawPositionIdx)
  if (positionIdx === 1) return "long"
  if (positionIdx === 2) return "short"
  const closeSide = firstText(order?.side, order?.orderSide).toLowerCase()
  // Bybit's one-way mode explicitly reports positionIdx=0. The close side is
  // then the authoritative direction because no separate hedge leg exists.
  // An explicit BOTH marker has the same semantics on other derivatives APIs.
  if (options.requireExplicitPositionSide && (positionIdx === 0 || positionSide === "both")) {
    if (closeSide === "sell") return "long"
    if (closeSide === "buy") return "short"
  }
  if (options.requireExplicitPositionSide) return null
  if (closeSide === "sell") return "long"
  if (closeSide === "buy") return "short"
  return null
}

function isControlOrder(order: Record<string, any>): boolean {
  return protectionOrderKind(order) !== null || truthy(
    order?.reduceOnly
    ?? order?.reduce_only
    ?? order?.closePosition
    ?? order?.isReduceOnly,
  )
}

function orderMatchesSlot(
  order: Record<string, any>,
  symbol: string,
  direction: ProtectionSlotDirection,
  options: { requireExplicitPositionSide?: boolean } = {},
): boolean {
  if (normalizeProtectionSlotSymbol(order?.symbol) !== symbol) return false
  if (!isControlOrder(order)) return false
  if (protectionOrderDirection(order, options) !== direction) return false
  const closeSide = firstText(order?.side, order?.orderSide).toLowerCase()
  return closeSide === (direction === "long" ? "sell" : "buy")
}

/**
 * Read-only slot classifier used by entry admission. It intentionally makes
 * no ownership claim: any reduce/control order in a previously empty physical
 * slot can affect the first position opened there, so admission must preserve
 * it and refuse the new entry instead of cancelling or adopting it.
 */
export function isProtectionControlOrderForSlot(
  order: Record<string, any>,
  symbol: string,
  direction: ProtectionSlotDirection,
): boolean {
  return orderMatchesSlot(
    order,
    normalizeProtectionSlotSymbol(symbol),
    direction,
  )
}

export function isConnectionOwnedProtectionOrderForSlot(
  order: Record<string, any>,
  connectionId: string,
  symbol: string,
  direction: ProtectionSlotDirection,
): boolean {
  const clientOrderId = protectionOrderClientId(order).toLowerCase()
  return clientOrderId.startsWith(protectionClientOrderPrefix(connectionId))
    && orderMatchesSlot(
      order,
      normalizeProtectionSlotSymbol(symbol),
      direction,
      { requireExplicitPositionSide: true },
    )
    && protectionOrderKind(order, direction) !== null
}

/**
 * Classify the exact open protection book for one physical venue slot.
 *
 * Recovery is allowed only when the slot contains exactly three controls:
 * one TP and two CTS-owned stops (the row stop plus the farther security
 * stop).  Any extra, foreign, implicit-side, wrong-quantity, or ambiguous
 * control makes the proof fail closed.  The caller must preserve every
 * order when this returns false; this helper never authorizes cancellation.
 *
 * BingX can return very large position IDs as JavaScript numbers.  We only
 * require all control orders to agree with one another; comparing them to a
 * separately parsed position ID would reject valid books after numeric
 * precision has already been lost by the connector.
 */
export function classifyConnectionOwnedProtectionBook(input: {
  connectionId: string
  symbol: string
  direction: ProtectionSlotDirection
  venueQuantity: number
  entryPrice: number
  openOrders: readonly Record<string, any>[]
}): ConnectionOwnedProtectionBook {
  const empty = (reason: string): ConnectionOwnedProtectionBook => ({
    safe: false,
    reason,
    quantity: Math.abs(finite(input.venueQuantity)),
    stopLossOrder: null,
    takeProfitOrder: null,
    securityStopOrder: null,
  })
  const symbol = normalizeProtectionSlotSymbol(input.symbol)
  const quantity = Math.abs(finite(input.venueQuantity))
  const entryPrice = finite(input.entryPrice)
  if (!symbol || !["long", "short"].includes(input.direction) || !(quantity > 0) || !(entryPrice > 0)) {
    return empty("invalid_slot_inputs")
  }

  const slotOrders = input.openOrders
    .map((order) => order as Record<string, any>)
    .filter((order) => orderMatchesSlot(order, symbol, input.direction))
  if (slotOrders.length !== 3) return empty("exact_slot_control_count_mismatch")

  const owned = slotOrders.filter((order) => isConnectionOwnedProtectionOrderForSlot(
    order,
    input.connectionId,
    symbol,
    input.direction,
  ))
  if (owned.length !== slotOrders.length) return empty("foreign_or_unknown_slot_control_present")
  if (owned.some((order) => protectionOrderKind(order, input.direction) === null)) return empty("non_protection_slot_control_present")

  const takeProfitOrders = owned.filter((order) => protectionOrderKind(order, input.direction) === "take_profit")
  const stopLossOrders = owned.filter((order) => protectionOrderKind(order, input.direction) === "stop_loss")
  if (takeProfitOrders.length !== 1 || stopLossOrders.length !== 2) {
    return empty("protection_leg_count_mismatch")
  }

  const quantityTolerance = Math.max(1e-10, quantity * 1e-8)
  if (owned.some((order) => !quantitiesMatch(protectionOrderQuantity(order), quantity, quantityTolerance))) {
    return empty("protection_quantity_mismatch")
  }

  const takeProfitOrder = takeProfitOrders[0]
  const takeProfitTrigger = protectionOrderTrigger(takeProfitOrder)
  const stopTriggers = stopLossOrders.map((order) => ({
    order,
    trigger: protectionOrderTrigger(order),
  }))
  if (!(takeProfitTrigger > 0) || stopTriggers.some(({ trigger }) => !(trigger > 0))) {
    return empty("protection_trigger_missing")
  }
  if (input.direction === "long") {
    if (!(takeProfitTrigger > entryPrice) || stopTriggers.some(({ trigger }) => trigger >= entryPrice)) {
      return empty("long_protection_range_invalid")
    }
  } else if (!(takeProfitTrigger < entryPrice) || stopTriggers.some(({ trigger }) => trigger <= entryPrice)) {
    return empty("short_protection_range_invalid")
  }

  const stopIdentity = (order: Record<string, any>): string => firstText(
    order?.positionID,
    order?.positionId,
    order?.position_id,
  )
  const positionIdentities = [...new Set(stopLossOrders.concat(takeProfitOrders).map(stopIdentity).filter(Boolean))]
  if (positionIdentities.length > 1) return empty("control_position_identity_mismatch")

  const taggedSecurity = stopTriggers.filter(({ order }) => {
    const clientId = protectionOrderClientId(order).toLowerCase()
    return clientId.includes("security") || clientId.includes("sec")
  })
  if (taggedSecurity.length > 1) return empty("multiple_security_stop_candidates")

  const sortedStops = [...stopTriggers].sort((left, right) => input.direction === "long"
    ? left.trigger - right.trigger
    : right.trigger - left.trigger)
  const securityStop = taggedSecurity[0]?.order || sortedStops[0]?.order
  const rowStop = sortedStops.find(({ order }) => order !== securityStop)?.order || null
  if (!securityStop || !rowStop) return empty("security_stop_selection_failed")

  const triggerTolerance = Math.max(1e-12, entryPrice * 1e-10)
  const securityTrigger = protectionOrderTrigger(securityStop)
  const rowTrigger = protectionOrderTrigger(rowStop)
  if (Math.abs(securityTrigger - rowTrigger) <= triggerTolerance) {
    return empty("security_stop_range_ambiguous")
  }
  const securityIsFarther = input.direction === "long"
    ? securityTrigger < rowTrigger
    : securityTrigger > rowTrigger
  if (!securityIsFarther) return empty("security_stop_not_farther_than_row_stop")

  return {
    safe: true,
    reason: "ok",
    quantity,
    ...(positionIdentities[0] ? { positionIdentity: positionIdentities[0] } : {}),
    stopLossOrder: rowStop,
    takeProfitOrder,
    securityStopOrder: securityStop,
  }
}

function quantitiesMatch(actual: number, expected: number, tolerance: number): boolean {
  return actual > 0 && expected > 0 && Math.abs(actual - expected) <= tolerance
}

function pricesMatch(actual: number, expected: number, tick: number): boolean {
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-10, finite(tick) / 2)
  return actual > 0 && expected > 0 && Math.abs(actual - expected) <= tolerance
}

function memberDirection(member: ProtectionSlotMemberSnapshot): ProtectionSlotDirection | null {
  const value = text(member.direction ?? member.side).toLowerCase()
  if (value === "long" || value === "buy") return "long"
  if (value === "short" || value === "sell") return "short"
  return null
}

function memberQuantity(member: ProtectionSlotMemberSnapshot): number {
  return Math.abs(finite(member.executedQuantity ?? member.quantity))
}

function addViolation(violations: string[], code: string): void {
  if (!violations.includes(code)) violations.push(code)
}

/**
 * Audit one exact physical symbol/direction slot without attributing any
 * foreign order to CTS. Every logical row must own one exact-quantity SL and
 * TP; exactly one row must own the full-slot security stop selected by the
 * aggregate plan. Raw identifiers are retained only for the caller's guarded
 * cancellation allow-list and must not be serialized into operator reports.
 */
export function auditProtectionSlotOrders(input: {
  connectionId: string
  symbol: string
  direction: ProtectionSlotDirection
  members: readonly ProtectionSlotMemberSnapshot[]
  plan: Pick<AggregateProtectionPlan, "venueQuantity" | "quantityTolerance" | "securityStopPrice"> & Partial<Pick<AggregateProtectionPlan, "desiredStopLoss" | "desiredTakeProfit">>
  openOrders: readonly Record<string, any>[]
}): ProtectionSlotOrderAudit {
  const symbol = normalizeProtectionSlotSymbol(input.symbol)
  const quantityTolerance = Math.max(1e-12, finite(input.plan.quantityTolerance))
  const violations: string[] = []
  const expectedOrderIds = new Set<string>()
  const matchedOrderIndexes = new Set<number>()
  let exactStopLossOrders = 0
  let exactTakeProfitOrders = 0
  let exactSecurityOrders = 0

  const orders = input.openOrders.map((order) => order as Record<string, any>)
  const ordersById = new Map<string, { order: Record<string, any>; index: number }[]>()
  orders.forEach((order, index) => {
    for (const id of protectionOrderIdentifiers(order)) {
      const entries = ordersById.get(id) || []
      entries.push({ order, index })
      ordersById.set(id, entries)
    }
  })
  const findExpectedOrder = (identifier: string): { order: Record<string, any>; index: number } | null => {
    const matches = ordersById.get(identifier) || []
    if (matches.length !== 1) return null
    return matches[0]
  }

  const validateExpected = (options: {
    identifier: string | undefined
    kind: "stop_loss" | "take_profit"
    expectedQuantity: number
    armedQuantity: number
    expectedTrigger: number
    priceTick: number
    violationPrefix: string
  }): boolean => {
    const identifier = text(options.identifier)
    if (!identifier) {
      addViolation(violations, `${options.violationPrefix}_id_missing`)
      return false
    }
    if (expectedOrderIds.has(identifier)) {
      addViolation(violations, "expected_order_id_reused")
      return false
    }
    expectedOrderIds.add(identifier)
    const matched = findExpectedOrder(identifier)
    if (!matched) {
      addViolation(violations, `${options.violationPrefix}_not_authoritatively_open`)
      return false
    }
    matchedOrderIndexes.add(matched.index)
    let valid = true
    if (!orderMatchesSlot(matched.order, symbol, input.direction)) {
      addViolation(violations, `${options.violationPrefix}_slot_mismatch`)
      valid = false
    }
    if (!isConnectionOwnedProtectionOrderForSlot(
      matched.order,
      input.connectionId,
      symbol,
      input.direction,
    )) {
      addViolation(violations, `${options.violationPrefix}_connection_owner_mismatch`)
      valid = false
    }
    if (protectionOrderKind(matched.order, input.direction) !== options.kind) {
      addViolation(violations, `${options.violationPrefix}_kind_mismatch`)
      valid = false
    }
    if (!quantitiesMatch(
      protectionOrderQuantity(matched.order),
      options.expectedQuantity,
      quantityTolerance,
    )) {
      addViolation(violations, `${options.violationPrefix}_venue_quantity_mismatch`)
      valid = false
    }
    if (!quantitiesMatch(options.armedQuantity, options.expectedQuantity, quantityTolerance)) {
      addViolation(violations, `${options.violationPrefix}_local_quantity_mismatch`)
      valid = false
    }
    if (!pricesMatch(
      protectionOrderTrigger(matched.order),
      options.expectedTrigger,
      options.priceTick,
    )) {
      addViolation(violations, `${options.violationPrefix}_trigger_mismatch`)
      valid = false
    }
    return valid
  }

  const shared = input.members.some((member) => member.controlOrderScope === "symbol_direction")
  const sharedOwners = input.members.filter((member) => member.aggregateProtectionOwner === true)
  if (shared && (sharedOwners.length !== 1 || input.members.some((member) => member.controlOrderScope !== "symbol_direction"))) {
    addViolation(violations, "shared_control_owner_mismatch")
  }
  for (const member of input.members) {
    if (
      normalizeProtectionSlotSymbol(member.symbol) !== symbol
      || memberDirection(member) !== input.direction
      || !(memberQuantity(member) > 0)
    ) {
      addViolation(violations, "member_slot_mismatch")
      continue
    }
    if (shared && member !== sharedOwners[0]) {
      if (member.stopLossOrderId || member.takeProfitOrderId) addViolation(violations, "shared_child_control_present")
      continue
    }
    const quantity = shared ? finite(input.plan.venueQuantity) : memberQuantity(member)
    if (validateExpected({
      identifier: member.stopLossOrderId,
      kind: "stop_loss",
      expectedQuantity: quantity,
      armedQuantity: Math.abs(finite(member.stopLossArmedQuantity)),
      expectedTrigger: finite(shared ? input.plan.desiredStopLoss : member.stopLossPrice),
      priceTick: finite(member.priceTick),
      violationPrefix: "row_stop_loss",
    })) exactStopLossOrders++
    if (validateExpected({
      identifier: member.takeProfitOrderId,
      kind: "take_profit",
      expectedQuantity: quantity,
      armedQuantity: Math.abs(finite(member.takeProfitArmedQuantity)),
      expectedTrigger: finite(shared ? input.plan.desiredTakeProfit : member.takeProfitPrice),
      priceTick: finite(member.priceTick),
      violationPrefix: "row_take_profit",
    })) exactTakeProfitOrders++
  }

  const securityOwners = input.members.filter((member) => text(member.securityStopOrderId))
  if (securityOwners.length !== 1) {
    addViolation(violations, "security_owner_count_mismatch")
  } else {
    const owner = securityOwners[0]
    if (validateExpected({
      identifier: owner.securityStopOrderId,
      kind: "stop_loss",
      expectedQuantity: finite(input.plan.venueQuantity),
      armedQuantity: Math.abs(finite(owner.securityStopArmedQuantity)),
      expectedTrigger: finite(input.plan.securityStopPrice),
      priceTick: finite(owner.priceTick),
      violationPrefix: "security_stop",
    })) exactSecurityOrders++
  }

  const exactSlotControls = orders.filter((order) => orderMatchesSlot(order, symbol, input.direction))
  const connectionOwned = exactSlotControls.filter((order) =>
    isConnectionOwnedProtectionOrderForSlot(
      order,
      input.connectionId,
      symbol,
      input.direction,
    ),
  )
  const orphanOrders: ProtectionSlotOrphanOrder[] = []
  for (const order of connectionOwned) {
    const identifiers = protectionOrderIdentifiers(order)
    if ([...identifiers].some((identifier) => expectedOrderIds.has(identifier))) continue
    const orderId = protectionOrderVenueId(order)
    const clientOrderId = protectionOrderClientId(order)
    if (!orderId || !clientOrderId) {
      addViolation(violations, "owned_orphan_identifier_missing")
      continue
    }
    orphanOrders.push({ orderId, clientOrderId, order })
  }

  const expectedPairs = shared ? 1 : input.members.length
  const expectedControlOrderCount = expectedPairs * 2 + 1
  const expectedComplete = violations.length === 0
    && exactStopLossOrders === expectedPairs
    && exactTakeProfitOrders === expectedPairs
    && exactSecurityOrders === 1
    && matchedOrderIndexes.size === expectedControlOrderCount

  return {
    expectedComplete,
    complete: expectedComplete && orphanOrders.length === 0,
    rowCount: input.members.length,
    expectedControlOrderCount,
    observedExpectedControlOrderCount: matchedOrderIndexes.size,
    exactStopLossOrders,
    exactTakeProfitOrders,
    exactSecurityOrders,
    connectionOwnedSlotControlOrders: connectionOwned.length,
    externalOrUnknownSlotControlOrdersPreserved: Math.max(0, exactSlotControls.length - connectionOwned.length),
    orphanOrders,
    expectedOrderIds,
    violations,
  }
}
