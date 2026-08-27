export type AggregateProtectionDirection = "long" | "short"

export interface AggregateProtectionCandidate {
  id: string
  symbol: string
  direction: AggregateProtectionDirection
  quantity: number
  desiredStopLoss: number
  desiredTakeProfit: number
  createdAt?: number
  quantityStep?: number
  hasStopLossOrder?: boolean
  hasTakeProfitOrder?: boolean
}

export interface AggregateProtectionVenuePosition {
  symbol: string
  direction: AggregateProtectionDirection
  quantity: number
}

export interface AggregateProtectionPlan {
  key: string
  leaderId: string
  memberIds: string[]
  staleMemberIds: string[]
  direction: AggregateProtectionDirection
  symbol: string
  reportedSystemQuantity: number
  systemQuantity: number
  venueQuantity: number
  quantityTolerance: number
  ownershipMatches: boolean
  desiredStopLoss: number
  desiredTakeProfit: number
}

function newestVenueBackedRows(
  rows: AggregateProtectionCandidate[],
  venueQuantity: number,
  tolerance: number,
): { active: AggregateProtectionCandidate[]; stale: AggregateProtectionCandidate[] } | null {
  if (!(venueQuantity > 0)) return null
  const total = rows.reduce((sum, row) => sum + finitePositive(row.quantity), 0)
  if (total <= venueQuantity + tolerance) return null

  // BingX nets every Set entry into one physical symbol/direction position.
  // When an aggregate SL/TP closes that slot and a later Set re-opens it
  // before the next snapshot, the venue never exposes an intermediate zero.
  // The current quantity therefore belongs to the newest complete CTS fills;
  // older rows describe the superseded slot generation. Select only complete
  // rows so a partially attributable venue quantity remains fail-closed.
  const newest = [...rows].sort((a, b) =>
    finitePositive(b.createdAt) - finitePositive(a.createdAt)
    || b.id.localeCompare(a.id),
  )
  const active: AggregateProtectionCandidate[] = []
  let attributed = 0
  for (const row of newest) {
    const quantity = finitePositive(row.quantity)
    if (!(quantity > 0)) continue
    if (attributed + quantity > venueQuantity + tolerance) continue
    active.push(row)
    attributed += quantity
    if (Math.abs(attributed - venueQuantity) <= tolerance) break
  }
  if (active.length === 0 || Math.abs(attributed - venueQuantity) > tolerance) return null
  const activeIds = new Set(active.map((row) => row.id))
  return { active, stale: rows.filter((row) => !activeIds.has(row.id)) }
}

export function aggregateProtectionSlot(symbol: unknown, direction: unknown): string {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const normalizedDirection = String(direction || "").toLowerCase()
  return `${normalizedSymbol}|${normalizedDirection}`
}

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function leaderScore(candidate: AggregateProtectionCandidate): number {
  return Number(candidate.hasStopLossOrder === true) + Number(candidate.hasTakeProfitOrder === true)
}

function selectLeader(candidates: AggregateProtectionCandidate[]): AggregateProtectionCandidate {
  return [...candidates].sort((a, b) =>
    leaderScore(b) - leaderScore(a)
    || finitePositive(a.createdAt) - finitePositive(b.createdAt)
    || a.id.localeCompare(b.id),
  )[0]
}

function outerStopLoss(direction: AggregateProtectionDirection, values: number[]): number {
  const positive = values.filter((value) => finitePositive(value) > 0)
  if (positive.length === 0) return 0
  return direction === "long" ? Math.min(...positive) : Math.max(...positive)
}

function outerTakeProfit(direction: AggregateProtectionDirection, values: number[]): number {
  const positive = values.filter((value) => finitePositive(value) > 0)
  if (positive.length === 0) return 0
  return direction === "long" ? Math.max(...positive) : Math.min(...positive)
}

/**
 * One venue SL and one venue TP protect the complete system-owned physical
 * symbol/direction slot. Individual strategy rows retain their own fast
 * system-side exits; the aggregate venue pair is the outer safety boundary.
 */
export function buildAggregateProtectionPlans(
  candidates: readonly AggregateProtectionCandidate[],
  venuePositions: readonly AggregateProtectionVenuePosition[],
): AggregateProtectionPlan[] {
  const venueBySlot = new Map(
    venuePositions.map((position) => [
      aggregateProtectionSlot(position.symbol, position.direction),
      position,
    ]),
  )
  const groups = new Map<string, AggregateProtectionCandidate[]>()
  for (const candidate of candidates) {
    if (!candidate.id || finitePositive(candidate.quantity) <= 0) continue
    const key = aggregateProtectionSlot(candidate.symbol, candidate.direction)
    const rows = groups.get(key) || []
    rows.push(candidate)
    groups.set(key, rows)
  }

  return [...groups.entries()].map(([key, rows]) => {
    const venue = venueBySlot.get(key)
    const reportedSystemQuantity = rows.reduce((sum, row) => sum + finitePositive(row.quantity), 0)
    const venueQuantity = finitePositive(venue?.quantity)
    const quantityTolerance = Math.max(
      1e-10,
      venueQuantity * 1e-8,
      ...rows.map((row) => finitePositive(row.quantityStep) / 2),
    )
    const generation = newestVenueBackedRows(rows, venueQuantity, quantityTolerance)
    const activeRows = generation?.active || rows
    const staleRows = generation?.stale || []
    const leader = selectLeader(activeRows)
    const systemQuantity = activeRows.reduce((sum, row) => sum + finitePositive(row.quantity), 0)
    return {
      key,
      leaderId: leader.id,
      memberIds: activeRows.map((row) => row.id).sort(),
      staleMemberIds: staleRows.map((row) => row.id).sort(),
      direction: leader.direction,
      symbol: leader.symbol,
      reportedSystemQuantity,
      systemQuantity,
      venueQuantity,
      quantityTolerance,
      ownershipMatches: venueQuantity > 0 && Math.abs(systemQuantity - venueQuantity) <= quantityTolerance,
      desiredStopLoss: outerStopLoss(leader.direction, activeRows.map((row) => row.desiredStopLoss)),
      desiredTakeProfit: outerTakeProfit(leader.direction, activeRows.map((row) => row.desiredTakeProfit)),
    }
  }).sort((a, b) => a.key.localeCompare(b.key))
}
