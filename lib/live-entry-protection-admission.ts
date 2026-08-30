import { aggregateProtectionSlot } from "@/lib/aggregate-protection-coordination"
import { isExactSystemPositionOwner } from "@/lib/system-order-ownership"

export type ProtectionAdmissionDirection = "long" | "short"

export type LiveEntryProtectionAdmissionAudit = {
  safe: boolean
  violations: string[]
  ownedActiveRows: number
  ownedExecutedRows: number
  physicalSlotRows: number
  systemSlotQuantity: number
  venueSlotQuantity: number
  physicalSlotAlreadyExists: boolean
  requiredNewControlOrders: number
}

const ACTIVE_STATUSES = new Set([
  "open",
  "filled",
  "partially_filled",
  "placed",
  "pending_fill",
  "placed_unconfirmed",
  "closing",
  "closing_partial",
])

const PENDING_ENTRY_STATUSES = new Set([
  "placed",
  "pending_fill",
  "placed_unconfirmed",
])

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function symbol(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function directionOf(row: Record<string, any>): ProtectionAdmissionDirection | null {
  const explicit = text(
    row.direction ?? row.positionSide ?? row.position_side,
  ).toLowerCase()
  if (explicit === "long" || explicit === "buy") return "long"
  if (explicit === "short" || explicit === "sell") return "short"
  const side = text(row.side).toLowerCase()
  const signed = finite(row.positionAmt ?? row.position_amount ?? row.size)
  if (side === "long") return "long"
  if (side === "short") return "short"
  if (signed > 0) return "long"
  if (signed < 0) return "short"
  return null
}

function quantityOf(row: Record<string, any>): number {
  return Math.abs(finite(
    row.executedQuantity ??
    row.positionAmt ??
    row.position_amount ??
    row.size ??
    row.quantity ??
    row.contracts ??
    row.positionSize ??
    row.lots ??
    row.volume,
  ))
}

function quantityTolerance(row: Record<string, any>): number {
  return Math.max(1e-10, Math.abs(finite(row.quantityStep)) / 2)
}

function protectionOrderIds(row: Record<string, any>): Set<string> {
  const ids = new Set<string>()
  const direct = text(row.securityStopOrderId)
  if (direct) ids.add(direct)
  const coverage = row.controlOrderSetCoverage
  if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
    for (const value of Object.values(coverage as Record<string, any>)) {
      const id = text(value?.securityStopOrderId)
      if (id) ids.add(id)
    }
  }
  return ids
}

function armedQuantityMatches(
  expected: number,
  raw: unknown,
  tolerance: number,
): boolean {
  const armed = finite(raw)
  return armed > 0 && Math.abs(armed - expected) <= tolerance
}

/**
 * Read-only safety decision made before margin/leverage or entry placement.
 *
 * Independent logical rows remain independent, but no new row may join the
 * venue until every existing CTS row has live exact-quantity SL/TP controls,
 * every physical slot has exactly one live aggregate security stop, and the
 * venue quantity is fully explained by CTS-owned watermarked rows.  External
 * rows/orders are ignored for ownership and preserved; a mixed physical slot
 * blocks admission because a net venue position cannot safely attribute lots.
 */
