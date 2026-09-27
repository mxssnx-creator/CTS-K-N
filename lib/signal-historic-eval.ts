import type { SignalCandle } from "@/lib/signal-source-registry"
import { calculateSignalTrailingTick, type TrailingProfile } from "@/lib/signal-trailing"

/**
 * Pure helpers for the historic signal evaluation (scripts/historic-signal-eval.ts).
 *
 * Everything here is side-effect free and causal: a decision at minute `t`
 * only reads candles with timestamp <= t, exits only read bars after entry,
 * and a bar touching both stop and target is booked as a stop.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export type HistoricExitReason = "stop" | "trail" | "target" | "timeout" | "end"

export interface HistoricExit {
  exitIndex: number
  exitPrice: number
  reason: HistoricExitReason
}

/**
 * Causal signal window: the last `limit` present candles ending at `index`
 * inclusive. Missing minutes (null) are skipped, never filled from the future.
 */
export function causalCandleWindow(
  grid: readonly (SignalCandle | null)[],
  index: number,
  limit: number,
): SignalCandle[] {
  const out: SignalCandle[] = []
  for (let i = index; i >= 0 && out.length < limit; i--) {
    const candle = grid[i]
    if (candle) out.push(candle)
    // Do not reach further back than 2x the window to avoid stale data.
    if (index - i > limit * 2) break
  }
  return out.reverse()
}

/**
 * Simulate one position opened at the close of `grid[entryIndex]`.
 * Per bar: the current stop is checked first (ambiguous bars count as stop),
 * then the target; trailing (when a profile is given) ratchets the stop from
 * the bar close only after both checks, so it never benefits from intrabar
 * lookahead. Missing bars are skipped. Unfinished positions exit at the last
 * available close within `maxHoldBars` ("timeout") or the grid end ("end").
 */
export function simulateSignalExit(input: {
  grid: readonly (SignalCandle | null)[]
  entryIndex: number
  direction: "long" | "short"
  stopLossPct: number
  takeProfitPct: number
  maxHoldBars: number
  trailing?: TrailingProfile | null
}): HistoricExit | null {
  const entryCandle = input.grid[input.entryIndex]
  if (!entryCandle || !(entryCandle.close > 0)) return null
  const entry = entryCandle.close
  const long = input.direction === "long"
  let stop = long ? entry * (1 - input.stopLossPct / 100) : entry * (1 + input.stopLossPct / 100)
  const target = long ? entry * (1 + input.takeProfitPct / 100) : entry * (1 - input.takeProfitPct / 100)
  let trailActive = false
  let trailAnchor = 0
  let trailStop = 0
  let trailRange = 0
  let stopIsTrail = false
  let lastIndex = input.entryIndex
  let lastClose = entry
  const last = Math.min(input.grid.length - 1, input.entryIndex + Math.max(1, input.maxHoldBars))
  for (let bar = input.entryIndex + 1; bar <= last; bar++) {
    const candle = input.grid[bar]
    if (!candle) continue
    const hitStop = long ? candle.low <= stop : candle.high >= stop
    const hitTarget = long ? candle.high >= target : candle.low <= target
    if (hitStop) {
      // Gap through the stop fills at the open, never better than the stop.
      const fill = long ? Math.min(stop, candle.open) : Math.max(stop, candle.open)
      return { exitIndex: bar, exitPrice: fill, reason: stopIsTrail ? "trail" : "stop" }
    }
    if (hitTarget) return { exitIndex: bar, exitPrice: target, reason: "target" }
    lastIndex = bar
    lastClose = candle.close
    if (input.trailing) {
      const tick = calculateSignalTrailingTick({
        entryPrice: entry,
        currentPrice: candle.close,
        side: input.direction,
        profile: input.trailing,
        active: trailActive,
        anchor: trailAnchor,
        stopPrice: trailStop,
        stopRangeRatio: trailRange,
      })
      trailActive = tick.active
      trailAnchor = tick.anchor
      trailStop = tick.stopPrice
      trailRange = tick.stopRangeRatio
      if (trailActive && trailStop > 0 && (long ? trailStop > stop : trailStop < stop)) {
        stop = trailStop
        stopIsTrail = true
      }
    }
  }
  if (lastIndex === input.entryIndex) return null
  return {
    exitIndex: lastIndex,
    exitPrice: lastClose,
    reason: last === input.grid.length - 1 && last - input.entryIndex < input.maxHoldBars ? "end" : "timeout",
  }
}

