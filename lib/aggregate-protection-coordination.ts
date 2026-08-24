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
  direction: AggregateProtectionDirection
  symbol: string
  systemQuantity: number
  venueQuantity: number
  quantityTolerance: number
  ownershipMatches: boolean
  desiredStopLoss: number
  desiredTakeProfit: number
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
    const leader = selectLeader(rows)
    const venue = venueBySlot.get(key)
    const systemQuantity = rows.reduce((sum, row) => sum + finitePositive(row.quantity), 0)
    const venueQuantity = finitePositive(venue?.quantity)
    const quantityTolerance = Math.max(
      1e-10,
      venueQuantity * 1e-8,
      ...rows.map((row) => finitePositive(row.quantityStep) / 2),
    )
    return {
      key,
      leaderId: leader.id,
      memberIds: rows.map((row) => row.id).sort(),
      direction: leader.direction,
      symbol: leader.symbol,
      systemQuantity,
      venueQuantity,
      quantityTolerance,
      ownershipMatches: venueQuantity > 0 && Math.abs(systemQuantity - venueQuantity) <= quantityTolerance,
      desiredStopLoss: outerStopLoss(leader.direction, rows.map((row) => row.desiredStopLoss)),
      desiredTakeProfit: outerTakeProfit(leader.direction, rows.map((row) => row.desiredTakeProfit)),
    }
  }).sort((a, b) => a.key.localeCompare(b.key))
}
