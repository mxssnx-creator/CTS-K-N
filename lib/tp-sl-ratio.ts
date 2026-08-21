/**
 * Shared TP/SL ratio helpers.
 *
 * This legacy helper multiplies a TP magnitude by an SL-to-TP ratio.  Its
 * caller owns the coordinate: legacy live callers pass market-price percent;
 * configuration-set engines use the explicit PositionCost converters in
 * `position-cost.ts` before turning a ratio into a market-price percent.
 */
export function resolveStopLossPercent(takeprofitFactor: number, stoplossRatio: number): number {
  const tp = Number(takeprofitFactor)
  const ratio = Number(stoplossRatio)
  if (!Number.isFinite(tp) || !Number.isFinite(ratio) || tp <= 0 || ratio <= 0) return 0
  return tp * ratio
}

export function resolveTpSlRiskReward(takeprofitFactor: number, stoplossRatio: number): number {
  const slPercent = resolveStopLossPercent(takeprofitFactor, stoplossRatio)
  return slPercent > 0 ? takeprofitFactor / slPercent : 0
}

export function resolvePositionCostNotional(input: { entry_price?: number; volume?: number; quantity?: unknown }): number {
  const entryPrice = Number(input.entry_price)
  const quantity = Number(input.quantity)
  const volume = Number(input.volume)
  if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0) {
    return entryPrice * quantity
  }
  return Number.isFinite(volume) && volume > 0 ? volume : 0
}
