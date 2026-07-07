/**
 * Shared TP/SL ratio helpers.
 *
 * `takeprofit_factor` is stored as the absolute take-profit percent.
 * `stoploss_ratio` is stored as a ratio of that TP distance, not as an
 * independent percent. Example: TP=10 and SL ratio=0.5 => SL distance=5%.
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
