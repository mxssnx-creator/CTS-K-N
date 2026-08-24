export interface ExchangeQuantityAdjustmentRecord {
  id: string
  source: string
  orderId?: string
  quantity: number
  price: number
  timestamp: number
}

interface FillQuantityRecord {
  quantity?: unknown
}

export interface ReconciledExchangeQuantityLedger {
  adjustments: ExchangeQuantityAdjustmentRecord[]
  changed: boolean
  fillQuantity: number
  unmanagedAdjustmentQuantity: number
  expectedManagedAdjustmentQuantity: number
  previousManagedAdjustmentQuantity: number
}

const MANAGED_SOURCES = new Set(["exchange_reconcile", "legacy_reconciliation"])

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function roundedQuantity(value: number): number {
  return Number(Math.max(0, value).toFixed(12))
}

/**
 * Keep the venue-observed quantity gap equal to `target - proven fills`.
 * Reconciliation gaps are provisional evidence, not additional executions:
 * once exact order fills arrive they must replace (or shrink) the adjustment
 * instead of being added on top of it forever.
 */
export function reconcileExchangeQuantityAdjustments(input: {
  positionId: string
  orderId?: string
  targetQuantity: number
  entryPrice: number
  fills?: readonly FillQuantityRecord[]
  adjustments?: readonly ExchangeQuantityAdjustmentRecord[]
  source?: "exchange_reconcile" | "legacy_reconciliation"
  timestamp?: number
  tolerance?: number
}): ReconciledExchangeQuantityLedger {
  const fills = Array.isArray(input.fills) ? input.fills : []
  const adjustments = Array.isArray(input.adjustments) ? input.adjustments : []
  const targetQuantity = finitePositive(input.targetQuantity)
  const entryPrice = finitePositive(input.entryPrice)
  const fillQuantity = fills.reduce((sum, fill) => sum + finitePositive(fill?.quantity), 0)
  const managed = adjustments.filter((adjustment) => MANAGED_SOURCES.has(String(adjustment?.source || "")))
  const unmanaged = adjustments.filter((adjustment) => !MANAGED_SOURCES.has(String(adjustment?.source || "")))
  const unmanagedAdjustmentQuantity = unmanaged.reduce(
    (sum, adjustment) => sum + finitePositive(adjustment?.quantity),
    0,
  )
  const previousManagedAdjustmentQuantity = managed.reduce(
    (sum, adjustment) => sum + finitePositive(adjustment?.quantity),
    0,
  )
  const expectedManagedAdjustmentQuantity = roundedQuantity(
    targetQuantity - fillQuantity - unmanagedAdjustmentQuantity,
  )
  const tolerance = Math.max(
    1e-12,
    Number.isFinite(Number(input.tolerance)) ? Math.abs(Number(input.tolerance)) : 0,
    targetQuantity * 1e-8,
  )
  if (Math.abs(previousManagedAdjustmentQuantity - expectedManagedAdjustmentQuantity) <= tolerance) {
    return {
      adjustments: [...adjustments],
      changed: false,
      fillQuantity,
      unmanagedAdjustmentQuantity,
      expectedManagedAdjustmentQuantity,
      previousManagedAdjustmentQuantity,
    }
  }

  const nextManaged: ExchangeQuantityAdjustmentRecord[] = []
  if (expectedManagedAdjustmentQuantity > tolerance && entryPrice > 0) {
    nextManaged.push({
      id: `${input.positionId}:exchange-quantity:${targetQuantity.toFixed(12)}`,
      source: input.source || "exchange_reconcile",
      ...(input.orderId ? { orderId: input.orderId } : {}),
      quantity: expectedManagedAdjustmentQuantity,
      price: entryPrice,
      timestamp: Number(input.timestamp) || Date.now(),
    })
  }

  return {
    adjustments: [...unmanaged, ...nextManaged].slice(-64),
    changed: true,
    fillQuantity,
    unmanagedAdjustmentQuantity,
    expectedManagedAdjustmentQuantity,
    previousManagedAdjustmentQuantity,
  }
}
