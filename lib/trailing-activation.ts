/**
 * General multi-step trailing: activation and the bar-level simulator.
 *
 * Operator decision (2026-10-19, audit TRAIL-01): the start ratio is a share
 * of the take-profit distance, not an absolute gain. The former absolute start
 * (0.3–1.5 of entry, i.e. 30–150 % gain) sat above every take-profit the engine
 * can set (capped at 22 %), so general trailing never armed.
 *
 * Positions opened before this rule carry no activation mode and keep their
 * absolute threshold. New general trailing positions carry `tp_share`.
 *
 * The simulator below follows the live rule in
 * lib/trade-engine/realtime-processor.ts (updateTrailingStop and
 * shouldCloseStopLoss): a long exits when price reaches the higher of the
 * static stop and the armed trailing stop; the
 * trailing stop uses the configured entry or peak basis and ratchets on each favourable
 * step. It is used by the historic trailing family so simulation and live
 * share one definition.
 */
import { applyTrailingDistanceFloorRatio } from "@/lib/protection-floors"

export const TRAILING_ACTIVATION_TP_SHARE = "tp_share"
export const TRAILING_ACTIVATION_ABSOLUTE = "absolute"
export type TrailingActivationMode = typeof TRAILING_ACTIVATION_TP_SHARE | typeof TRAILING_ACTIVATION_ABSOLUTE
export type TrailingGapBasis = "entry" | "peak"
export type TrailingGapSelection = TrailingGapBasis | "both"

export function normalizeTrailingGapBasis(input: unknown): TrailingGapBasis {
  return input === "entry" ? "entry" : "peak"
}

export function normalizeTrailingGapSelection(input: unknown): TrailingGapSelection {
  return input === "both" ? "both" : normalizeTrailingGapBasis(input)
}

export function generalTrailingStopPrice(direction: "long" | "short", entry: number,
  anchor: number, distance: number, basis?: TrailingGapBasis): number {
  const sign = direction === "long" ? 1 : -1
  return basis === "entry" ? anchor - sign * entry * distance : anchor * (1 - sign * distance)
}

/** A share of the TP distance must stay below the take-profit so trailing can arm first. */
export const MAX_TRAILING_TP_SHARE = 0.95

/**
 * The five configured start bands (keys 0.3, 0.6, 0.9, 1.2, 1.5 in
 * lib/trailing-settings.ts) keep their stored keys so existing selections
 * survive. Each band maps, by position, to a share of the TP distance.
 */
const BAND_TP_SHARE: Record<string, number> = {
  "0.3": 0.3,
  "0.6": 0.5,
  "0.9": 0.7,
  "1.2": 0.85,
  "1.5": 0.95,
}

/** Activation share of the take-profit distance for a configured start ratio. */
export function trailingStartTpShare(startRatio: number): number {
  const parsed = Number(startRatio)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  const band = BAND_TP_SHARE[parsed.toFixed(1)]
  if (band !== undefined) return band
  return Math.min(MAX_TRAILING_TP_SHARE, parsed)
}

/** |take-profit − entry| / entry, or 0 when either price is unknown. */
export function takeProfitRatio(entryPrice: number, takeProfitPrice: number): number {
  if (!(entryPrice > 0) || !(takeProfitPrice > 0)) return 0
  return Math.abs(takeProfitPrice - entryPrice) / entryPrice
}

/**
 * Favourable gain (fraction of entry) at which general trailing arms.
 *
 * tp_share: startRatio's share of the take-profit distance. A position with no
 * usable take-profit falls back to the absolute threshold, because it has no
 * fixed exit that trailing could precede.
 * absolute (or no mode): the stored start ratio, as before.
 */
export function trailingActivationThreshold(input: {
  mode?: string | null
  startRatio: number
  takeProfitRatio: number
}): number {
  if (input.mode === TRAILING_ACTIVATION_TP_SHARE && input.takeProfitRatio > 0) {
    return trailingStartTpShare(input.startRatio) * input.takeProfitRatio
  }
  return Number(input.startRatio) || 0
}

