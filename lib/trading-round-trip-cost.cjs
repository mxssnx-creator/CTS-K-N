"use strict"
/**
 * Round-trip trading cost — the single source for every consumer, including
 * the plain-Node Direct-Trade processor, which cannot load TypeScript.
 * lib/trading-round-trip-cost.ts re-exports these values.
 *
 * A round trip pays the taker fee twice (entry and exit) plus slippage.
 * PositionCost is a SIZING setting and is never a cost.
 */
const DEFAULT_TAKER_FEE_FRACTION = 0.001
const DEFAULT_SLIPPAGE_FRACTION = 0.0006

function roundTripCostFraction(input = {}) {
  const fee = Number(input.takerFeeFraction)
  const slip = Number(input.slippageFraction)
  const takerFee = Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_TAKER_FEE_FRACTION
  const slippage = Number.isFinite(slip) && slip >= 0 ? slip : DEFAULT_SLIPPAGE_FRACTION
  return takerFee * 2 + slippage
}
function roundTripCostPercent(input = {}) {
  return roundTripCostFraction(input) * 100
}

module.exports = { DEFAULT_TAKER_FEE_FRACTION, DEFAULT_SLIPPAGE_FRACTION, roundTripCostFraction, roundTripCostPercent }
