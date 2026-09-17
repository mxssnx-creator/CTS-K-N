/**
 * Historic Test — signals from the SYSTEM's own indication configs.
 *
 * The replay previously derived entries from a fixed SMA crossover. That
 * measured a model the engine does not run: production evaluates a parameter
 * GRID of direction-change configs per symbol (range x drawdownRatio x
 * lastPartRatio x factorMultiplier) and keeps only the configs that qualify.
 * Scoring one unfiltered ad-hoc model and calling the result "the Base stage"
 * understates it badly — the engine's surviving Base sets are the qualifying
 * minority, not the average of every signal a naive model emits.
 *
 * This module mirrors `calculateDirectionIndication`: a direction CHANGE
 * between the first and second half of a `range * 2` price window, with the
 * config's own gates. Each config is an independent candidate, which is what
 * makes per-config validation meaningful.
 */
import { evaluateIndependentDirections } from "@/lib/directional-evaluation"
import type { DcaBacktestCandle } from "@/lib/dca-backtest"

export type HistoricSignalDirection = "long" | "short"
export interface HistoricSignal {
  /** Index of the candle on which the signal fires; entry is the next candle. */
  index: number
  direction: HistoricSignalDirection
}

export interface IndicationConfig {
  range: number
  drawdownRatio: number
  lastPartRatio: number
  factorMultiplier: number
}

/** The production defaults; the operator grid overrides them per connection. */
export const DEFAULT_INDICATION_GRID = {
  ranges: Array.from({ length: 29 }, (_, i) => i + 2),
  drawdownRatios: [0.5, 1.0, 1.5],
  lastPartRatios: [0.25, 0.5],
  factorMultipliers: [0.9, 1.0, 1.1],
} as const

export function indicationConfigKey(config: IndicationConfig): string {
  return `r${config.range}:dd${config.drawdownRatio}:lp${config.lastPartRatio}:f${config.factorMultiplier}`
}

/** Enumerate the config grid, optionally bounded so a pass stays affordable. */
export function enumerateIndicationConfigs(
  grid: {
    ranges?: readonly number[]
    drawdownRatios?: readonly number[]
    lastPartRatios?: readonly number[]
    factorMultipliers?: readonly number[]
  } = {},
  limit = 0,
): IndicationConfig[] {
  const ranges = grid.ranges ?? DEFAULT_INDICATION_GRID.ranges
  const drawdownRatios = grid.drawdownRatios ?? DEFAULT_INDICATION_GRID.drawdownRatios
  const lastPartRatios = grid.lastPartRatios ?? DEFAULT_INDICATION_GRID.lastPartRatios
  const factorMultipliers = grid.factorMultipliers ?? DEFAULT_INDICATION_GRID.factorMultipliers
  const out: IndicationConfig[] = []
  for (const range of ranges) {
    for (const drawdownRatio of drawdownRatios) {
      for (const lastPartRatio of lastPartRatios) {
        for (const factorMultiplier of factorMultipliers) {
          out.push({ range, drawdownRatio, lastPartRatio, factorMultiplier })
          if (limit > 0 && out.length >= limit) return out
        }
      }
    }
  }
  return out
}

/**
 * Directional strength of a price series, matching the engine's `getDirection`:
 * the sign of the overall move weighted by how consistently the individual
 * moves agree with it.
 */
export function directionStrength(prices: readonly number[]): number {
  if (prices.length < 2) return 0
  const first = Number(prices[0])
  const last = Number(prices[prices.length - 1])
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || first === last) return 0
  const sign = last > first ? 1 : -1
  let alignedMoves = 0
  let directionalMoves = 0
  for (let index = 1; index < prices.length; index++) {
    const movement = Number(prices[index]) - Number(prices[index - 1])
    if (movement === 0) continue
    directionalMoves++
    if ((sign > 0 && movement > 0) || (sign < 0 && movement < 0)) alignedMoves++
  }
  if (directionalMoves === 0) return 0
  const magnitude = Math.abs((last - first) / first)
  return sign * magnitude * (alignedMoves / directionalMoves)
}

export interface ConfigSignal extends HistoricSignal {
  signalScore: number
  postChangeCostRatio: number
}


/**
 * Signals one config would have produced over the candle series.
 *
 * A signal requires a direction CHANGE between the two window halves, the
 * independent-direction evaluation to agree with the new direction, and a
 * positive signal score after the drawdown penalty — the same three conditions
 * the engine applies before a candidate becomes a Base set.
 */
export function deriveConfigSignals(
  candles: readonly DcaBacktestCandle[],
  config: IndicationConfig,
  minSignalScore = 1,
): ConfigSignal[] {
  const range = Math.max(2, Math.floor(Number(config.range) || 2))
  const window = range * 2
  if (!Array.isArray(candles) || candles.length <= window + 1) return []

  const closes = candles.map((candle) => Number(candle.close))
  const signals: ConfigSignal[] = []

  for (let end = window; end < closes.length - 1; end++) {
    const prices = closes.slice(end - window, end)
    const firstHalf = prices.slice(0, range)
    const secondHalf = prices.slice(range)
    const firstDir = directionStrength(firstHalf)
    const secondDir = directionStrength(secondHalf)
    // Only a direction CHANGE is a candidate, exactly as in the engine.
    if (!(firstDir !== 0 && secondDir !== 0 && Math.sign(firstDir) !== Math.sign(secondDir))) continue

    const direction: HistoricSignalDirection = secondDir > 0 ? "long" : "short"
    const secondHalfMoves = secondHalf.slice(1).map((price, index) => {
      const previous = secondHalf[index]
      return previous > 0 ? (price - previous) / previous : 0
    })
    if (evaluateIndependentDirections(secondHalfMoves).selectedDirection !== direction) continue

    const oldest = Number(secondHalf[0])
    const newest = Number(secondHalf[secondHalf.length - 1])
    const postChangeMovement = oldest > 0 ? Math.abs(newest - oldest) / oldest : 0

    const reversalStrength = Math.abs(secondDir - firstDir)
    const drawdownPenalty = reversalStrength / Math.max(config.drawdownRatio * 10, 1)
    const tailWeight = 1 + config.lastPartRatio
    const signalScore = 1 + reversalStrength * config.factorMultiplier * tailWeight - drawdownPenalty
    if (!(signalScore >= minSignalScore)) continue

    signals.push({
      index: end,
      direction,
      signalScore,
      postChangeCostRatio: postChangeMovement * 100,
    })
  }
  return signals
}
