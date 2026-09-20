/**
 * Round-trip trading cost, in percent of notional.
 *
 * One definition, used by BOTH the live outcome model and the Historic Test
 * replay, because they were using different ones: the replay charged
 * `positionCostPercent` (0.10%) while the live outcome model charged
 * `takerFee * 2 + slippage` (0.26%). PositionCost is a SIZING setting — the
 * share of the book one position may hold — and borrowing it as a cost
 * understated every simulated trade by 0.16 percentage points, which is 1.6
 * PositionCosts and therefore 0.16 on the ProfitFactor coordinate.
 *
 * The consequence was systematic and one-directional: a Historic Test
 * ProfitFactor of 1.2445 corresponds to roughly 1.08 once real costs are
 * charged, so every threshold and every parameter sweep was measured against
 * an optimistic target. Live results could only ever come out WORSE than the
 * simulation promised.
 */

/** Exchange taker fee per side, as a fraction (0.001 = 0.10%). */
export const DEFAULT_TAKER_FEE_FRACTION = 0.001
/** Expected slippage across the round trip, as a fraction (0.0006 = 0.06%). */
export const DEFAULT_SLIPPAGE_FRACTION = 0.0006

export interface RoundTripCostInput {
  /** Taker fee per side, as a fraction. Both sides are charged. */
  takerFeeFraction?: number
  /** Round-trip slippage, as a fraction. */
  slippageFraction?: number
}

/** Round-trip cost as a FRACTION of notional (entry + exit fees plus slippage). */
export function roundTripCostFraction(input: RoundTripCostInput = {}): number {
  const fee = Number(input.takerFeeFraction)
  const slip = Number(input.slippageFraction)
  const takerFee = Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_TAKER_FEE_FRACTION
  const slippage = Number.isFinite(slip) && slip >= 0 ? slip : DEFAULT_SLIPPAGE_FRACTION
  // Two sides: the position is opened and closed.
  return takerFee * 2 + slippage
}

/** Round-trip cost in PERCENT, which is the unit the replay and the outcome model both carry. */
export function roundTripCostPercent(input: RoundTripCostInput = {}): number {
  return roundTripCostFraction(input) * 100
}
