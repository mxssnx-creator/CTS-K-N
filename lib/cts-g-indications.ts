import { evaluateIndependentDirections, type EffectiveTradeDirection } from "./directional-evaluation"

/** Port of CTS-G indication_engine.py at 5ff7cc70e274e1212bcdc38af46126a8abc988cf. */
export interface CtsGIndication {
  kind: "trend" | "break"
  direction: EffectiveTradeDirection
  strength: number
  confidence: number
  agreement: number
  metadata: Record<string, number | string>
}

export interface CtsGIndicationSettings {
  minimumSpreadRatio?: number
  minimumConfidence?: number
  breakRange?: number
  breakNoisePct?: number
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const validPrices = (prices: readonly number[]) => prices.length > 0 && prices.every((p) => Number.isFinite(p) && p > 0)

function emaSeries(values: readonly number[], period: number): number[] {
  const result = [values[0]]
  const alpha = 2 / (period + 1)
  for (let i = 1; i < values.length; i++) result.push(values[i] * alpha + result[i - 1] * (1 - alpha))
  return result
}

function directions(closes: readonly number[], count: number, evidence: number, agreement: number) {
  const start = Math.max(1, closes.length - count)
  return evaluateIndependentDirections(closes.slice(start).map((price, index) => price - closes[start + index - 1]), {
    minimumEvidence: evidence, minimumAgreement: agreement,
  })
}

export function evaluateCtsGTrend(closes: readonly number[], settings: CtsGIndicationSettings = {}): CtsGIndication | null {
  if (closes.length < 30 || !validPrices(closes)) return null
  const fast = emaSeries(closes, 8)
  const slow = emaSeries(closes, 21)
  const last = closes[closes.length - 1]
  const spread = (fast[fast.length - 1] - slow[slow.length - 1]) / last
  if (Math.abs(spread) < (settings.minimumSpreadRatio ?? 0.001)) return null
  const direction = spread > 0 ? "long" : "short"
  let consecutive = 0
  for (let i = 1; i < Math.min(8, fast.length); i++) {
    const difference = fast[fast.length - i] - slow[slow.length - i]
    if ((direction === "long" && difference > 0) || (direction === "short" && difference < 0)) consecutive++
    else break
  }
  if (consecutive < 3) return null
  const evaluated = directions(closes, 10, 2, 0.5)
  if (evaluated.selectedDirection && evaluated.selectedDirection !== direction) return null
  const confidence = clamp(0.52 + Math.min(0.4, Math.abs(spread) * 80) + consecutive * 0.03, 0.5, 0.99)
  if (confidence < (settings.minimumConfidence ?? 0.6) * 0.9) return null
  return {
    kind: "trend", direction, confidence,
    strength: clamp(Math.abs(spread) * 40 + consecutive * 0.04, 0, 1),
    agreement: evaluated[direction].agreement || consecutive / 8,
    metadata: { model: "cts-g-ema8-21", consecutive, spreadRatio: spread },
  }
}

export function evaluateCtsGBreak(closes: readonly number[], settings: CtsGIndicationSettings = {}): CtsGIndication | null {
  const range = Math.max(8, Math.min(240, Math.floor(settings.breakRange || 16)))
  if (closes.length < range + 2 || !validPrices(closes)) return null
  const prior = closes.slice(-(range + 1), -1)
  const last = closes[closes.length - 1]
  const high = Math.max(...prior)
  const low = Math.min(...prior)
  if (last <= high && last >= low) return null
  const direction = last > high ? "long" : "short"
  const reference = direction === "long" ? high : low
  const breakoutPct = Math.abs((last - reference) / reference * 100)
  const noisePct = Math.max(0, settings.breakNoisePct ?? 0.05)
  if (breakoutPct + 1e-12 < Math.max(0.04, noisePct * 0.5)) return null
  const evaluated = directions(closes, 8, 1, 0.45)
  if (evaluated.selectedDirection && evaluated.selectedDirection !== direction) return null
  const agreement = evaluated[direction].agreement || 1
  const confidence = clamp(0.55 + Math.min(0.35, breakoutPct * 8) + agreement * 0.08, 0.5, 0.99)
  if (confidence < (settings.minimumConfidence ?? 0.6) * 0.88) return null
  return {
    kind: "break", direction, confidence, agreement,
    strength: clamp(breakoutPct / Math.max(0.15, noisePct), 0, 1),
    metadata: { model: "cts-g-structure-break", range, breakoutPct },
  }
}

/** Break has priority when both independent hypotheses agree; a conflict waits. */
export function coordinateCtsGEntry(closes: readonly number[]): CtsGIndication | null {
  const trend = evaluateCtsGTrend(closes)
  const breakout = evaluateCtsGBreak(closes)
  if (trend && breakout && trend.direction !== breakout.direction) return null
  return breakout || trend
}

/** Parent fills/protection remain authoritative; DCA may add only with current direction support. */
export function ctsGDcaDirectionAllowed(closes: readonly number[], direction: EffectiveTradeDirection): boolean {
  return coordinateCtsGEntry(closes)?.direction === direction
}
