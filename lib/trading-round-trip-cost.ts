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
import roundTripCost from "./trading-round-trip-cost.cjs"

// One implementation, shared with the plain-Node Direct-Trade processor.
export const DEFAULT_TAKER_FEE_FRACTION: number = roundTripCost.DEFAULT_TAKER_FEE_FRACTION
export const DEFAULT_SLIPPAGE_FRACTION: number = roundTripCost.DEFAULT_SLIPPAGE_FRACTION
export interface RoundTripCostInput {
  takerFeeFraction?: number
  slippageFraction?: number
}
export function roundTripCostFraction(input: RoundTripCostInput = {}): number {
  return roundTripCost.roundTripCostFraction(input)
}
export function roundTripCostPercent(input: RoundTripCostInput = {}): number {
  return roundTripCost.roundTripCostPercent(input)
}
