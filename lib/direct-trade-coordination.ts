/**
 * Direct-Trade historical coordination.
 *
 * This module deliberately keeps every evaluated configuration independent.
 * A stable set key includes the symbol, direction, timeframe combination,
 * entry/exit tactic, activity gate and protection parameters.  The processor
 * can therefore attach PF/DDT history to the exact candidate that produced a
 * position instead of sharing it with a superficially similar configuration.
 */

// Kept dependency-free so the deterministic CLI matrix can load this module
// through ts-node without a Next path resolver. These values mirror the
// canonical `position-cost.ts` contract (0.02–1%, default 0.1%).
const DIRECT_TRADE_POSITION_COST_PERCENT_MIN = 0.02
const DIRECT_TRADE_POSITION_COST_PERCENT_MAX = 1
const DIRECT_TRADE_POSITION_COST_PERCENT_DEFAULT = 0.1

function normalizeDirectTradePositionCostPercent(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DIRECT_TRADE_POSITION_COST_PERCENT_DEFAULT
  return Math.max(DIRECT_TRADE_POSITION_COST_PERCENT_MIN, Math.min(DIRECT_TRADE_POSITION_COST_PERCENT_MAX, parsed))
}

export const DIRECT_TRADE_TIMEFRAMES = ["1m", "10m", "15m"] as const
export const DIRECT_TRADE_ENTRY_TACTICS = ["momentum", "mean_reversion", "breakout", "relative"] as const
export const DIRECT_TRADE_EXIT_TACTICS = ["bracket", "momentum_reversal", "relative", "time"] as const
// Direct-Trade protection is expressed in PositionCost multiples, not as an
// unrelated fixed price percentage.  With the default PositionCost of 0.1%,
// the default 4–12 grid therefore evaluates TP targets from 0.4% to 1.2%.
// Keeping the ratio integral makes the UI, persisted state and set identity
// unambiguous across a PositionCost change.
export const DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN = 2
export const DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX = 12
export const DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE: [number, number] = [4, 12]
// Recent closed positions are a stronger gate than the long-history PF.
// Keep this exported so calculation and runtime use the identical default.
export const DIRECT_TRADE_RECENT_PF_DEFAULT = 25
// Each strategy type is deliberately a separate lineage. It may share market
// data with another type, but never a set key, entry signal, PF/DDT history or
// order lane.
export const DIRECT_TRADE_STRATEGY_TYPES = [
  "standard",
  "trailing_fixed",
  // Auto trailing has its own independent life cycle, configuration keys and
  // execution queue.  It must not be conflated with the multi-coordinate
  // Combination type below.
  "trailing_auto",
  // Combination is the former "complex" lineage: it evaluates each normal,
  // fixed-trailing and auto-trailing protection leg independently while the
  // entry uses the selected 1m/10m/15m coordination set.
  "combination",
  "inverse",
  "high_protection",
] as const

export type DirectTradeTimeframe = typeof DIRECT_TRADE_TIMEFRAMES[number]
export type DirectTradeEntryTactic = typeof DIRECT_TRADE_ENTRY_TACTICS[number]
export type DirectTradeExitTactic = typeof DIRECT_TRADE_EXIT_TACTICS[number]
export type DirectTradeStrategyType = typeof DIRECT_TRADE_STRATEGY_TYPES[number]
export type DirectTradeEntryTiming = "current" | "last_confirmed"
export type DirectTradeDirection = "long" | "short"
export type DirectTradeTrailingMode = "none" | "fixed" | "auto"

export interface DirectTradeTrailOption {
  trailing: boolean
  trailStart: number
  trailStop: number
  mode?: DirectTradeTrailingMode
  // Auto profiles use current activity and recent realised movement for every
  // update. The sensitivity is part of the stable set identity.
  autoTrailSensitivity?: number
}

export interface DirectTradeCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface DirectTradeSimTrade {
  entryPrice: number
  exitPrice: number
  bestMarketExitPrice: number
  entryTime: number
  exitTime: number
  direction: DirectTradeDirection
  pnlPercent: number
  bestMarketExitPnlPercent: number
  drawdownTimeMin: number
  exitReason: "tp" | "sl" | "trailing" | "momentum_reversal" | "relative_reversal" | "timeout"
}

interface DirectTradeSimulationMetrics {
  totalTrades: number
  wins: number
  totalProfit: number
  totalLoss: number
  totalPnl: number
  bestMarketExitPnl: number
  totalDrawdownTimeMin: number
  maxDrawdownTimeMin: number
  // A fixed, tiny window keeps fresh-position diagnostics available without
  // retaining full simulated trade arrays for every independent set.
  recentPositions: Array<Pick<DirectTradeSimTrade,
    "pnlPercent" | "bestMarketExitPnlPercent" | "drawdownTimeMin" | "exitReason"
  >>
}