export function auditLiveEntryProtectionAdmission(input: {
  connectionId: string
  candidateId?: string
  symbol: string
  direction: ProtectionAdmissionDirection
  positions: readonly Record<string, any>[]
  venuePositions: readonly Record<string, any>[]
  liveOrderIds: ReadonlySet<string>
}): LiveEntryProtectionAdmissionAudit {
  const violations: string[] = []
  const candidateId = text(input.candidateId)
  const owned = input.positions.filter((row) => {
    if (!isExactSystemPositionOwner(row, input.connectionId)) return false
    if (candidateId && text(row.id) === candidateId) return false
    return ACTIVE_STATUSES.has(text(row.status).toLowerCase())
  })
  const executed = owned.filter((row) => quantityOf(row) > 0)

  if (owned.some((row) => PENDING_ENTRY_STATUSES.has(text(row.status).toLowerCase()))) {
    violations.push("owned_entry_confirmation_pending")
  }
  if (owned.some((row) => text(row.status).toLowerCase().startsWith("closing"))) {
    violations.push("owned_quantity_mutation_pending")
  }
  if (owned.some((row) => Boolean(
    row.pendingSystemAction
    || row.pendingQuantityMutation
    || row.pendingReduction
    || row.pendingAccumulation
    || finite(row.aggregateProtectionMutationRequestedAt) > 0,
  ))) {
    // A row can retain status=open while a durable add/reduce/control-order
    // transition is in flight. Status alone therefore is not a sufficient
    // admission barrier: another entry must wait until the exact venue
    // quantity and all replacement controls are authoritative again.
    violations.push("owned_quantity_mutation_pending")
  }

  for (const row of executed) {
    const expected = quantityOf(row)
    const tolerance = quantityTolerance(row)
    const stopLossOrderId = text(row.stopLossOrderId)
    const takeProfitOrderId = text(row.takeProfitOrderId)
    if (!stopLossOrderId || !input.liveOrderIds.has(stopLossOrderId)) {
      violations.push("owned_row_stop_loss_missing")
    }
    if (!takeProfitOrderId || !input.liveOrderIds.has(takeProfitOrderId)) {
      violations.push("owned_row_take_profit_missing")
    }
    if (!armedQuantityMatches(
      expected,
      row.stopLossArmedQuantity ?? row.protectionArmedQuantity,
      tolerance,
    )) {
      violations.push("owned_row_stop_loss_quantity_mismatch")
    }
    if (!armedQuantityMatches(
      expected,
      row.takeProfitArmedQuantity ?? row.protectionArmedQuantity,
      tolerance,
    )) {
      violations.push("owned_row_take_profit_quantity_mismatch")
    }
  }

  const bySlot = new Map<string, Record<string, any>[]>()
  for (const row of executed) {
    const rowDirection = directionOf(row)
    if (!rowDirection) {
      violations.push("owned_row_direction_missing")
      continue
    }
    const key = aggregateProtectionSlot(row.symbol, rowDirection)
    const rows = bySlot.get(key) || []
    rows.push(row)
    bySlot.set(key, rows)
  }
  for (const rows of bySlot.values()) {
    const orderIds = new Set<string>()
    for (const row of rows) {
      for (const id of protectionOrderIds(row)) {
        if (input.liveOrderIds.has(id)) orderIds.add(id)
      }
    }
    if (orderIds.size !== 1) violations.push("owned_slot_security_stop_incomplete")
    const owner = rows.find((row) => text(row.securityStopOrderId) && input.liveOrderIds.has(text(row.securityStopOrderId)))
    const expected = rows.reduce((sum, row) => sum + quantityOf(row), 0)
    const tolerance = Math.max(...rows.map(quantityTolerance), 1e-10)
    if (!owner || !armedQuantityMatches(expected, owner.securityStopArmedQuantity, tolerance)) {
      violations.push("owned_slot_security_quantity_mismatch")
    }
  }

  const candidateSymbol = symbol(input.symbol)
  const candidateSlot = aggregateProtectionSlot(candidateSymbol, input.direction)
  const physicalRows = executed.filter((row) => {
    const rowDirection = directionOf(row)
    return rowDirection !== null &&
      aggregateProtectionSlot(row.symbol, rowDirection) === candidateSlot
  })
  const systemSlotQuantity = physicalRows.reduce((sum, row) => sum + quantityOf(row), 0)
  const venueRows = input.venuePositions.filter((row) => {
    return symbol(row.symbol) === candidateSymbol && directionOf(row) === input.direction
  })
  const venueSlotQuantity = venueRows.reduce((sum, row) => sum + quantityOf(row), 0)
  const slotTolerance = Math.max(
    ...physicalRows.map(quantityTolerance),
    1e-8,
    systemSlotQuantity * 1e-8,
    venueSlotQuantity * 1e-8,
  )
  if (venueRows.length > 1) violations.push("venue_physical_slot_ambiguous")
  if (venueSlotQuantity > 0 && systemSlotQuantity <= 0) {
    violations.push("venue_physical_slot_external")
  } else if (systemSlotQuantity > 0 && venueSlotQuantity <= 0) {
    violations.push("owned_physical_slot_missing_on_venue")
  } else if (Math.abs(systemSlotQuantity - venueSlotQuantity) > slotTolerance) {
    violations.push("venue_physical_slot_quantity_not_fully_owned")
  }

  return {
    safe: violations.length === 0,
    violations: [...new Set(violations)],
    ownedActiveRows: owned.length,
    ownedExecutedRows: executed.length,
    physicalSlotRows: physicalRows.length,
    systemSlotQuantity,
    venueSlotQuantity,
    physicalSlotAlreadyExists: physicalRows.length > 0,
    // Every new independent row owns SL + TP. A brand-new physical slot also
    // needs its single aggregate security stop.
    requiredNewControlOrders: physicalRows.length > 0 ? 2 : 3,
  }
}
