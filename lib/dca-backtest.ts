import { coordinateCtsGExit, type CtsGExitResult } from "./cts-g-exit"
import { evaluateCtsGTrend, evaluateCtsGBreak, coordinateCtsGEntry } from "./cts-g-indications"
import {
  calculateDcaAddQuantity,
  calculateDcaTakeProfitPrice,
  normalizeDcaProfile,
  type DcaProfile,
} from "./dca-strategy"

export type DcaBacktestEntry = "momentum" | "mean_reversion" | "breakout" | "relative" | "trend" | "break" | "trend_break"
export type DcaBacktestDirection = "long" | "short"

export interface DcaBacktestCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface DcaBacktestConfig {
  profile: DcaProfile
  timeframeMinutes: 5 | 15 | 30
  entry: DcaBacktestEntry
  takeProfitPct: number
  stopLossPct: number
  maxHoldMinutes?: number
  roundTripCostPct?: number
  slippagePct?: number
  /** Earlier candles warm indicators without allowing entries before this time. */
  ctsGExitCoordination?: boolean
  requireDcaDirectionConfirmation?: boolean
  exitOnConfirmedReversal?: boolean
  tradeStartTime?: number
}

export interface DcaBacktestTrade {
  direction: DcaBacktestDirection
  entryTime: number
  exitTime: number
  exitReason: "tp" | "sl" | "timeout" | "reversal"
  initialEntryPrice: number
  averageEntryPrice: number
  exitPrice: number
  volumeRatio: number
  dcaSteps: number
  pnlPctOfInitialNotional: number
  holdTimeMin: number
  drawdownTimeMin: number
  maxAdversePnlPct: number
  maxIntratradeDrawdownPct: number
}

export interface DcaBacktestResult {
  trades: DcaBacktestTrade[]
  closedTrades: number
  wins: number
  losses: number
  winRatePct: number
  netPnlPct: number
  grossProfitPct: number
  grossLossPct: number
  profitFactor: number | null
  profitFactorInfinite: boolean
  maxEquityDrawdownPct: number
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
  maxPositionVolumeRatio: number
  averagePositionVolumeRatio: number
}

function finitePositive(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0
  const multiplier = 2 / (period + 1)
  let result = values[0]
  for (let index = 1; index < values.length; index++) {
    result = values[index] * multiplier + result * (1 - multiplier)
  }
  return result
}

