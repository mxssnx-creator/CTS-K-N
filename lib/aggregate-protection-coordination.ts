export type AggregateProtectionDirection = "long" | "short"

export interface AggregateProtectionCandidate {
  id: string
  symbol: string
  direction: AggregateProtectionDirection
  quantity: number
  entryPrice?: number
  liquidationPrice?: number
  priceTick?: number
  desiredStopLoss: number
  desiredTakeProfit: number
  createdAt?: number
  quantityStep?: number
  /** Prefer the row already owning the slot-level aggregate security stop. */
  hasSecurityStopOrder?: boolean
  /** Keep ownership stable while a response-lost security submission resolves. */
  hasPendingSecurityStop?: boolean
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
  /** The farthest strategy-row stop for this physical slot. */
  outerStopLoss: number
  /** Largest absolute entry-to-row-stop distance in this slot. */
  maximumStopRange: number
  /** Requested distance between the outer row stop and security stop. */
  securityStopGap: number
  /** Tick-normalized, liquidation-safe full-slot security stop; zero means fail closed. */
  securityStopPrice: number
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
  return Number(candidate.hasSecurityStopOrder === true) + Number(candidate.hasPendingSecurityStop === true)
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

function roundDownToTick(value: number, tick: number): number {
  if (!(value > 0) || !(tick > 0)) return 0
  return Number((Math.floor((value + tick * 1e-9) / tick) * tick).toPrecision(15))
}

function roundUpToTick(value: number, tick: number): number {
  if (!(value > 0) || !(tick > 0)) return 0
  return Number((Math.ceil((value - tick * 1e-9) / tick) * tick).toPrecision(15))
}

function securityStopForRows(
  direction: AggregateProtectionDirection,
  rows: AggregateProtectionCandidate[],
): Pick<AggregateProtectionPlan, "outerStopLoss" | "maximumStopRange" | "securityStopGap" | "securityStopPrice"> {
  const outer = outerStopLoss(direction, rows.map((row) => row.desiredStopLoss))
  const ranges = rows.map((row) => {
    const entry = finitePositive(row.entryPrice)
    const stop = finitePositive(row.desiredStopLoss)
    return entry > 0 && stop > 0 ? Math.abs(entry - stop) : 0
  })
  const maximumStopRange = ranges.length > 0 ? Math.max(...ranges) : 0
  const ticks = rows.map((row) => finitePositive(row.priceTick))

  // A guessed decimal precision is unsafe for a real trigger. Every row in a
  // physical slot must carry the venue's exact tick before a full-slot stop is
  // eligible to arm.
  if (!(outer > 0) || !(maximumStopRange > 0) || ticks.some((tick) => !(tick > 0))) {
    return { outerStopLoss: outer, maximumStopRange, securityStopGap: 0, securityStopPrice: 0 }
  }

  const priceTick = Math.max(...ticks)
  const securityStopGap = Math.max(priceTick * 2, maximumStopRange * 0.1)
  const liquidationPrices = rows
    .map((row) => finitePositive(row.liquidationPrice))
    .filter((value) => value > 0)

  if (direction === "long") {
    const liquidationFloor = liquidationPrices.length > 0
      ? Math.max(...liquidationPrices) + priceTick * 2
      : 0
    let price = roundDownToTick(outer - securityStopGap, priceTick)
    if (liquidationFloor > 0 && price < liquidationFloor) {
      price = roundUpToTick(liquidationFloor, priceTick)
    }
    // Security must remain at least one valid tick farther than every row SL.
    if (!(price > 0) || price > outer - priceTick + priceTick * 1e-8) price = 0
    return { outerStopLoss: outer, maximumStopRange, securityStopGap, securityStopPrice: price }
  }

  const liquidationCeiling = liquidationPrices.length > 0
    ? Math.min(...liquidationPrices) - priceTick * 2
    : Number.POSITIVE_INFINITY
  let price = roundUpToTick(outer + securityStopGap, priceTick)
  if (Number.isFinite(liquidationCeiling) && price > liquidationCeiling) {
    price = roundDownToTick(liquidationCeiling, priceTick)
  }
  if (!(price > 0) || price < outer + priceTick - priceTick * 1e-8) price = 0
  return { outerStopLoss: outer, maximumStopRange, securityStopGap, securityStopPrice: price }
}

/**
 * Every logical row owns an exact-quantity venue SL and TP. This coordinator
 * only elects the owner and boundary for a separate full-slot security stop
 * covering the complete system-owned physical symbol/direction slot.
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
    // A net venue quantity cannot identify which logical Set changed. Exact
    // row order IDs are reconciled before this planner runs; any remaining
    // shrinkage is ambiguous and must stay an ownership mismatch rather than
    // guessing that the newest rows survived.
    const activeRows = rows
    const staleRows: AggregateProtectionCandidate[] = []
    const leader = selectLeader(activeRows)
    const systemQuantity = activeRows.reduce((sum, row) => sum + finitePositive(row.quantity), 0)
    const security = securityStopForRows(leader.direction, activeRows)
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
      ...security,
    }
  }).sort((a, b) => a.key.localeCompare(b.key))
}