export interface DirectTradeSet {
  setKey: string
  symbol: string
  direction: DirectTradeDirection
  // The market observation can deliberately be the opposing direction for an
  // inverse order. `direction` remains the actual, independently managed
  // order side and is never netted against the signal side.
  signalDirection: DirectTradeDirection
  strategyType: DirectTradeStrategyType
  timeframe: string
  timeframeSet: DirectTradeTimeframe[]
  historyHours: number
  entryTactic: DirectTradeEntryTactic
  exitTactic: DirectTradeExitTactic
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
  takeprofit: number
  // TP multiple relative to this exact set's PositionCost.  `takeprofit`
  // remains the executable price-percent distance for bracket/trailing code.
  takeProfitPositionCostRatio: number
  stoploss: number
  trailing: boolean
  trailingMode: DirectTradeTrailingMode
  trailStart: number
  trailStop: number
  autoTrailSensitivity: number | null
  blockCount: number
  blockVolumeRatio: number
  // Legacy storage alias retained while existing persisted grids roll over.
  volumeRatio: number
  positionCostPercent: number
  valid: boolean
  deactivationReason: "warming" | "recent_warming" | "pf" | "recent_pf" | "win_rate" | "ddt" | null
  profitFactor: number | null
  profitFactorInfinite: boolean
  winRate: number
  totalTrades: number
  avgDrawdownTimeMin: number
  maxDrawdownTimeMin: number
  score: number
  totalPnl: number
  bestMarketExitPnl: number
  // Fresh-position diagnostics are an independent historical last-position
  // gate. They complement complete-history PF/DDT checks so a stale winner is
  // not made executable after its latest closed positions weaken.
  lastPositionPnl: number | null
  lastPositionBestMarketExitPnl: number | null
  lastPositionDrawdownTimeMin: number | null
  lastPositionExitReason: DirectTradeSimTrade["exitReason"] | null
  recentPositionCount: number
  recentProfitFactor: number | null
  recentProfitFactorInfinite: boolean
  recentWinRate: number
  recentTotalPnl: number
  recentAvgDrawdownTimeMin: number
  // Hindsight-only analytic: it is never used as a live order target.
  bestMarketExitAnalysisOnly: true
  // Current, causal entry state. The processor may never turn a historic-only
  // backtest win into a fresh order without this signal being active.
  entrySignalKey: string
  activeEntry: boolean
  activeEntryAt: number | null
}

export interface DirectTradeEvaluationInput {
  symbol: string
  direction: DirectTradeDirection
  candlesByTimeframe: Partial<Record<DirectTradeTimeframe, DirectTradeCandle[]>>
  timeframeSet: DirectTradeTimeframe[]
  historyHours: number
  volumeRatio: number
  tpRange: number[]
  // Parallel to tpRange when the caller owns the PositionCost-ratio grid.
  // Older callers may provide fixed percentages; their ratio is derived.
  takeProfitPositionCostRatios?: number[]
  slRatios: number[]
  trailOptions: DirectTradeTrailOption[]
  entryTactics: DirectTradeEntryTactic[]
  exitTactics: DirectTradeExitTactic[]
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
  maxHoldMinutes: number
  positionCostPercent?: number
  blockRange: [number, number]
  minProfitFactor: number
  minRecentProfitFactor?: number
  recentPositionWindow?: number
  minRecentPositions?: number
  maxDrawdownTimeMin: number
  minTrades?: number
  strategyType?: DirectTradeStrategyType
  signalDirection?: DirectTradeDirection
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value: number, places = 4): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function normaliseDirectTradeTakeProfitRatioRange(
  value: unknown,
  fallback: [number, number] = DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return [...fallback] as [number, number]
  const requestedMinimum = Number(value[0])
  const requestedMaximum = Number(value[1])
  const minimum = Math.max(
    DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN,
    Math.min(
      DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX,
      Math.round(Number.isFinite(requestedMinimum) ? requestedMinimum : fallback[0]),
    ),
  )
  const maximum = Math.max(
    minimum,
    Math.min(
      DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX,
      Math.round(Number.isFinite(requestedMaximum) ? requestedMaximum : fallback[1]),
    ),
  )
  return [minimum, maximum]
}

export function buildDirectTradeTakeProfitPositionCostRatios(
  value: unknown,
): number[] {
  const [minimum, maximum] = normaliseDirectTradeTakeProfitRatioRange(value)
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
}

export function directTradeTakeProfitPercent(
  positionCostPercent: unknown,
  positionCostRatio: unknown,
): number {
  const cost = normalizeDirectTradePositionCostPercent(positionCostPercent)
  const ratio = Math.max(
    DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN,
    Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, Math.round(finite(positionCostRatio, 0))),
  )
  return round(cost * ratio)
}

export function normaliseDirectTradeTimeframes(value: unknown): DirectTradeTimeframe[] {
  const raw = Array.isArray(value) ? value : []
  const mapped = raw.map((item) => item === "5m" ? "10m" : item)
    .filter((item): item is DirectTradeTimeframe => DIRECT_TRADE_TIMEFRAMES.includes(item as DirectTradeTimeframe))
  const unique = [...new Set(mapped)]
  return unique.length > 0 ? unique : [...DIRECT_TRADE_TIMEFRAMES]
}

export function normaliseEntryTactics(value: unknown): DirectTradeEntryTactic[] {
  const raw = Array.isArray(value) ? value : []
  const tactics = raw.filter((item): item is DirectTradeEntryTactic =>
    DIRECT_TRADE_ENTRY_TACTICS.includes(item as DirectTradeEntryTactic),
  )
  return tactics.length > 0 ? [...new Set(tactics)] : [...DIRECT_TRADE_ENTRY_TACTICS]
}

