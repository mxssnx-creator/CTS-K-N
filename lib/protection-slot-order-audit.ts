import type { AggregateProtectionPlan } from "@/lib/aggregate-protection-coordination"

export type ProtectionSlotDirection = "long" | "short"

export interface ProtectionSlotMemberSnapshot {
  id: string
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

function protectionOrderType(order: Record<string, any>): string {
  return firstText(order?.type, order?.orderType, order?.order_type)
    .toUpperCase()
    .replace(/[^A-Z]/g, "_")
}

function protectionOrderKind(order: Record<string, any>): "stop_loss" | "take_profit" | null {
  const type = protectionOrderType(order)
  if (type.includes("TAKE_PROFIT")) return "take_profit"
  if (type.includes("STOP")) return "stop_loss"
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
  return firstPositive(order?.stopPrice, order?.triggerPrice, order?.trigger_price, order?.price)
}

function protectionOrderDirection(
  order: Record<string, any>,
  options: { requireExplicitPositionSide?: boolean } = {},
): ProtectionSlotDirection | null {
  const positionSide = firstText(order?.positionSide, order?.position_side).toLowerCase()
  if (positionSide === "long") return "long"
  if (positionSide === "short") return "short"
  if (options.requireExplicitPositionSide) return null
  const closeSide = firstText(order?.side, order?.orderSide).toLowerCase()
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
    && protectionOrderKind(order) !== null
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
  plan: Pick<AggregateProtectionPlan, "venueQuantity" | "quantityTolerance" | "securityStopPrice">
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
  const findExpectedOrder = (identifier: string): { order: Record<string, any>; index: number } | null => {
    const matches = orders
      .map((order, index) => ({ order, index }))
      .filter(({ order }) => protectionOrderIdentifiers(order).has(identifier))
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
    if (protectionOrderKind(matched.order) !== options.kind) {
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

  for (const member of input.members) {
    if (
      normalizeProtectionSlotSymbol(member.symbol) !== symbol
      || memberDirection(member) !== input.direction
      || !(memberQuantity(member) > 0)
    ) {
      addViolation(violations, "member_slot_mismatch")
      continue
    }
    const quantity = memberQuantity(member)
    if (validateExpected({
      identifier: member.stopLossOrderId,
      kind: "stop_loss",
      expectedQuantity: quantity,
      armedQuantity: Math.abs(finite(member.stopLossArmedQuantity)),
      expectedTrigger: finite(member.stopLossPrice),
      priceTick: finite(member.priceTick),
      violationPrefix: "row_stop_loss",
    })) exactStopLossOrders++
    if (validateExpected({
      identifier: member.takeProfitOrderId,
      kind: "take_profit",
      expectedQuantity: quantity,
      armedQuantity: Math.abs(finite(member.takeProfitArmedQuantity)),
      expectedTrigger: finite(member.takeProfitPrice),
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

  const expectedControlOrderCount = input.members.length * 2 + 1
  const expectedComplete = violations.length === 0
    && exactStopLossOrders === input.members.length
    && exactTakeProfitOrders === input.members.length
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