function rsi(values: readonly number[]): number {
  if (values.length < 2) return 50
  let gains = 0
  let losses = 0
  for (let index = 1; index < values.length; index++) {
    const change = values[index] - values[index - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  if (losses === 0) return gains > 0 ? 100 : 50
  const relative = gains / losses
  return 100 - 100 / (1 + relative)
}

function entryDirection(
  candles: readonly DcaBacktestCandle[],
  index: number,
  entry: DcaBacktestEntry,
): DcaBacktestDirection | null {
  if (index < 30) return null
  if (["trend", "break", "trend_break"].includes(entry)) {
    const closes = candles.slice(Math.max(0, index - 240), index + 1).map((candle) => candle.close)
    return (entry === "trend" ? evaluateCtsGTrend(closes) : entry === "break" ? evaluateCtsGBreak(closes) : coordinateCtsGEntry(closes))?.direction || null
  }
  const window = candles.slice(index - 30, index + 1)
  const closes = window.map((candle) => candle.close)
  const current = candles[index]
  const previous = candles[index - 1]
  const fast = ema(closes.slice(-13), 8)
  const slow = ema(closes, 21)
  const recentRsi = rsi(closes.slice(-15))
  const volumeAverage = average(window.slice(-20).map((candle) => candle.volume))
  const liquid = volumeAverage <= 0 || current.volume >= volumeAverage * 0.55

  if (entry === "momentum") {
    if (liquid && fast > slow && current.close > previous.close) return "long"
    if (liquid && fast < slow && current.close < previous.close) return "short"
    return null
  }
  if (entry === "mean_reversion") {
    if (recentRsi <= 38 && current.close < slow) return "long"
    if (recentRsi >= 62 && current.close > slow) return "short"
    return null
  }
  if (entry === "breakout") {
    const prior = candles.slice(index - 18, index)
    if (liquid && current.close >= Math.max(...prior.map((candle) => candle.high))) return "long"
    if (liquid && current.close <= Math.min(...prior.map((candle) => candle.low))) return "short"
    return null
  }

  const deviationPct = slow > 0 ? ((current.close - slow) / slow) * 100 : 0
  if (fast >= slow && deviationPct <= -0.18 && recentRsi < 48) return "long"
  if (fast <= slow && deviationPct >= 0.18 && recentRsi > 52) return "short"
  return null
}

type PreparedDcaMarket = {
  candles: DcaBacktestCandle[]
  directions: Map<DcaBacktestEntry, Array<DcaBacktestDirection | null>>
}

// Long optimizer runs evaluate thousands of risk profiles over the exact same
// immutable candle arrays.  Sorting/filtering the market and recalculating the
// EMA/RSI entry decision for every profile used to dominate the six-week
// search even though DCA distances, volume and protection do not affect entry
// direction.  Cache only those profile-independent inputs by array identity;
// every candidate still executes its complete independent position lifecycle.
const preparedMarketCache = new WeakMap<object, PreparedDcaMarket>()

function prepareDcaMarket(
  sourceCandles: readonly DcaBacktestCandle[],
): PreparedDcaMarket {
  const cacheKey = sourceCandles as object
  const cached = preparedMarketCache.get(cacheKey)
  if (cached) return cached
  const prepared = {
    candles: [...sourceCandles]
      .filter((candle) =>
        Number.isFinite(candle.time) &&
        candle.close > 0 &&
        candle.high > 0 &&
        candle.low > 0
      )
      .sort((left, right) => left.time - right.time),
    directions: new Map<DcaBacktestEntry, Array<DcaBacktestDirection | null>>(),
  }
  preparedMarketCache.set(cacheKey, prepared)
  return prepared
}

function preparedEntryDirections(
  prepared: PreparedDcaMarket,
  entry: DcaBacktestEntry,
): Array<DcaBacktestDirection | null> {
  const cached = prepared.directions.get(entry)
  if (cached) return cached
  const directions = prepared.candles.map((_candle, index) =>
    entryDirection(prepared.candles, index, entry),
  )
  prepared.directions.set(entry, directions)
  return directions
}

function weightedAverage(legs: Array<{ price: number; quantity: number }>): number {
  const quantity = legs.reduce((sum, leg) => sum + leg.quantity, 0)
  return quantity > 0
    ? legs.reduce((sum, leg) => sum + leg.price * leg.quantity, 0) / quantity
    : 0
}

function pricePnlPct(
  direction: DcaBacktestDirection,
  legs: Array<{ price: number; quantity: number }>,
  exitPrice: number,
): number {
  return legs.reduce((sum, leg) => sum + leg.quantity * (
    direction === "long"
      ? ((exitPrice - leg.price) / legs[0].price) * 100
      : ((leg.price - exitPrice) / legs[0].price) * 100
  ), 0)
}

/**
 * Conservative deterministic DCA simulation.
 *
 * Within one OHLC candle, an original-entry stop is evaluated first, then the
 * already-active TP. A newly crossed DCA step is filled only after neither
 * exit was possible and its adjusted TP becomes active on the next candle.
 * This prevents the optimizer from assuming an unknowable low→high path that
 * would make same-candle DCA recoveries look artificially perfect.
 */
export function runDcaBacktest(
  sourceCandles: readonly DcaBacktestCandle[],
  rawConfig: DcaBacktestConfig,
): DcaBacktestResult {
  const prepared = prepareDcaMarket(sourceCandles)
  const candles = prepared.candles
  const entryDirections = preparedEntryDirections(prepared, rawConfig.entry)
  const confirmationDirections = rawConfig.requireDcaDirectionConfirmation || rawConfig.exitOnConfirmedReversal
    ? preparedEntryDirections(prepared, "trend_break") : []
  const profile = normalizeDcaProfile(rawConfig.profile)
  const timeframeMinutes = rawConfig.timeframeMinutes
  const takeProfitPct = finitePositive(rawConfig.takeProfitPct, 0.6)
  const stopLossPct = Math.max(
    finitePositive(rawConfig.stopLossPct, 2.5),
    profile.stepDistancesPct[Math.max(0, profile.maxSteps - 1)] + 0.1,
  )
  const maxHoldCandles = Math.max(
    1,
    Math.ceil(finitePositive(rawConfig.maxHoldMinutes, 12 * 60) / timeframeMinutes),
  )
  const roundTripCostPct = Math.max(0, Number(rawConfig.roundTripCostPct ?? 0.1) || 0)
  const slippagePct = Math.max(0, Number(rawConfig.slippagePct ?? 0.02) || 0)
  const trades: DcaBacktestTrade[] = []
  const exitHistory: CtsGExitResult[] = []

  let index = 30
  while (index < candles.length - 1) {
    const direction = entryDirections[index]
    if (!direction || candles[index].time < Number(rawConfig.tradeStartTime || 0)) {
      index++
      continue
    }

    const entryCandle = candles[index]
    const initialEntryPrice = entryCandle.close * (direction === "long"
      ? 1 + slippagePct / 100
      : 1 - slippagePct / 100)
    const legs = [{ price: initialEntryPrice, quantity: 1 }]
    let averageEntryPrice = initialEntryPrice
    let takeProfitPrice = calculateDcaTakeProfitPrice({
      direction,
      profile,
      initialEntryPrice,
      averageEntryPrice,
      takeProfitPct,
    })
    let stopPrice = direction === "long"
      ? initialEntryPrice * (1 - stopLossPct / 100)
      : initialEntryPrice * (1 + stopLossPct / 100)
    let peakPrice = initialEntryPrice
    let exitLane: CtsGExitResult["lane"] = "hard"
    let nextDcaStep = 1
    let exitPrice = entryCandle.close
    let exitReason: DcaBacktestTrade["exitReason"] = "timeout"
    let exitIndex = index
    let drawdownStart: number | null = null
    let longestDrawdownMs = 0
    let maxAdversePnlPct = 0
    let markPeak = 0
    let maxIntratradeDrawdownPct = 0
    const feesAt = (mark: number): number => roundTripCostPct / 2 * legs.reduce(
      (sum, leg) => sum + leg.quantity * (leg.price + mark) / initialEntryPrice, 0,
    )

    for (
      let cursor = index + 1;
      cursor < candles.length && cursor - index <= maxHoldCandles;
      cursor++
    ) {
      const candle = candles[cursor]
      exitIndex = cursor
      // Only a signal known before this bar may authorize its DCA fill or exit.
      const confirmedDirection = confirmationDirections[cursor - 1]
      if (rawConfig.exitOnConfirmedReversal && confirmedDirection && confirmedDirection !== direction) {
        exitPrice = candle.open * (direction === "long" ? 1 - slippagePct / 100 : 1 + slippagePct / 100)
        exitReason = "reversal"
        break
      }
      const adverseMark = direction === "long"
        ? Math.max(candle.low, Math.min(stopPrice, candle.open))
        : Math.min(candle.high, Math.max(stopPrice, candle.open))
      const adversePnl = pricePnlPct(direction, legs, adverseMark) - feesAt(adverseMark)
      maxAdversePnlPct = Math.min(maxAdversePnlPct, adversePnl)
      maxIntratradeDrawdownPct = Math.max(maxIntratradeDrawdownPct, markPeak - adversePnl)
      const closePnl = pricePnlPct(direction, legs, candle.close) - feesAt(candle.close)
      if (closePnl < 0) {
        drawdownStart ??= candle.time
        longestDrawdownMs = Math.max(longestDrawdownMs, candle.time - drawdownStart)
      } else {
        drawdownStart = null
      }

      const stopped = direction === "long" ? candle.low <= stopPrice : candle.high >= stopPrice
      if (stopped) {
        exitPrice = (direction === "long" ? Math.min(stopPrice, candle.open) : Math.max(stopPrice, candle.open)) * (direction === "long"
          ? 1 - slippagePct / 100
          : 1 + slippagePct / 100)
        exitReason = "sl"
        break
      }
      const profited = direction === "long"
        ? candle.high >= takeProfitPrice
        : candle.low <= takeProfitPrice
      if (profited) {
        exitPrice = takeProfitPrice * (direction === "long"
          ? 1 - slippagePct / 100
          : 1 + slippagePct / 100)
        exitReason = "tp"
        break
      }

      markPeak = Math.max(markPeak, closePnl)
      if (nextDcaStep <= profile.maxSteps && (!rawConfig.requireDcaDirectionConfirmation || confirmedDirection === direction)) {
        const distance = profile.stepDistancesPct[nextDcaStep - 1]
        const triggerPrice = direction === "long"
          ? initialEntryPrice * (1 - distance / 100)
          : initialEntryPrice * (1 + distance / 100)
        const crossed = direction === "long" ? candle.low <= triggerPrice : candle.high >= triggerPrice
        if (crossed) {
          const currentQuantity = legs.reduce((sum, leg) => sum + leg.quantity, 0)
          const addQuantity = calculateDcaAddQuantity(
            1,
            profile.stepVolumeMultipliers[nextDcaStep - 1],
            currentQuantity,
            profile.maxPositionVolumeRatio,
          )
          if (addQuantity > 0) {
            const fillPrice = triggerPrice * (direction === "long"
              ? 1 + slippagePct / 100
              : 1 - slippagePct / 100)
            legs.push({ price: fillPrice, quantity: addQuantity })
            averageEntryPrice = weightedAverage(legs)
            takeProfitPrice = calculateDcaTakeProfitPrice({
              direction,
              profile,
              initialEntryPrice,
              averageEntryPrice,
              takeProfitPct,
            })
          }
          nextDcaStep++
        }
      }

      if (rawConfig.ctsGExitCoordination) {
        peakPrice = direction === "long" ? Math.max(peakPrice, candle.close) : Math.min(peakPrice, candle.close)
        const next = coordinateCtsGExit({ direction, entryPrice: averageEntryPrice, markPrice: candle.close, peakPrice,
          hardStopPrice: stopPrice, ageSeconds: (candle.time - entryCandle.time) / 1000,
          positionCostPct: roundTripCostPct + slippagePct * 2, history: exitHistory })
        if (next.lane !== "hard") { stopPrice = next.stopPrice; exitLane = next.lane }
      }

      if (cursor - index >= maxHoldCandles || cursor === candles.length - 1) {
        exitPrice = candle.close * (direction === "long"
          ? 1 - slippagePct / 100
          : 1 + slippagePct / 100)
        exitReason = "timeout"
        break
      }
    }

    const volumeRatio = legs.reduce((sum, leg) => sum + leg.quantity, 0)
    const grossPnlPct = pricePnlPct(direction, legs, exitPrice)
    const pnlPctOfInitialNotional = grossPnlPct - feesAt(exitPrice)
    exitHistory.push({ lane: exitLane, netMovePct: pnlPctOfInitialNotional / volumeRatio })
    if (exitHistory.length > 80) exitHistory.shift()
    trades.push({
      direction,
      entryTime: entryCandle.time,
      exitTime: candles[exitIndex]?.time ?? entryCandle.time,
      exitReason,
      initialEntryPrice,
      averageEntryPrice,
      exitPrice,
      volumeRatio,
      dcaSteps: legs.length - 1,
      pnlPctOfInitialNotional,
      holdTimeMin: Math.max(
        0,
        ((candles[exitIndex]?.time ?? entryCandle.time) - entryCandle.time) / 60_000,
      ),
      drawdownTimeMin: longestDrawdownMs / 60_000,
      maxAdversePnlPct,
      maxIntratradeDrawdownPct,
    })
    index = Math.max(index + 1, exitIndex + 1)
  }

  let grossProfitPct = 0
  let grossLossPct = 0
  let equity = 0
  let equityPeak = 0
  let maxEquityDrawdownPct = 0
  for (const trade of trades) {
    if (trade.pnlPctOfInitialNotional > 0) grossProfitPct += trade.pnlPctOfInitialNotional
    else grossLossPct += Math.abs(trade.pnlPctOfInitialNotional)
    maxEquityDrawdownPct = Math.max(maxEquityDrawdownPct, equityPeak - (equity + trade.maxAdversePnlPct), trade.maxIntratradeDrawdownPct)
    equity += trade.pnlPctOfInitialNotional
    equityPeak = Math.max(equityPeak, equity)
    maxEquityDrawdownPct = Math.max(maxEquityDrawdownPct, equityPeak - equity)
  }
  const wins = trades.filter((trade) => trade.pnlPctOfInitialNotional > 0).length
  const profitFactorInfinite = grossLossPct === 0 && grossProfitPct > 0
  return {
    trades,
    closedTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    netPnlPct: grossProfitPct - grossLossPct,
    grossProfitPct,
    grossLossPct,
    profitFactor: grossLossPct > 0 ? grossProfitPct / grossLossPct : profitFactorInfinite ? null : 0,
    profitFactorInfinite,
    maxEquityDrawdownPct,
    averageDrawdownTimeMin: average(trades.map((trade) => trade.drawdownTimeMin)),
    maxDrawdownTimeMin: Math.max(0, ...trades.map((trade) => trade.drawdownTimeMin)),
    maxPositionVolumeRatio: Math.max(1, ...trades.map((trade) => trade.volumeRatio)),
    averagePositionVolumeRatio: trades.length > 0
      ? average(trades.map((trade) => trade.volumeRatio))
      : 1,
  }
}