export function normaliseExitTactics(value: unknown): DirectTradeExitTactic[] {
  const raw = Array.isArray(value) ? value : []
  const tactics = raw.filter((item): item is DirectTradeExitTactic =>
    DIRECT_TRADE_EXIT_TACTICS.includes(item as DirectTradeExitTactic),
  )
  return tactics.length > 0 ? [...new Set(tactics)] : [...DIRECT_TRADE_EXIT_TACTICS]
}

export function normaliseDirectTradeStrategyTypes(value: unknown): DirectTradeStrategyType[] {
  const raw = Array.isArray(value) ? value : []
  // Keep old stored settings live while separating Auto Trailing from the
  // renamed Combination lineage. "Complex" was renamed to Combination;
  // the temporary "trailing_auto_combination" label was Auto Trailing.
  const migrated = raw.map((item) =>
    item === "trailing_auto_combination" ? "trailing_auto"
      : item === "trailing_auto_complex" || item === "complex" ? "combination"
        : item,
  )
  const types = migrated.filter((item): item is DirectTradeStrategyType =>
    DIRECT_TRADE_STRATEGY_TYPES.includes(item as DirectTradeStrategyType),
  )
  return types.length > 0 ? [...new Set(types)] : [...DIRECT_TRADE_STRATEGY_TYPES]
}

export function buildTimeframeCombinations(timeframes: DirectTradeTimeframe[]): DirectTradeTimeframe[][] {
  const frames = normaliseDirectTradeTimeframes(timeframes)
  const result: DirectTradeTimeframe[][] = []
  for (let mask = 1; mask < 2 ** frames.length; mask++) {
    result.push(frames.filter((_, index) => (mask & (1 << index)) !== 0))
  }
  return result
}

export function timeframeMinutes(timeframe: DirectTradeTimeframe): number {
  return timeframe === "1m" ? 1 : timeframe === "10m" ? 10 : 15
}

/** Aggregate a closed 1m series locally so 10m is never misrepresented as 15m. */
export function resampleCandles(candles: DirectTradeCandle[], minutes: number): DirectTradeCandle[] {
  if (minutes <= 1) return [...candles].sort((a, b) => a.time - b.time)
  const bucketMs = minutes * 60_000
  const buckets = new Map<number, { candle: DirectTradeCandle; samples: number }>()
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs
    const existing = buckets.get(bucket)
    if (!existing) {
      buckets.set(bucket, { candle: { ...candle, time: bucket }, samples: 1 })
      continue
    }
    existing.candle.high = Math.max(existing.candle.high, candle.high)
    existing.candle.low = Math.min(existing.candle.low, candle.low)
    existing.candle.close = candle.close
    existing.candle.volume += candle.volume
    existing.samples++
  }
  // Never turn a partially formed current candle into a complete 10m/15m
  // decision input. Missing minute samples are treated the same way.
  return [...buckets.values()]
    .filter((entry) => entry.samples === minutes)
    .map((entry) => entry.candle)
    .sort((a, b) => a.time - b.time)
}

