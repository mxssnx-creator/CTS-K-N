/**
 * Deterministic quantity bookkeeping shared by Live-stage exchange actions.
 *
 * Exchange order snapshots report cumulative fills and are commonly observed
 * more than once (poll response, position reconciliation, restart recovery).
 * These helpers turn those repeated observations into an idempotent delta and
 * keep the exact Strategy-Set allocation equal to the authoritative open
 * quantity after every partial execution.
 */

export type PartialOrderExecutionSource =
  | "control_order"
  | "system_close"
  | "poscounts_reduce"
  | "exchange_reconcile"

export interface PartialOrderExecution {
  /** Stable identity. Re-observing this order updates the same row. */
  id: string
  source: PartialOrderExecutionSource
  orderId?: string
  clientOrderId?: string
  status: string
  requestedQuantity: number
  cumulativeFilledQuantity: number
  appliedQuantity: number
  positionQuantityBefore: number
  positionQuantityAfter: number
  price: number
  setKeys: string[]
  setQuantitiesBefore: Record<string, number>
  setQuantities: Record<string, number>
  /** Signed per-Set quantity changes; their sum equals the physical delta. */
  setQuantityDeltas: Record<string, number>
  updatedAt: number
}

export interface CumulativeReductionResult {
  deltaApplied: number
  cumulativeApplied: number
  nextQuantity: number
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function roundQuantity(value: number): number {
  return Number(Math.max(0, value).toFixed(12))
}

/**
 * Apply one cumulative reduce-order observation exactly once.
 *
 * `reportedFilledQuantity` is the venue's cumulative order fill. When an
 * authoritative position quantity is available it wins, because it also
 * captures fills from a control order whose order-detail endpoint is delayed.
 */
export function reconcileCumulativeReduction(
  currentQuantity: number,
  reportedFilledQuantity: number,
  previouslyAppliedQuantity: number,
  authoritativeQuantity?: number | null,
): CumulativeReductionResult {
  const current = finiteNonNegative(currentQuantity)
  const reported = finiteNonNegative(reportedFilledQuantity)
  const appliedBefore = finiteNonNegative(previouslyAppliedQuantity)
  const authoritative = authoritativeQuantity == null
    ? null
    : finiteNonNegative(authoritativeQuantity)

  const fromCumulative = Math.max(0, reported - appliedBefore)
  const fromAuthoritative = authoritative == null
    ? 0
    : Math.max(0, current - Math.min(current, authoritative))
  const deltaApplied = roundQuantity(Math.min(current, Math.max(fromCumulative, fromAuthoritative)))
  const nextQuantity = roundQuantity(current - deltaApplied)

  return {
    deltaApplied,
    cumulativeApplied: roundQuantity(appliedBefore + deltaApplied),
    nextQuantity,
  }
}

/** Equal per-Set allocation with a final remainder correction (sum is exact). */
export function allocateQuantityAcrossSets(
  quantity: number,
  setKeys: readonly string[] | null | undefined,
): Record<string, number> {
  const keys = Array.from(new Set((setKeys || []).map(String).map((key) => key.trim()).filter(Boolean)))
  const total = roundQuantity(finiteNonNegative(quantity))
  if (keys.length === 0 || total <= 0) return {}

  const share = total / keys.length
  const allocation: Record<string, number> = {}
  let assigned = 0
  keys.forEach((key, index) => {
    const value = index === keys.length - 1
      ? roundQuantity(total - assigned)
      : roundQuantity(share)
    allocation[key] = value
    assigned = roundQuantity(assigned + value)
  })
  return allocation
}

/** Weighted per-Set allocation with an exact final remainder correction. */
export function allocateQuantityByRatios(
  quantity: number,
  ratios: Readonly<Record<string, number>> | null | undefined,
  fallbackSetKeys?: readonly string[] | null,
): Record<string, number> {
  const normalized = Object.entries(ratios || {})
    .map(([key, value]) => [String(key).trim(), finiteNonNegative(value)] as const)
    .filter(([key, value]) => key.length > 0 && value > 0)
  if (normalized.length === 0) return allocateQuantityAcrossSets(quantity, fallbackSetKeys)

  const total = roundQuantity(finiteNonNegative(quantity))
  if (total <= 0) return {}
  const ratioTotal = normalized.reduce((sum, [, ratio]) => sum + ratio, 0)
  const allocation: Record<string, number> = {}
  let assigned = 0
  normalized.forEach(([key, ratio], index) => {
    const value = index === normalized.length - 1
      ? roundQuantity(total - assigned)
      : roundQuantity(total * (ratio / ratioTotal))
    allocation[key] = value
    assigned = roundQuantity(assigned + value)
  })
  return allocation
}

/** Bounded, idempotent execution ledger update. */
export function upsertPartialOrderExecution(
  current: readonly PartialOrderExecution[] | null | undefined,
  next: PartialOrderExecution,
  cap = 100,
): PartialOrderExecution[] {
  const rows = Array.isArray(current) ? [...current] : []
  const normalized: PartialOrderExecution = {
    ...next,
    id: String(next.id || "").trim(),
    orderId: next.orderId ? String(next.orderId) : undefined,
    clientOrderId: next.clientOrderId ? String(next.clientOrderId) : undefined,
    requestedQuantity: roundQuantity(finiteNonNegative(next.requestedQuantity)),
    cumulativeFilledQuantity: roundQuantity(finiteNonNegative(next.cumulativeFilledQuantity)),
    appliedQuantity: roundQuantity(finiteNonNegative(next.appliedQuantity)),
    positionQuantityBefore: roundQuantity(finiteNonNegative(next.positionQuantityBefore)),
    positionQuantityAfter: roundQuantity(finiteNonNegative(next.positionQuantityAfter)),
    price: finiteNonNegative(next.price),
    setKeys: Array.from(new Set((next.setKeys || []).map(String).filter(Boolean))),
    setQuantitiesBefore: { ...(next.setQuantitiesBefore || {}) },
    setQuantities: { ...(next.setQuantities || {}) },
    setQuantityDeltas: { ...(next.setQuantityDeltas || {}) },
    updatedAt: Number.isFinite(Number(next.updatedAt)) ? Number(next.updatedAt) : Date.now(),
  }
  if (!normalized.id) return rows.slice(-Math.max(1, cap))

  const existingIndex = rows.findIndex((row) => row.id === normalized.id)
  if (existingIndex >= 0) rows[existingIndex] = normalized
  else rows.push(normalized)
  return rows.slice(-Math.max(1, cap))
}

export function isActiveControlOrderStatus(status: unknown): boolean {
  const normalized = String(status || "").trim().toLowerCase()
  return ["new", "open", "pending", "placed", "partially_filled", "partial_fill"].includes(normalized)
}

export function isFilledControlOrderStatus(status: unknown): boolean {
  const normalized = String(status || "").trim().toLowerCase()
  return normalized === "filled" || normalized === "closed"
}

export type ControlOrderBarrierDecision = "wait" | "proceed_system" | "exchange_closed"

/**
 * Pure barrier decision used by the multi-cycle tests and the Live executor.
 * Unknown/pending coordination never permits a simultaneous system action.
 */
export function decideControlOrderBarrier(input: {
  localQuantity: number
  authoritativeQuantity?: number | null
  authoritativeSnapshot: boolean
  activeControlOrders: number
  unresolvedControlOrders: number
  pendingSubmissions: number
}): ControlOrderBarrierDecision {
  const local = finiteNonNegative(input.localQuantity)
  if (
    input.authoritativeSnapshot &&
    input.authoritativeQuantity != null &&
    finiteNonNegative(input.authoritativeQuantity) <= Math.max(1e-12, local * 1e-8)
  ) {
    return "exchange_closed"
  }
  if (
    input.activeControlOrders > 0 ||
    input.unresolvedControlOrders > 0 ||
    input.pendingSubmissions > 0
  ) {
    return "wait"
  }
  return "proceed_system"
}
