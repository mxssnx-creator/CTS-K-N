/**
 * Short Range — a strategy configuration type with its own protection grid.
 *
 * Where the indication grid decides WHEN to enter, this grid decides how the
 * position is protected once entered: a take profit expressed in PositionCost
 * multiples, a stop loss expressed as a ratio OF that take profit, and a
 * trailing profile whose start is likewise a ratio of the take profit.
 *
 * Operator specification:
 *   takeProfit      3 .. 6    step 0.25   (multiples of PositionCost)  13 values
 *   stopLossRatio   0.5 .. 2.5 step 0.25  (ratio of takeProfit)         9 values
 *   trailingStart   1 .. 2    step 0.25   (ratio of takeProfit)         5 values
 *   trailingStop    0.3 .. 0.7 step 0.1   (share of the positive range) 5 values
 *
 * 13 x 9 x 5 x 5 = 2,925 combinations. That is deliberately more than any
 * live stage should ever expand: the grid is scored by the Historic Test
 * FIRST and only the combinations that validate there are handed to the live
 * stages. Enumerating it live without that pre-filter would multiply every
 * validated Base Set by 2,925.
 */

export interface ShortRangeConfig {
  /** Take profit as a multiple of PositionCost. */
  takeProfit: number
  /** Stop loss as a ratio of the take profit (1.0 = symmetric). */
  stopLossRatio: number
  /** Trailing activation as a ratio of the take profit. */
  trailingStart: number
  /** Trailing stop as a share of the positive range travelled (0.4 = 40%). */
  trailingStop: number
}

export const SHORT_RANGE_GRID = {
  takeProfit: { min: 3, max: 6, step: 0.25 },
  stopLossRatio: { min: 0.5, max: 2.5, step: 0.25 },
  trailingStart: { min: 1, max: 2, step: 0.25 },
  trailingStop: { min: 0.3, max: 0.7, step: 0.1 },
} as const

/**
 * The trailing stop is re-evaluated when the position has travelled half the
 * distance between the current stop and the peak. Fixed at 0.5 by
 * specification, so it is a constant rather than a grid axis.
 */
export const SHORT_RANGE_TRAILING_UPDATE_RATIO = 0.5

/** Inclusive range with a fixed step, rounded to avoid float drift (0.1+0.2 !== 0.3). */
export function axisValues(axis: { min: number; max: number; step: number }): number[] {
  const decimals = (String(axis.step).split(".")[1] || "").length
  const factor = 10 ** decimals
  const out: number[] = []
  // Integer arithmetic on the scaled values: accumulating floats would drift
  // and drop or duplicate the final value.
  for (let scaled = Math.round(axis.min * factor); scaled <= Math.round(axis.max * factor) + 1e-9; scaled += Math.round(axis.step * factor)) {
    out.push(scaled / factor)
  }
  return out
}

/** Stable identity for one combination — used as the Set key suffix and in reports. */
export function shortRangeConfigKey(config: ShortRangeConfig): string {
  return `tp${config.takeProfit}:slr${config.stopLossRatio}:ts${config.trailingStart}:tstop${config.trailingStop}`
}

/**
 * Every combination of the grid.
 *
 * `limit` exists for diagnostics and tests only; production scores the whole
 * grid in the Historic Test, where the cost is paid once per run rather than
 * once per live cycle.
 */
export function enumerateShortRangeConfigs(
  overrides: Partial<Record<keyof typeof SHORT_RANGE_GRID, number[]>> = {},
  limit?: number,
): ShortRangeConfig[] {
  const takeProfits = overrides.takeProfit ?? axisValues(SHORT_RANGE_GRID.takeProfit)
  const stopLossRatios = overrides.stopLossRatio ?? axisValues(SHORT_RANGE_GRID.stopLossRatio)
  const trailingStarts = overrides.trailingStart ?? axisValues(SHORT_RANGE_GRID.trailingStart)
  const trailingStops = overrides.trailingStop ?? axisValues(SHORT_RANGE_GRID.trailingStop)
  const out: ShortRangeConfig[] = []
  for (const takeProfit of takeProfits) {
    for (const stopLossRatio of stopLossRatios) {
      for (const trailingStart of trailingStarts) {
        for (const trailingStop of trailingStops) {
          out.push({ takeProfit, stopLossRatio, trailingStart, trailingStop })
          if (limit != null && out.length >= limit) return out
        }
      }
    }
  }
  return out
}

/**
 * Resolve a combination into the concrete percentages a position needs.
 *
 * Both take profit and stop loss are returned as percentages of entry price,
 * derived from the PositionCost so a 4x take profit at 0.1% PositionCost is
 * 0.4%. The stop loss ratio multiplies the take profit, so ratio 2.5 on a 3x
 * take profit is a 7.5x stop — wider than the target, which is what makes the
 * low-take-profit / high-ratio corner of the grid a genuinely different
 * strategy rather than a rescaling of the same one.
 */
export function resolveShortRangeProtection(
  config: ShortRangeConfig,
  positionCostPercent: number,
): { takeProfitPct: number; stopLossPct: number; trailingStartPct: number; trailingStopRatio: number; trailingUpdateRatio: number } {
  const cost = Number(positionCostPercent) > 0 ? Number(positionCostPercent) : 0.1
  const takeProfitPct = config.takeProfit * cost
  return {
    takeProfitPct,
    stopLossPct: takeProfitPct * config.stopLossRatio,
    trailingStartPct: takeProfitPct * config.trailingStart,
    trailingStopRatio: config.trailingStop,
    trailingUpdateRatio: SHORT_RANGE_TRAILING_UPDATE_RATIO,
  }
}

/** Map a combination onto the engine's existing TrailingProfile shape. */
export function shortRangeTrailingProfile(
  config: ShortRangeConfig,
  positionCostPercent: number,
): { startRatio: number; stopRatio: number; stepRatio: number; tag: string } {
  const resolved = resolveShortRangeProtection(config, positionCostPercent)
  return {
    // The engine's TrailingProfile carries fractions, not percentages.
    startRatio: resolved.trailingStartPct / 100,
    stopRatio: resolved.trailingStopRatio,
    stepRatio: resolved.trailingUpdateRatio,
    tag: `short-range:${shortRangeConfigKey(config)}`,
  }
}
