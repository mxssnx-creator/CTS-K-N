/**
 * The stop-loss price a venue accepts for an open position.
 *
 * A strategy derives its stop from percentages; the venue additionally
 * requires the trigger to sit on the protective side of the current mark
 * price (not touching it) and inside the liquidation price — a stop beyond
 * liquidation never fires, and BingX rejects both. Instead of letting the
 * order be rejected (and the entry rolled back, or the same price retried
 * every tick), the stop is placed at the nearest allowed price:
 *
 *  - at least `minMarkTicks` ticks from the mark on the protective side
 *    (only when the stop has NOT already crossed the mark — a crossed stop
 *    is a close, handled by the caller);
 *  - at least max(2 ticks, 10 % of the entry→liquidation range) inside the
 *    liquidation price (the rule of the slot security stop,
 *    lib/aggregate-protection-coordination.ts securityStopForRows);
 *  - on the price tick, rounded to the safe side.
 *
 * When both bounds cannot hold at once the stop is returned unchanged with
 * `reason: "unsatisfiable"` so the caller keeps its fail-safe behaviour.
 */
export type AllowedStopReason = "within_range" | "mark_distance" | "liquidation" | "crossed" | "unsatisfiable" | "invalid"

export interface AllowedStopInput {
  direction: "long" | "short"
  entryPrice: number
  stopPrice: number
  markPrice?: number | null
  liquidationPrice?: number | null
  priceTick?: number | null
  /** Ticks the stop must keep from the mark; default 2. */
  minMarkTicks?: number
}

export interface AllowedStopResult {
  stopPrice: number
  adjusted: boolean
  reason: AllowedStopReason
}

const positive = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function onTick(value: number, tick: number, mode: "floor" | "ceil"): number {
  if (!(tick > 0)) return value
  const units = value / tick
  const rounded = mode === "floor" ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9)
  return Number((rounded * tick).toPrecision(15))
}

export function allowedStopLossPrice(input: AllowedStopInput): AllowedStopResult {
  const stop = positive(input.stopPrice)
  const entry = positive(input.entryPrice)
  if (!stop || !entry || (input.direction !== "long" && input.direction !== "short")) {
    return { stopPrice: stop, adjusted: false, reason: "invalid" }
  }
  const long = input.direction === "long"
  const tick = positive(input.priceTick)
  const mark = positive(input.markPrice)
  const liquidation = positive(input.liquidationPrice)
  const ticks = Math.max(1, Math.floor(Number(input.minMarkTicks) || 2))
  // Without a tick, keep 0.02 % per required tick from the mark.
  const markGap = tick > 0 ? ticks * tick : (mark || entry) * 0.0002 * ticks

  // A stop already at or beyond the mark has been hit: not ours to move.
  if (mark > 0 && (long ? stop >= mark : stop <= mark)) return { stopPrice: stop, adjusted: false, reason: "crossed" }

  // Long: allowed stops lie in [lower, upper]; short: in [lower, upper] mirrored.
  const markBound = mark > 0 ? (long ? mark - markGap : mark + markGap) : Number.NaN
  const liquidationValid = liquidation > 0 && (long ? liquidation < entry : liquidation > entry)
  const liquidationGap = liquidationValid
    ? Math.max(2 * tick, Math.abs(entry - liquidation) * 0.1)
    : 0
  const liquidationBound = liquidationValid ? (long ? liquidation + liquidationGap : liquidation - liquidationGap) : Number.NaN

  let next = stop
  let reason: AllowedStopReason = "within_range"
  if (Number.isFinite(markBound) && (long ? next > markBound : next < markBound)) {
    next = markBound
    reason = "mark_distance"
  }
  if (Number.isFinite(liquidationBound) && (long ? next < liquidationBound : next > liquidationBound)) {
    next = liquidationBound
    reason = "liquidation"
  }
  if (Number.isFinite(markBound) && Number.isFinite(liquidationBound) && (long ? liquidationBound > markBound : liquidationBound < markBound)) {
    return { stopPrice: stop, adjusted: false, reason: "unsatisfiable" }
  }
  if (reason === "within_range") return { stopPrice: stop, adjusted: false, reason }
  // Round to the tick inside the allowed range: a long stop away from the
  // mark (down) unless that crosses the liquidation bound, a short one up.
  let rounded = onTick(next, tick, long ? "floor" : "ceil")
  if (Number.isFinite(liquidationBound) && (long ? rounded < liquidationBound : rounded > liquidationBound)) {
    rounded = onTick(next, tick, long ? "ceil" : "floor")
  }
  if (!(rounded > 0)) return { stopPrice: stop, adjusted: false, reason: "invalid" }
  return { stopPrice: rounded, adjusted: Math.abs(rounded - stop) > 1e-12, reason }
}
