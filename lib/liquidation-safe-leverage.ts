/**
 * The stop must be reached before the exchange liquidates the position.
 *
 * Entries ran at the symbol's venue maximum (up to 500x) with a 0.5 % stop. A
 * position is liquidated when its loss reaches roughly 100/leverage percent of the
 * entry, so at 500x (0.20 %) and 300x (0.33 %) the venue closes it BEFORE the stop
 * can act: the loss is the whole margin, and the row ends as
 * `exchange_externally_closed`. Measured on X01, 2026-09-28..30: 85 of 224 own closed
 * rows had a liquidation distance smaller than their stop, 24 of them ended
 * externally closed.
 *
 * The cap keeps the liquidation distance at least `factor` times the stop (default 2,
 * the margin covers maintenance margin and slippage): leverage <= 100 / (stop% * factor).
 * At a 0.5 % stop that is 100x, at 1 % 50x. The connection's own max_leverage still
 * applies on top; the smaller of the two wins. CTS_LIQUIDATION_SAFETY_FACTOR=0 turns
 * the cap off.
 */
export const LIQUIDATION_SAFETY_FACTOR_DEFAULT = 2

export function liquidationSafetyFactor(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CTS_LIQUIDATION_SAFETY_FACTOR
  if (raw === undefined || raw === "") return LIQUIDATION_SAFETY_FACTOR_DEFAULT
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : LIQUIDATION_SAFETY_FACTOR_DEFAULT
}

/** Highest leverage whose liquidation distance stays `factor` times the stop; 0 means "no cap". */
export function maxLeverageForStop(stopLossPct: number, factor: number = liquidationSafetyFactor()): number {
  const stop = Number(stopLossPct)
  if (!(factor > 0) || !Number.isFinite(stop) || !(stop > 0)) return 0
  return Math.max(1, Math.floor(100 / (stop * factor)))
}

/** The effective ceiling: the smaller of the connection's own cap and the stop-aware one (0 = none). */
export function effectiveLeverageCap(connectionCap: number, stopLossPct: number, factor: number = liquidationSafetyFactor()): number {
  const caps = [Math.floor(Number(connectionCap) || 0), maxLeverageForStop(stopLossPct, factor)].filter((c) => c > 0)
  return caps.length > 0 ? Math.min(...caps) : 0
}

/** Largest value read as a percent; anything above is a configuration unit (PositionCost multiples), not a percent. */
export const STOP_LOSS_PERCENT_CEILING = 25

/**
 * The stop distance in percent of the entry for the leverage cap.
 *
 * #527 read `assignedStopLoss ?? stopLoss`. assignedStopLoss carries the Set's configuration value (X02: 40, 50, 10), not a
 * percent: 40 became "40 %" and the cap 1x. In 48 h on X02, 37 trades ran at 1x, 6 at 2x, 8 at 5x, and the venue
 * leverage of the symbol was set down with them on an account shared with another system. Order of trust: the distance
 * between entry and stop price; then stopLoss, then assignedStopLoss, each only if it is a plausible percent (0..25].
 */
export function stopLossPercentForLeverage(input: {
  entryPrice?: unknown
  stopLossPrice?: unknown
  stopLoss?: unknown
  assignedStopLoss?: unknown
}): number {
  const entry = Number(input.entryPrice), stopPrice = Number(input.stopLossPrice)
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(stopPrice) && stopPrice > 0) {
    const pct = (Math.abs(entry - stopPrice) / entry) * 100
    if (pct > 0 && pct <= STOP_LOSS_PERCENT_CEILING) return pct
  }
  for (const candidate of [input.stopLoss, input.assignedStopLoss]) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0 && value <= STOP_LOSS_PERCENT_CEILING) return value
  }
  return 0
}