function rsi(closes: number[]): number {
  if (closes.length < 2) return 50
  let gains = 0
  let losses = 0
  for (let index = 1; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  if (losses === 0) return gains > 0 ? 100 : 50
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function entrySignal(
  candles: DirectTradeCandle[],
  index: number,
  direction: DirectTradeDirection,
  tactic: DirectTradeEntryTactic,
  entryTiming: DirectTradeEntryTiming,
  activityVolumeRatio: number,
): boolean {
  const effective = entryTiming === "last_confirmed" ? index - 1 : index
  if (effective < 14) return false
  const history = candles.slice(effective - 14, effective)
  const closes = history.map((candle) => candle.close)
  const current = candles[effective]
  const previous = candles[effective - 1]
  const recentHigh = Math.max(...history.map((candle) => candle.high))
  const recentLow = Math.min(...history.map((candle) => candle.low))
  const ema5 = average(closes.slice(-5))
  const ema14 = average(closes)
  const currentRsi = rsi(closes)
  const momentum = previous.close > 0 ? (current.close - previous.close) / previous.close : 0
  const averageVolume = average(history.map((candle) => candle.volume))
  const activeEnough = averageVolume <= 0 || current.volume >= averageVolume * Math.max(0, activityVolumeRatio)
  if (!activeEnough) return false

  if (tactic === "mean_reversion") {
    return direction === "long"
      ? currentRsi < 35 && current.close > ema5 && ema5 >= ema14
      : currentRsi > 65 && current.close < ema5 && ema5 <= ema14
  }
  if (tactic === "breakout") {
    return direction === "long"
      ? current.close > recentHigh && momentum > 0
      : current.close < recentLow && momentum < 0
  }
  if (tactic === "relative") {
    // A directional, range-normalised entry.  Unlike a bare momentum trigger,
    // it requires a measured move away from the 14-candle reference and a
    // still-healthy position inside the recent range. This keeps it a
    // separately scored candidate rather than a hidden parameter of another
    // entry tactic.
    const referenceMove = ema14 > 0 ? (current.close - ema14) / ema14 : 0
    const range = recentHigh - recentLow
    const rangePosition = range > 0 ? (current.close - recentLow) / range : 0.5
    return direction === "long"
      ? referenceMove > 0.001 && rangePosition >= 0.55 && ema5 >= ema14 && currentRsi >= 45 && currentRsi < 72
      : referenceMove < -0.001 && rangePosition <= 0.45 && ema5 <= ema14 && currentRsi <= 55 && currentRsi > 28
  }
  return direction === "long"
    ? momentum > 0.002 && ema5 > ema14 && currentRsi < 72
    : momentum < -0.002 && ema5 < ema14 && currentRsi > 28
}

function buildCompositeSignals(
  candlesByTimeframe: Partial<Record<DirectTradeTimeframe, DirectTradeCandle[]>>,
  frames: DirectTradeTimeframe[],
  direction: DirectTradeDirection,
  tactic: DirectTradeEntryTactic,
  entryTiming: DirectTradeEntryTiming,
  activityVolumeRatio: number,
): { candles: DirectTradeCandle[]; signals: boolean[]; minutes: number } | null {
  const ordered = [...frames].sort((left, right) => timeframeMinutes(left) - timeframeMinutes(right))
  const primaryFrame = ordered[0]
  const primary = candlesByTimeframe[primaryFrame] || []
  if (primary.length < 30) return null
  const signalByFrame = new Map<DirectTradeTimeframe, Map<number, boolean>>()
  for (const frame of ordered) {
    const candles = candlesByTimeframe[frame] || []
    if (candles.length < 30) return null
    const signalMap = new Map<number, boolean>()
    for (let index = 0; index < candles.length; index++) {
      signalMap.set(candles[index].time, entrySignal(
        candles,
        index,
        direction,
        tactic,
        entryTiming,
        activityVolumeRatio,
      ))
    }
    signalByFrame.set(frame, signalMap)
  }

  const cursors = new Map<DirectTradeTimeframe, number>()
  const lastSignals = new Map<DirectTradeTimeframe, boolean>()
  const signals = primary.map((candle) => {
    for (const frame of ordered) {
      const candles = candlesByTimeframe[frame] || []
      let cursor = cursors.get(frame) || 0
      while (cursor < candles.length && candles[cursor].time <= candle.time) {
        lastSignals.set(frame, signalByFrame.get(frame)?.get(candles[cursor].time) === true)
        cursor++
      }
      cursors.set(frame, cursor)
    }
    return ordered.every((frame) => lastSignals.get(frame) === true)
  })
  return { candles: primary, signals, minutes: timeframeMinutes(primaryFrame) }
}

/**
 * Stable key for the inexpensive, current-market signal layer. Strategy
 * lineages participate so an inverse signal can never open a standard order;
 * TP/SL/trailing variants still retain fully independent evaluation and
 * performance histories through their distinct `setKey` values.
 */
export function directTradeEntrySignalKey(input: {
  symbol: string
  direction: DirectTradeDirection
  signalDirection?: DirectTradeDirection
  strategyType?: DirectTradeStrategyType
  timeframeSet: DirectTradeTimeframe[]
  entryTactic: DirectTradeEntryTactic
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
}): string {
  return [
    "direct-signal-v1",
    input.symbol,
    input.direction,
    `signal:${input.signalDirection || input.direction}`,
    `type:${input.strategyType || "standard"}`,
    `tf:${input.timeframeSet.join("+")}`,
    `entry:${input.entryTactic}`,
    `when:${input.entryTiming}`,
    `activity:${round(input.activityVolumeRatio, 4).toFixed(4)}`,
  ].join("|")
}

/**
 * Calculates only current causal entry signals. This is deliberately separate
 * from the large historic TP/SL/trailing grid: it lets the long-lived worker
 * refresh live eligibility every minute without repeatedly serialising or
 * recalculating hundreds of thousands of independent result sets.
 */
export function evaluateDirectTradeEntrySignals(input: {
  symbol: string
  candlesByTimeframe: Partial<Record<DirectTradeTimeframe, DirectTradeCandle[]>>
  timeframeSets: DirectTradeTimeframe[][]
  entryTactics: DirectTradeEntryTactic[]
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
  strategyTypes?: DirectTradeStrategyType[]
}): Array<{ key: string; active: boolean; activeAt: number | null }> {
  const result: Array<{ key: string; active: boolean; activeAt: number | null }> = []
  const strategyTypes = normaliseDirectTradeStrategyTypes(input.strategyTypes)
  for (const timeframeSet of input.timeframeSets) {
    for (const direction of ["long", "short"] as const) {
      for (const entryTactic of input.entryTactics) {
        for (const strategyType of strategyTypes) {
          const signalDirection: DirectTradeDirection = strategyType === "inverse"
            ? direction === "long" ? "short" : "long"
            : direction
          const composed = buildCompositeSignals(
            input.candlesByTimeframe,
            timeframeSet,
            signalDirection,
            entryTactic,
            input.entryTiming,
            input.activityVolumeRatio,
          )
          const active = composed?.signals.at(-1) === true
          result.push({
            key: directTradeEntrySignalKey({
              symbol: input.symbol,
              direction,
              signalDirection,
              strategyType,
              timeframeSet,
              entryTactic,
              entryTiming: input.entryTiming,
              activityVolumeRatio: input.activityVolumeRatio,
            }),
            active,
            activeAt: active ? composed?.candles.at(-1)?.time || null : null,
          })
        }
      }
    }
  }
  return result
}

function autoTrailingParameters(
  candles: DirectTradeCandle[],
  index: number,
  takeprofit: number,
  sensitivity: number,
): { trailStart: number; trailStop: number } {
  const start = Math.max(1, index - 12)
  const window = candles.slice(start, index + 1)
  const moves: number[] = []
  for (let offset = 1; offset < window.length; offset++) {
    const previous = window[offset - 1].close
    if (previous > 0) moves.push(Math.abs((window[offset].close - previous) / previous) * 100)
  }
  const volatility = average(moves)
  const avgVolume = average(window.map((candle) => candle.volume))
  const activity = avgVolume > 0 ? window.at(-1)!.volume / avgVolume : 1
  const activityBoost = Math.max(0.75, Math.min(1.35, activity))
  const safeSensitivity = Math.max(0.5, Math.min(1.5, finite(sensitivity, 1)))
  // Higher current activity activates the trail a little earlier while a
  // volatile series keeps a wider protective distance. Both parameters remain
  // below TP, so a trailing update cannot become an accidental TP target.
  const trailStart = Math.max(
    0.08,
    Math.min(
      takeprofit * 0.82,
      Math.max(takeprofit * (0.28 + safeSensitivity * 0.1), volatility * (1.1 + safeSensitivity * 0.35) / activityBoost),
    ),
  )
  const trailStop = Math.max(
    0.04,
    Math.min(trailStart * 0.82, Math.max(volatility * (0.35 + safeSensitivity * 0.12), trailStart * (0.32 + safeSensitivity * 0.08))),
  )
  return { trailStart, trailStop }
}

function marketExitSignal(
  candles: DirectTradeCandle[],
  index: number,
  direction: DirectTradeDirection,
): boolean {
  if (index < 5) return false
  const closes = candles.slice(index - 5, index).map((candle) => candle.close)
  const averageClose = average(closes)
  return direction === "long"
    ? candles[index].close < averageClose
    : candles[index].close > averageClose
}

function relativeExitSignal(input: {
  direction: DirectTradeDirection
  entryPrice: number
  currentPrice: number
  highWatermark: number
  lowWatermark: number
  takeprofit: number
}): boolean {
  // This is deliberately independent of the trailing stop. It closes a
  // relative reversal only after a meaningful favourable move, with both the
  // activation and retracement expressed as bounded fractions of that set's
  // own TP distance. It is therefore valid for normal and inverse directions.
  const activation = Math.max(0.1, Math.min(input.takeprofit * 0.5, 1.25))
  const retracement = Math.max(0.06, Math.min(input.takeprofit * 0.22, 0.65))
  if (input.direction === "long") {
    return input.highWatermark >= input.entryPrice * (1 + activation / 100)
      && input.currentPrice <= input.highWatermark * (1 - retracement / 100)
  }
  return input.lowWatermark <= input.entryPrice * (1 - activation / 100)
    && input.currentPrice >= input.lowWatermark * (1 + retracement / 100)
}

function simulateTrades(
  candles: DirectTradeCandle[],
  signals: boolean[],
  direction: DirectTradeDirection,
  takeprofit: number,
  stoploss: number,
  trailing: boolean,
  trailingMode: DirectTradeTrailingMode,
  trailStart: number,
  trailStop: number,
  autoTrailSensitivity: number | null,
  exitTactic: DirectTradeExitTactic,
  timeframeInMinutes: number,
  maxHoldMinutes: number,
  recentPositionWindow: number,
  positionCostPercent: number,
): DirectTradeSimulationMetrics {
  const metrics: DirectTradeSimulationMetrics = {
    totalTrades: 0,
    wins: 0,
    totalProfit: 0,
    totalLoss: 0,
    totalPnl: 0,
    bestMarketExitPnl: 0,
    totalDrawdownTimeMin: 0,
    maxDrawdownTimeMin: 0,
    recentPositions: [],
  }
  const maxHoldCandles = Math.max(1, Math.ceil(maxHoldMinutes / timeframeInMinutes))
  let index = 14
  while (index < candles.length - 1) {
    if (!signals[index]) {
      index++
      continue
    }
    const entry = candles[index]
    const entryPrice = entry.close
    let exitPrice = entryPrice
    let exitTime = entry.time
    let exitReason: DirectTradeSimTrade["exitReason"] = "timeout"
    let highWatermark = entryPrice
    let lowWatermark = entryPrice
    let bestMarketExitPrice = entryPrice
    let maxDrawdownMs = 0
    let drawdownStart: number | null = null
    let trailingArmed = false
    let lastIndex = index
    const tpPrice = direction === "long"
      ? entryPrice * (1 + takeprofit / 100)
      : entryPrice * (1 - takeprofit / 100)
    let slPrice = direction === "long"
      ? entryPrice * (1 - stoploss / 100)
      : entryPrice * (1 + stoploss / 100)

    for (let cursor = index + 1; cursor < candles.length && cursor - index <= maxHoldCandles; cursor++) {
      const candle = candles[cursor]
      lastIndex = cursor
      bestMarketExitPrice = direction === "long"
        ? Math.max(bestMarketExitPrice, candle.high)
        : Math.min(bestMarketExitPrice, candle.low)
      if (direction === "long") {
        if (candle.low <= slPrice) {
          exitPrice = slPrice
          exitTime = candle.time
          exitReason = trailing && trailingArmed ? "trailing" : "sl"
          break
        }
        if (candle.high >= tpPrice) {
          exitPrice = tpPrice
          exitTime = candle.time
          exitReason = "tp"
          break
        }
        if (trailing && candle.high > highWatermark) {
          highWatermark = candle.high
          const trailingParameters = trailingMode === "auto"
            ? autoTrailingParameters(candles, cursor, takeprofit, autoTrailSensitivity ?? 1)
            : { trailStart, trailStop }
          if (highWatermark >= entryPrice * (1 + trailingParameters.trailStart / 100)) {
            slPrice = Math.max(slPrice, highWatermark * (1 - trailingParameters.trailStop / 100))
            trailingArmed = true
          }
        }
      } else {
        if (candle.high >= slPrice) {
          exitPrice = slPrice
          exitTime = candle.time
          exitReason = trailing && trailingArmed ? "trailing" : "sl"
          break
        }
        if (candle.low <= tpPrice) {
          exitPrice = tpPrice
          exitTime = candle.time
          exitReason = "tp"
          break
        }
        if (trailing && candle.low < lowWatermark) {
          lowWatermark = candle.low
          const trailingParameters = trailingMode === "auto"
            ? autoTrailingParameters(candles, cursor, takeprofit, autoTrailSensitivity ?? 1)
            : { trailStart, trailStop }
          if (lowWatermark <= entryPrice * (1 - trailingParameters.trailStart / 100)) {
            slPrice = Math.min(slPrice, lowWatermark * (1 + trailingParameters.trailStop / 100))
            trailingArmed = true
          }
        }
      }
      const pnl = direction === "long"
        ? (candle.close - entryPrice) / entryPrice
        : (entryPrice - candle.close) / entryPrice
      if (pnl < 0) {
        drawdownStart ??= candle.time
        maxDrawdownMs = Math.max(maxDrawdownMs, candle.time - drawdownStart)
      } else {
        drawdownStart = null
      }
      if (exitTactic === "momentum_reversal" && marketExitSignal(candles, cursor, direction)) {
        exitPrice = candle.close
        exitTime = candle.time
        exitReason = "momentum_reversal"
        break
      }
      if (exitTactic === "relative" && relativeExitSignal({
        direction,
        entryPrice,
        currentPrice: candle.close,
        highWatermark,
        lowWatermark,
        takeprofit,
      })) {
        exitPrice = candle.close
        exitTime = candle.time
        exitReason = "relative_reversal"
        break
      }
      if (exitTactic === "time" && cursor - index >= maxHoldCandles) {
        exitPrice = candle.close
        exitTime = candle.time
        exitReason = "timeout"
        break
      }
    }
    if (exitTime === entry.time) {
      const final = candles[lastIndex]
      exitPrice = final.close
      exitTime = final.time
      exitReason = "timeout"
    }
    // Best-market-exit is explicitly an analytic counterfactual. Continue to
    // inspect the complete configured hold horizon after a TP/SL/reversal has
    // closed the actual simulated position, without feeding this knowledge
    // back into its PnL, score, eligibility, or any live execution field.
    const analysisEnd = Math.min(candles.length - 1, index + maxHoldCandles)
    for (let cursor = lastIndex + 1; cursor <= analysisEnd; cursor++) {
      bestMarketExitPrice = direction === "long"
        ? Math.max(bestMarketExitPrice, candles[cursor].high)
        : Math.min(bestMarketExitPrice, candles[cursor].low)
    }
    const grossPnlPercent = direction === "long"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100
    const grossBestMarketExitPnlPercent = direction === "long"
      ? ((bestMarketExitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - bestMarketExitPrice) / entryPrice) * 100
    // One complete position cost is realised only at closure. Open positions
    // never enter PF/DDT or a configuration's historical eligibility.
    const pnlPercent = grossPnlPercent - positionCostPercent
    const bestMarketExitPnlPercent = grossBestMarketExitPnlPercent - positionCostPercent
    const drawdownTimeMin = maxDrawdownMs / 60_000
    metrics.totalTrades++
    metrics.totalPnl += pnlPercent
    metrics.bestMarketExitPnl += bestMarketExitPnlPercent
    metrics.totalDrawdownTimeMin += drawdownTimeMin
    metrics.maxDrawdownTimeMin = Math.max(metrics.maxDrawdownTimeMin, drawdownTimeMin)
    if (pnlPercent > 0) {
      metrics.wins++
      metrics.totalProfit += pnlPercent
    } else {
      metrics.totalLoss += Math.abs(pnlPercent)
    }
    metrics.recentPositions.push({
      pnlPercent,
      bestMarketExitPnlPercent,
      drawdownTimeMin,
      exitReason,
    })
    if (metrics.recentPositions.length > recentPositionWindow) metrics.recentPositions.shift()
    // An exited candle cannot simultaneously open the next independent
    // historical position; move past it to avoid overlapping backtest rows.
    index = Math.max(index + 1, lastIndex + 1)
  }
  return metrics
}

function summarizeRecentPositions(simulation: DirectTradeSimulationMetrics) {
  const recent = simulation.recentPositions
  const last = recent.at(-1) || null
  const totalProfit = recent.reduce((sum, position) => sum + Math.max(0, position.pnlPercent), 0)
  const totalLoss = recent.reduce((sum, position) => sum + Math.max(0, -position.pnlPercent), 0)
  const profitFactorInfinite = totalLoss === 0 && totalProfit > 0
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : profitFactorInfinite ? null : 0
  const wins = recent.filter((position) => position.pnlPercent > 0).length
  return {
    lastPositionPnl: last ? round(last.pnlPercent) : null,
    lastPositionBestMarketExitPnl: last ? round(last.bestMarketExitPnlPercent) : null,
    lastPositionDrawdownTimeMin: last ? round(last.drawdownTimeMin, 1) : null,
    lastPositionExitReason: last?.exitReason || null,
    recentPositionCount: recent.length,
    recentProfitFactor: profitFactor == null ? null : round(profitFactor, 3),
    recentProfitFactorInfinite: profitFactorInfinite,
    recentWinRate: recent.length > 0 ? round((wins / recent.length) * 100, 1) : 0,
    recentTotalPnl: round(recent.reduce((sum, position) => sum + position.pnlPercent, 0)),
    recentAvgDrawdownTimeMin: recent.length > 0
      ? round(recent.reduce((sum, position) => sum + position.drawdownTimeMin, 0) / recent.length, 1)
      : 0,
  }
}

function stableSetKey(input: Pick<DirectTradeSet,
  "symbol" | "direction" | "signalDirection" | "strategyType" | "timeframe" | "entryTactic" | "exitTactic" | "entryTiming" |
  "activityVolumeRatio" | "takeprofit" | "takeProfitPositionCostRatio" | "stoploss" | "trailing" | "trailingMode" | "trailStart" | "trailStop" | "autoTrailSensitivity" | "historyHours" | "positionCostPercent" | "blockCount" | "blockVolumeRatio"
>): string {
  const numeric = (value: number) => round(value, 4).toFixed(4)
  return [
    "direct-v3",
    input.symbol,
    input.direction,
    `signal:${input.signalDirection}`,
    `type:${input.strategyType}`,
    `tf:${input.timeframe}`,
    `entry:${input.entryTactic}`,
    `exit:${input.exitTactic}`,
    `when:${input.entryTiming}`,
    `activity:${numeric(input.activityVolumeRatio)}`,
    `history:${numeric(input.historyHours)}`,
    `cost:${numeric(input.positionCostPercent)}`,
    `tpCost:${numeric(input.takeProfitPositionCostRatio)}`,
    `tp:${numeric(input.takeprofit)}`,
    `sl:${numeric(input.stoploss)}`,
    `tr:${input.trailing ? 1 : 0}`,
    `tm:${input.trailingMode}`,
    `ts:${numeric(input.trailStart)}`,
    `td:${numeric(input.trailStop)}`,
    `ta:${input.autoTrailSensitivity == null ? "none" : numeric(input.autoTrailSensitivity)}`,
    `block:${Math.max(0, Math.floor(input.blockCount))}`,
    `blockRatio:${numeric(input.blockVolumeRatio)}`,
  ].join("|")
}

export function evaluateDirectTradeSets(input: DirectTradeEvaluationInput): DirectTradeSet[] {
  const minTrades = Math.max(1, Math.floor(finite(input.minTrades, 3)))
  const recentPositionWindow = Math.max(3, Math.floor(finite(input.recentPositionWindow, 12)))
  const minRecentPositions = Math.min(
    recentPositionWindow,
    Math.max(3, Math.floor(finite(input.minRecentPositions, recentPositionWindow))),
  )
  const minRecentProfitFactor = Math.max(0.8, finite(input.minRecentProfitFactor, DIRECT_TRADE_RECENT_PF_DEFAULT))
  const positionCostPercent = normalizeDirectTradePositionCostPercent(input.positionCostPercent ?? DIRECT_TRADE_POSITION_COST_PERCENT_DEFAULT)
  const result: DirectTradeSet[] = []
  const timeframe = input.timeframeSet.join("+")
  const strategyType = input.strategyType || "standard"
  const signalDirection = input.signalDirection || input.direction
  for (const entryTactic of input.entryTactics) {
    const composed = buildCompositeSignals(
      input.candlesByTimeframe,
      input.timeframeSet,
      signalDirection,
      entryTactic,
      input.entryTiming,
      input.activityVolumeRatio,
    )
    if (!composed) continue
    const activeEntry = composed.signals.at(-1) === true
    const activeEntryAt = activeEntry ? composed.candles.at(-1)?.time || null : null
    for (const exitTactic of input.exitTactics) {
      for (const [takeProfitIndex, takeprofit] of input.tpRange.entries()) {
        const requestedRatio = Number(input.takeProfitPositionCostRatios?.[takeProfitIndex])
        const takeProfitPositionCostRatio = Number.isFinite(requestedRatio) && requestedRatio > 0
          ? requestedRatio
          : takeprofit / positionCostPercent
        for (const slRatio of input.slRatios) {
          const stoploss = takeprofit * slRatio
          for (const trail of input.trailOptions) {
            const simulation = simulateTrades(
              composed.candles,
              composed.signals,
              input.direction,
              takeprofit,
              stoploss,
              trail.trailing,
              trail.mode || (trail.trailing ? "fixed" : "none"),
              trail.trailStart,
              trail.trailStop,
              trail.autoTrailSensitivity ?? null,
              exitTactic,
              composed.minutes,
              input.maxHoldMinutes,
              recentPositionWindow,
              positionCostPercent,
            )
            const profitFactorInfinite = simulation.totalLoss === 0 && simulation.totalProfit > 0
            const profitFactor = simulation.totalLoss > 0
              ? simulation.totalProfit / simulation.totalLoss
              : profitFactorInfinite ? null : 0
            const winRate = simulation.totalTrades > 0 ? simulation.wins / simulation.totalTrades : 0
            const avgDdt = simulation.totalTrades > 0 ? simulation.totalDrawdownTimeMin / simulation.totalTrades : 0
            const maxDdt = simulation.maxDrawdownTimeMin
            const totalPnl = simulation.totalPnl
            const bestMarketExitPnl = simulation.bestMarketExitPnl
            const recent = summarizeRecentPositions(simulation)
            const hasSample = simulation.totalTrades >= minTrades
            const pfPasses = profitFactorInfinite || (profitFactor ?? 0) >= input.minProfitFactor
            const recentHasSample = recent.recentPositionCount >= minRecentPositions
            // A no-loss mini-window has an infinite PF but no finite loss
            // denominator. Treat it as *unproven*, not as an automatic pass:
            // this makes the stricter recent gate meaningful and prevents a
            // handful of identical wins from dominating a 90h grid.
            const recentPfPasses = recentHasSample
              && recent.recentProfitFactor != null
              && recent.recentProfitFactor >= minRecentProfitFactor
            const valid = hasSample && recentHasSample && pfPasses && recentPfPasses && winRate >= 0.4 && maxDdt <= input.maxDrawdownTimeMin
            const deactivationReason: DirectTradeSet["deactivationReason"] = !hasSample
              ? "warming"
              : !recentHasSample
                ? "recent_warming"
              : !pfPasses
                ? "pf"
                : !recentPfPasses
                  ? "recent_pf"
                : winRate < 0.4
                  ? "win_rate"
                  : maxDdt > input.maxDrawdownTimeMin
                    ? "ddt"
                    : null
            const scoreBase = profitFactorInfinite ? simulation.totalProfit : (profitFactor ?? 0)
            const score = scoreBase * winRate * (1 + Math.max(0, totalPnl) / 100) / (1 + avgDdt / Math.max(1, input.maxDrawdownTimeMin))
            const base: Omit<DirectTradeSet, "setKey"> = {
              symbol: input.symbol,
              direction: input.direction,
              signalDirection,
              strategyType,
              timeframe,
              timeframeSet: [...input.timeframeSet],
              historyHours: input.historyHours,
              entryTactic,
              exitTactic,
              entryTiming: input.entryTiming,
              activityVolumeRatio: input.activityVolumeRatio,
              takeprofit: round(takeprofit),
              takeProfitPositionCostRatio: round(takeProfitPositionCostRatio),
              stoploss: round(stoploss),
              trailing: trail.trailing,
              trailingMode: trail.mode || (trail.trailing ? "fixed" : "none"),
              trailStart: round(trail.trailStart),
              trailStop: round(trail.trailStop),
              autoTrailSensitivity: trail.mode === "auto" ? round(trail.autoTrailSensitivity ?? 1, 3) : null,
              // A Block line carries one evaluated count. Its execution
              // target remains based on the original Base quantity, never on
              // a preceding block-adjusted quantity.
              blockCount: Math.max(input.blockRange[0], Math.min(input.blockRange[1], Math.round(profitFactor ?? simulation.totalProfit))),
              blockVolumeRatio: input.volumeRatio,
              volumeRatio: input.volumeRatio,
              positionCostPercent,
              valid,
              deactivationReason,
              profitFactor: profitFactor == null ? null : round(profitFactor, 3),
              profitFactorInfinite,
              winRate: round(winRate * 100, 1),
              totalTrades: simulation.totalTrades,
              avgDrawdownTimeMin: round(avgDdt, 1),
              maxDrawdownTimeMin: round(maxDdt, 1),
              score: round(score),
              totalPnl: round(totalPnl),
              bestMarketExitPnl: round(bestMarketExitPnl),
              ...recent,
              bestMarketExitAnalysisOnly: true,
              entrySignalKey: directTradeEntrySignalKey({
                symbol: input.symbol,
                direction: input.direction,
                signalDirection,
                strategyType,
                timeframeSet: input.timeframeSet,
                entryTactic,
                entryTiming: input.entryTiming,
                activityVolumeRatio: input.activityVolumeRatio,
              }),
              activeEntry,
              activeEntryAt,
            }
            result.push({ ...base, setKey: stableSetKey(base) })
          }
        }
      }
    }
  }
  return result
}
