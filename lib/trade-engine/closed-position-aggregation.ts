export interface ClosedPositionLike {
  direction?: string
  side?: string
  entryPrice?: number
  entry_price?: number
  averageExecutionPrice?: number
  closePrice?: number
  exitPrice?: number
  lastPrice?: number
  markPrice?: number
  current_price?: number
  realizedPnL?: number
  realized_pnl?: number
  pnl?: number
  executedQuantity?: number
  quantity?: number
  volumeUsd?: number
  signedPricePct?: number
  signedResultR?: number
  [key: string]: unknown
}

export interface LastXClosedPositionAggregation {
  count: number
  wins: number
  losses: number
  grossPositiveR: number
  grossNegativeR: number
  profitFactor: number
  avgSignedR: number
  avgPositiveR: number
  avgNegativeR: number
  netR: number
  winRate: number
}

const round = (value: number, decimals = 6): number => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

const finiteNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return 0
}

export function calculateClosedPositionSignedPricePct(position: ClosedPositionLike): number {
  const provided = Number(position.signedPricePct)
  if (Number.isFinite(provided)) return provided

  const entryPrice = finiteNumber(position.averageExecutionPrice, position.entryPrice, position.entry_price)
  const exitPrice = finiteNumber(position.closePrice, position.exitPrice, position.lastPrice, position.markPrice, position.current_price)
  if (entryPrice > 0 && exitPrice > 0) {
    const direction = String(position.direction ?? position.side ?? "long").toLowerCase()
    const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100
    return direction === "short" ? -rawPct : rawPct
  }

  const pnl = finiteNumber(position.realizedPnL, position.realized_pnl, position.pnl)
  const quantity = Math.abs(finiteNumber(position.executedQuantity, position.quantity))
  const notional = finiteNumber(position.volumeUsd) || (entryPrice > 0 && quantity > 0 ? entryPrice * quantity : 0)
  return notional > 0 ? (pnl / notional) * 100 : 0
}

export function calculateClosedPositionSignedResultR(
  position: ClosedPositionLike,
  positionCostPct = 0.1,
): number {
  const provided = Number(position.signedResultR)
  if (Number.isFinite(provided)) return provided

  const denominator = Math.abs(Number(positionCostPct))
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  return calculateClosedPositionSignedPricePct(position) / denominator
}

export function aggregateLastXClosedPositions(
  positions: ClosedPositionLike[],
  x: number,
  positionCostPct = 0.1,
): LastXClosedPositionAggregation {
  const limit = Math.max(0, Math.floor(Number(x) || 0))
  const sampled = (Array.isArray(positions) ? positions : []).slice(0, limit || undefined)

  let wins = 0
  let losses = 0
  let grossPositiveR = 0
  let grossNegativeR = 0
  let netR = 0

  for (const position of sampled) {
    const signedPricePct = calculateClosedPositionSignedPricePct(position)
    const signedResultR = calculateClosedPositionSignedResultR({ ...position, signedPricePct }, positionCostPct)

    if (!Number.isFinite(signedResultR)) continue
    netR += signedResultR
    ;(position as ClosedPositionLike).signedPricePct = round(signedPricePct)
    ;(position as ClosedPositionLike).signedResultR = round(signedResultR)

    if (signedResultR > 0) {
      wins++
      grossPositiveR += signedResultR
    } else if (signedResultR < 0) {
      losses++
      grossNegativeR += Math.abs(signedResultR)
    }
  }

  const count = sampled.length
  return {
    count,
    wins,
    losses,
    grossPositiveR: round(grossPositiveR),
    grossNegativeR: round(grossNegativeR),
    profitFactor: grossNegativeR > 0 ? round(grossPositiveR / grossNegativeR, 3) : grossPositiveR > 0 ? 999 : 0,
    avgSignedR: count > 0 ? round(netR / count) : 0,
    avgPositiveR: wins > 0 ? round(grossPositiveR / wins) : 0,
    avgNegativeR: losses > 0 ? round(-(grossNegativeR / losses)) : 0,
    netR: round(netR),
    winRate: count > 0 ? round((wins / count) * 100, 1) : 0,
  }
}
