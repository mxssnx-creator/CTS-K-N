export const BINGX_CONTROL_ORDER_LIMIT = 200

export type ProtectionOrderLeg = "stop_loss" | "take_profit"

export interface ControlOrderCapacitySnapshot {
  limit: number
  observedOpen: number
  reserved: number
  available: number
  exhausted: boolean
}

function normalizedOrderType(order: Record<string, any>): string {
  return String(
    order.type
    ?? order.orderType
    ?? order.origType
    ?? order.triggerType
    ?? order.stopOrderType
    ?? "",
  ).trim().toUpperCase().replace(/[\s-]+/g, "_")
}

/**
 * BingX error 110206 is scoped to open TP/SL orders. Count venue rows rather
 * than the liveness Set because that Set intentionally contains both venue and
 * client IDs for one order and therefore is not a cardinality measure.
 */
export function isBingXControlOrder(order: Record<string, any>): boolean {
  const type = normalizedOrderType(order)
  if (
    type.includes("STOP")
    || type.includes("TAKE_PROFIT")
    || type.includes("TAKEPROFIT")
    || type.includes("TRIGGER")
    || type === "TP"
    || type === "SL"
  ) return true
  return [
    order.stopPrice,
    order.triggerPrice,
    order.stopLossPrice,
    order.takeProfitPrice,
    order.activatePrice,
  ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0)
}

function orderIdentity(order: Record<string, any>, index: number): string {
  const id = order.orderId ?? order.orderID ?? order.id
  return id == null || String(id).trim() === "" ? `row:${index}` : `venue:${String(id)}`
}

export function countUniqueBingXControlOrders(orders: readonly Record<string, any>[]): number {
  const ids = new Set<string>()
  orders.forEach((order, index) => {
    if (isBingXControlOrder(order)) ids.add(orderIdentity(order, index))
  })
  return ids.size
}

/**
 * One synchronous, shared budget per authoritative open-order snapshot. Calls
 * from parallel position workers reserve synchronously before their first
 * await, so 199/200 cannot become 201/200 inside one reconcile batch.
 */
export class ControlOrderCapacityBudget {
  private observedOpen: number
  private readonly reservations = new Set<string>()
  private readonly releasedOrderIds = new Set<string>()

  constructor(
    observedOpen: number,
    readonly limit = BINGX_CONTROL_ORDER_LIMIT,
  ) {
    this.observedOpen = Math.max(0, Math.min(limit, Math.floor(Number(observedOpen) || 0)))
  }

  reserve(reservationId: string): boolean {
    const id = String(reservationId || "").trim()
    if (!id) return false
    if (this.reservations.has(id)) return true
    if (this.observedOpen + this.reservations.size >= this.limit) return false
    this.reservations.add(id)
    return true
  }

  releaseReservation(reservationId: string): void {
    this.reservations.delete(String(reservationId || "").trim())
  }

  noteCancellation(orderId: unknown): void {
    const id = String(orderId ?? "").trim()
    if (!id || this.releasedOrderIds.has(id)) return
    this.releasedOrderIds.add(id)
    this.observedOpen = Math.max(0, this.observedOpen - 1)
  }

  markExhausted(): void {
    this.observedOpen = this.limit
    this.reservations.clear()
  }

  snapshot(): ControlOrderCapacitySnapshot {
    const reserved = this.reservations.size
    const available = Math.max(0, this.limit - this.observedOpen - reserved)
    return {
      limit: this.limit,
      observedOpen: this.observedOpen,
      reserved,
      available,
      exhausted: available === 0,
    }
  }
}

export interface ProtectionOrderIntent {
  connectionId: string
  symbol: string
  direction: "long" | "short"
  leg: ProtectionOrderLeg
  triggerPrice: number
  quantity: number
  strategyId: string
}

export interface ProtectionOrderBatch {
  batchKey: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  leg: ProtectionOrderLeg
  triggerPrice: number
  quantity: number
  strategyIds: string[]
  sourceIntentCount: number
  handling: "venue_control" | "system_close"
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/[-_/:]/g, "")
}

/**
 * Consolidate only economically identical protection intents. Different
 * symbols, sides, legs or trigger prices remain independent; merging those
 * would silently change strategy risk. Stop-loss batches receive capacity
 * before take-profit batches, and larger lineage groups win ties so the
 * available venue slots protect the greatest number of strategy relations.
 */
export function planProtectionOrderBatches(input: {
  intents: readonly ProtectionOrderIntent[]
  observedOpenControlOrders: number
  limit?: number
}): {
  batches: ProtectionOrderBatch[]
  venueBatches: ProtectionOrderBatch[]
  systemBatches: ProtectionOrderBatch[]
  sourceIntentCount: number
  combinedOrderCount: number
  avoidedOrderCount: number
  capacity: ControlOrderCapacitySnapshot
} {
  const grouped = new Map<string, ProtectionOrderBatch>()
  for (const intent of input.intents) {
    const symbol = normalizedSymbol(intent.symbol)
    const triggerPrice = Number(intent.triggerPrice)
    const quantity = Number(intent.quantity)
    const strategyId = String(intent.strategyId || "").trim()
    if (!symbol || !(triggerPrice > 0) || !(quantity > 0) || !strategyId) continue
    const key = [
      String(intent.connectionId || ""),
      symbol,
      intent.direction,
      intent.leg,
      triggerPrice.toPrecision(15),
    ].join(":")
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += quantity
      existing.sourceIntentCount += 1
      if (!existing.strategyIds.includes(strategyId)) existing.strategyIds.push(strategyId)
    } else {
      grouped.set(key, {
        batchKey: key,
        connectionId: String(intent.connectionId || ""),
        symbol,
        direction: intent.direction,
        leg: intent.leg,
        triggerPrice,
        quantity,
        strategyIds: [strategyId],
        sourceIntentCount: 1,
        handling: "system_close",
      })
    }
  }
  const batches = [...grouped.values()].sort((left, right) => {
    if (left.leg !== right.leg) return left.leg === "stop_loss" ? -1 : 1
    if (left.sourceIntentCount !== right.sourceIntentCount) return right.sourceIntentCount - left.sourceIntentCount
    return left.batchKey.localeCompare(right.batchKey)
  })
  const budget = new ControlOrderCapacityBudget(
    input.observedOpenControlOrders,
    input.limit ?? BINGX_CONTROL_ORDER_LIMIT,
  )
  for (const batch of batches) {
    if (budget.reserve(batch.batchKey)) batch.handling = "venue_control"
  }
  const venueBatches = batches.filter((batch) => batch.handling === "venue_control")
  const systemBatches = batches.filter((batch) => batch.handling === "system_close")
  return {
    batches,
    venueBatches,
    systemBatches,
    sourceIntentCount: input.intents.length,
    combinedOrderCount: batches.length,
    avoidedOrderCount: Math.max(0, input.intents.length - batches.length),
    capacity: budget.snapshot(),
  }
}