export function grossMovePct(direction: "long" | "short", entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100 * (direction === "long" ? 1 : -1)
}

export interface TradeSummary {
  trades: number
  wins: number
  netPct: number
  grossProfitPct: number
  grossLossPct: number
  profitFactor: number
  maxDrawdownPct: number
  maxLossStreak: number
  winRate: number
  avgNetPct: number
}

/** Summary over after-cost trade results in chronological order. PF 999 = no losses. */
export function summarizeNetResults(netPcts: readonly number[]): TradeSummary {
  let equity = 0
  let peak = 0
  let maxDd = 0
  let gp = 0
  let gl = 0
  let wins = 0
  let streak = 0
  let maxStreak = 0
  for (const value of netPcts) {
    equity += value
    peak = Math.max(peak, equity)
    maxDd = Math.max(maxDd, peak - equity)
    if (value > 0) {
      wins++
      gp += value
      streak = 0
    } else {
      gl -= Math.min(0, value)
      streak++
      maxStreak = Math.max(maxStreak, streak)
    }
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6
  return {
    trades: netPcts.length,
    wins,
    netPct: r(equity),
    grossProfitPct: r(gp),
    grossLossPct: r(gl),
    profitFactor: r(gl > 0 ? gp / gl : gp > 0 ? 999 : 0),
    maxDrawdownPct: r(maxDd),
    maxLossStreak: maxStreak,
    winRate: netPcts.length ? r(wins / netPcts.length) : 0,
    avgNetPct: netPcts.length ? r(equity / netPcts.length) : 0,
  }
}

export interface HourBucket {
  hourStart: number
  trades: number
  netPct: number
}

/**
 * Realized P&L per UTC clock hour (by exit time) for every hour in
 * [startMs, endMs), including hours without trades (netPct 0).
 */
export function aggregateHourly(
  trades: readonly { exitTs: number; netPct: number }[],
  startMs: number,
  endMs: number,
): HourBucket[] {
  const first = Math.floor(startMs / HOUR_MS)
  const count = Math.max(0, Math.ceil(endMs / HOUR_MS) - first)
  const buckets: HourBucket[] = Array.from({ length: count }, (_, i) => ({
    hourStart: (first + i) * HOUR_MS,
    trades: 0,
    netPct: 0,
  }))
  for (const trade of trades) {
    if (trade.exitTs < startMs || trade.exitTs >= endMs) continue
    const bucket = buckets[Math.floor(trade.exitTs / HOUR_MS) - first]
    if (!bucket) continue
    bucket.trades++
    bucket.netPct += trade.netPct
  }
  for (const bucket of buckets) bucket.netPct = Math.round(bucket.netPct * 1e6) / 1e6
  return buckets
}

export interface HourSummary {
  hours: number
  activeHours: number
  positiveHours: number
  negativeHours: number
  /** positive / active hours (hours with at least one closed trade). */
  positiveShareOfActive: number
  /** hours that did not lose (flat or positive) / all hours. */
  nonNegativeShareOfAll: number
  worstHourPct: number
  bestHourPct: number
}

export function summarizeHours(buckets: readonly HourBucket[]): HourSummary {
  const active = buckets.filter((b) => b.trades > 0)
  const positive = active.filter((b) => b.netPct > 0).length
  const negative = active.filter((b) => b.netPct < 0).length
  const r = (v: number) => Math.round(v * 1e4) / 1e4
  return {
    hours: buckets.length,
    activeHours: active.length,
    positiveHours: positive,
    negativeHours: negative,
    positiveShareOfActive: active.length ? r(positive / active.length) : 0,
    nonNegativeShareOfAll: buckets.length ? r((buckets.length - negative) / buckets.length) : 0,
    worstHourPct: active.length ? Math.min(...active.map((b) => b.netPct)) : 0,
    bestHourPct: active.length ? Math.max(...active.map((b) => b.netPct)) : 0,
  }
}

export interface WalkForwardWindow {
  startMs: number
  endMs: number
}

/**
 * Split `days` complete UTC days ending at `endMs` (a UTC midnight) into a
 * selection window (first `trainDays`) and an evaluation window (the rest).
 */
export function walkForwardSplit(endMs: number, days: number, trainDays: number): {
  all: WalkForwardWindow
  train: WalkForwardWindow
  test: WalkForwardWindow
} {
  if (endMs % DAY_MS !== 0) throw new Error("endMs must be a UTC midnight")
  if (!(days > 1) || !(trainDays >= 1) || trainDays >= days) throw new Error("invalid walk-forward split")
  const startMs = endMs - days * DAY_MS
  const splitMs = startMs + trainDays * DAY_MS
  return {
    all: { startMs, endMs },
    train: { startMs, endMs: splitMs },
    test: { startMs: splitMs, endMs },
  }
}

/** Most recent UTC midnight at or before `now` (the end of the last complete day). */
export function lastCompleteUtcDayEnd(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

export interface HourlyStopRule {
  /** Stop opening new positions in an hour once its realized net reaches this (percent). */
  profitTargetPct?: number
  /** Stop opening new positions in an hour once its realized net falls to -this (percent). */
  lossLimitPct?: number
  /** UTC hours-of-day in which no position is opened. */
  blockedHoursUtc?: readonly number[]
}

export interface RuleTrade {
  entryTs: number
  exitTs: number
  netPct: number
}

/**
 * Causal hour-level stop rule. Trades are considered in entry order; a trade
 * is skipped when, at its entry time, the realized net of already-taken
 * trades that closed in the same clock hour (exitTs <= entryTs) has reached
 * the profit target or the loss limit, or its hour-of-day is blocked.
 * Only information available at entry time is used.
 */
export function applyHourlyStopRule<T extends RuleTrade>(trades: readonly T[], rule: HourlyStopRule): T[] {
  const ordered = trades.slice().sort((a, b) => a.entryTs - b.entryTs || a.exitTs - b.exitTs)
  const blocked = new Set(rule.blockedHoursUtc || [])
  const kept: T[] = []
  for (const trade of ordered) {
    const hour = Math.floor(trade.entryTs / HOUR_MS)
    if (blocked.has(new Date(trade.entryTs).getUTCHours())) continue
    let realized = 0
    for (let i = kept.length - 1; i >= 0; i--) {
      const prior = kept[i]
      if (Math.floor(prior.entryTs / HOUR_MS) < hour - 24) break
      if (prior.exitTs <= trade.entryTs && Math.floor(prior.exitTs / HOUR_MS) === hour) realized += prior.netPct
    }
    if (rule.profitTargetPct !== undefined && realized >= rule.profitTargetPct) continue
    if (rule.lossLimitPct !== undefined && realized <= -rule.lossLimitPct) continue
    kept.push(trade)
  }
  return kept
}

/** UTC hours-of-day whose realized net is negative with at least `minTrades` trades. */
export function negativeHoursOfDayFromTrades(
  trades: readonly { exitTs: number; netPct: number }[],
  minTrades: number,
): number[] {
  const net = new Array<number>(24).fill(0)
  const count = new Array<number>(24).fill(0)
  for (const trade of trades) {
    const h = new Date(trade.exitTs).getUTCHours()
    net[h] += trade.netPct
    count[h]++
  }
  return net.map((v, h) => (count[h] >= minTrades && v < 0 ? h : -1)).filter((h) => h >= 0)
}