export interface GeneralTrailingBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface GeneralTrailingInput {
  direction: "long" | "short"
  entryPrice: number
  /** Bars after the entry decision, in time order. The entry bar itself is not walked. */
  bars: readonly GeneralTrailingBar[]
  /** Bounds into bars for the caller's actual fill time and hold limit. */
  fromIndex?: number
  toIndexExclusive?: number
  takeProfitPct: number
  stopLossPct: number
  startRatio: number
  /** Trailing distance as a fraction of price (0.1 = 10 %), floored like the engine. */
  stopRatio: number
  /** The applicable range's floor in percent, when it differs from the default. */
  minimumTrailingDistancePct?: number
  /** Step as a fraction of price; defaults to half the trailing distance, minimum 0.1 %. */
  stepRatio?: number
  activationMode: TrailingActivationMode
  gapBasis?: TrailingGapBasis
  trailingEnabled?: boolean
}

export interface GeneralTrailingExit {
  index: number
  time: number
  price: number
  reason: "take_profit" | "stop_loss" | "trailing_stop"
  trailingArmed: boolean
}

/**
 * First exit of one general trailing position, or null when no exit happens in
 * the given bars. The open is observed first. If both exits are touched after
 * the open, settle the existing stop before the target. A newly ratcheted
 * stop is eligible from the next bar because the OHLC extremes are unordered.
 */
export function simulateGeneralTrailingExit(input: GeneralTrailingInput): GeneralTrailingExit | null {
  const entry = Number(input.entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return null
  const long = input.direction === "long"
  const tpRatio = Math.max(0, Number(input.takeProfitPct) || 0) / 100
  const slRatio = Math.max(0, Number(input.stopLossPct) || 0) / 100
  const tpPrice = tpRatio > 0 ? (long ? entry * (1 + tpRatio) : entry * (1 - tpRatio)) : 0
  const slPrice = slRatio > 0 ? (long ? entry * (1 - slRatio) : entry * (1 + slRatio)) : 0
  const distance = applyTrailingDistanceFloorRatio(
    Math.max(0, Number(input.stopRatio) || 0), input.minimumTrailingDistancePct,
  )
  const step = Math.max(Number(input.stepRatio) || distance / 2, 0.001)
  const activation = input.trailingEnabled === false ? Infinity : trailingActivationThreshold({
    mode: input.activationMode,
    startRatio: input.startRatio,
    takeProfitRatio: tpRatio,
  })

  let armed = false
  let anchor = entry
  let trailStop = 0

  const fromIndex = Math.max(0, input.fromIndex ?? 0)
  const toIndex = Math.min(input.bars.length, input.toIndexExclusive ?? input.bars.length)
  for (let index = fromIndex; index < toIndex; index++) {
    const bar = input.bars[index]
    // A target already reached at the opening print precedes later extremes.
    if (tpPrice > 0 && (long ? bar.open >= tpPrice : bar.open <= tpPrice)) {
      return { index, time: bar.time, price: tpPrice, reason: "take_profit", trailingArmed: armed }
    }
    // The binding stop is the tighter of the static stop and the armed trail.
    const usesTrail = armed && trailStop > 0 && (slPrice <= 0 || (long ? trailStop >= slPrice : trailStop <= slPrice))
    const stopLevel = usesTrail ? trailStop : slPrice
    if (stopLevel > 0 && (long ? bar.low <= stopLevel : bar.high >= stopLevel)) {
      const gapped = long ? bar.open <= stopLevel : bar.open >= stopLevel
      const price = gapped ? bar.open : stopLevel
      return {
        index,
        time: bar.time,
        price,
        reason: usesTrail ? "trailing_stop" : "stop_loss",
        trailingArmed: armed,
      }
    }
    if (tpPrice > 0 && (long ? bar.high >= tpPrice : bar.low <= tpPrice)) {
      return { index, time: bar.time, price: tpPrice, reason: "take_profit", trailingArmed: armed }
    }
    if (input.trailingEnabled === false) continue

    const favourable = long ? bar.high : bar.low
    if (!armed) {
      const gain = long ? (favourable - entry) / entry : (entry - favourable) / entry
      if (gain >= activation) {
        armed = true
        anchor = favourable
        trailStop = generalTrailingStopPrice(input.direction, entry, anchor, distance, input.gapBasis)
      }
    } else {
      const stepDistance = anchor * step
      const moved = long ? favourable >= anchor + stepDistance : favourable <= anchor - stepDistance
      if (moved) {
        anchor = favourable
        const candidate = generalTrailingStopPrice(input.direction, entry, anchor, distance, input.gapBasis)
        trailStop = long ? Math.max(trailStop, candidate) : Math.min(trailStop, candidate)
      }
    }
  }
  return null
}
