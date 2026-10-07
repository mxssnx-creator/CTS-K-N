/**
 * Prehistoric measurement per indication type.
 *
 * The Base gate judges a Set on the measured results of its
 * (symbol × indication type × direction) bucket until the Set has its own
 * result window. Those buckets used to be filled from one generic replay
 * (momentum entries, TP 1–10 % / SL 0.5–5 %) mirrored into every type, so
 * every type showed the same — and on real data uniformly negative — history.
 *
 * This replay measures each type with what its live Sets do:
 *  - entries: the engine's own DIRECT indication rules (computeDirectIndications,
 *    the code realtime runs), evaluated causally once per minute on the last
 *    90 one-minute closes and the current 1-second candle;
 *  - the Strategy validity floor (PF ≥ MAIN_TRADE_BASE_PF_RATIO_MIN);
 *  - exits: the Sets' protection (injected — the engine passes
 *    deriveProtectionFromProfitFactor, i.e. PositionCost-derived TP and the
 *    operator stop-loss floor), checked on every 1-second close like a pseudo
 *    position, with the pseudo maximum hold time;
 *  - result: net of PositionCost, the same record a pseudo close writes.
 *
 * One open position per (type, direction, rule) at a time, like one pseudo
 * position per Set. Positions still open at the range end are not results.
 * Signal (remote, realtime-only) cannot be replayed and is not measured here.
 */
import { MAIN_TRADE_BASE_PF_RATIO_MIN, movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { ENGINE_STAGE_HISTORY_CANDLES, ENGINE_STAGE_HISTORY_MINUTES } from "@/lib/engine-stage-history"
import {
  computeDirectIndications,
  oneMinuteClosesOldestFirst,
  parseNumericSettingList,
  timestampMs,
} from "./direct-indications"

export interface ReplayCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface ReplayProtection {
  takeProfitPct: number
  stopLossPct: number
}

export type ReplayCloseReason = "take_profit" | "stop_loss" | "max_hold"

export interface TypeReplayClose {
  type: string
  direction: "long" | "short"
  rule: string
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  takeProfitPct: number
  stopLossPct: number
  /** Gross market move in percent, signed for the position side. */
  grossPct: number
  /** Gross move minus PositionCost — what a pseudo close books. */
  netPct: number
  positionCostPct: number
  holdMinutes: number
  reason: ReplayCloseReason
}

export interface TypeReplayInput {
  symbol: string
  /** 1-second candles, any order; the replay sorts them. */
  candles: readonly any[]
  /** First moment an entry may be taken (90 minutes of history must precede it). */
  rangeStartMs: number
  rangeEndMs: number
  positionCostPct: number
  /** IndicationProcessor settings (the shape realtime uses). */
  indicationSettings: any
  /** The Sets' TP/SL for one indication row. */
  protectionFor: (row: { type: string; profitFactor: number; row: any }) => ReplayProtection
  /** Step-based indicator summaries for Auto; omitted = Auto is not measured. */
  stepIndicatorsFor?: (candles: ReplayCandle[], timeframesMinutes: number[]) => Promise<any>
  stepMs?: number
  maxHoldMs?: number
  /** Throws to cancel (superseded prehistoric generation). */
  assertActive?: () => void
}

export interface TypeReplayResult {
  closes: TypeReplayClose[]
  steps: number
  signals: Record<string, number>
  openAtEnd: number
}

interface OpenPosition {
  key: string
  type: string
  direction: "long" | "short"
  rule: string
  entryTime: number
  entryPrice: number
  takeProfitPct: number
  stopLossPct: number
}

const DEFAULT_MAX_HOLD_MS = 4 * 60 * 60 * 1000
const YIELD_EVERY_STEPS = 30

function normalizeCandles(raw: readonly any[]): ReplayCandle[] {
  const out: ReplayCandle[] = []
  for (const candle of raw || []) {
    const timestamp = timestampMs(candle?.timestamp ?? candle?.time ?? candle?.t)
    const close = Number(candle?.close ?? candle?.c ?? candle?.price)
    if (timestamp === null || !(close > 0)) continue
    const open = Number(candle?.open ?? candle?.o)
    const high = Number(candle?.high ?? candle?.h)
    const low = Number(candle?.low ?? candle?.l)
    out.push({
      timestamp,
      open: open > 0 ? open : close,
      high: high > 0 ? high : close,
      low: low > 0 ? low : close,
      close,
      volume: Number(candle?.volume ?? candle?.v) || 0,
    })
  }
  out.sort((left, right) => left.timestamp - right.timestamp)
  return out
}

/** First index whose timestamp is > value (upper bound). */
function upperBound(timestamps: readonly number[], value: number): number {
  let low = 0
  let high = timestamps.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (timestamps[middle] <= value) low = middle + 1
    else high = middle
  }
  return low
}

/** One-minute OHLCV bars from 1-second candles (for the step indicators). */
export function minuteBars(candles: readonly ReplayCandle[]): ReplayCandle[] {
  const bars: ReplayCandle[] = []
  let current: ReplayCandle | null = null
  for (const candle of candles) {
    const minute = Math.floor(candle.timestamp / 60_000) * 60_000
    if (!current || current.timestamp !== minute) {
      current = { timestamp: minute, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume }
      bars.push(current)
      continue
    }
    current.high = Math.max(current.high, candle.high)
    current.low = Math.min(current.low, candle.low)
    current.close = candle.close
    current.volume += candle.volume
  }
  return bars
}

function rowDirection(row: any): "long" | "short" | null {
  const direction = String(row?.metadata?.direction ?? row?.direction ?? "").toLowerCase()
  return direction === "long" || direction === "short" ? direction : null
}

/** The rule a row comes from: one open position per rule, like one per Set. */
function rowRule(row: any): string {
  const metadata = row?.metadata || {}
  if (row?.type === "trend") {
    return metadata.combined ? "combined" : `tf${Number(metadata.timeframeMinutes ?? metadata.timeframe ?? 0) || 0}`
  }
  return String(metadata.mode || "default")
}

function passesStrategyValidity(row: any): boolean {
  if (!row || row.validated === false) return false
  if (row.validated === true) return true
  const pf = Number(row.profitFactor ?? row.profit_factor)
  if (!Number.isFinite(pf) || pf === 0) return true
  return pf >= MAIN_TRADE_BASE_PF_RATIO_MIN
}

export async function replayDirectIndicationTypes(input: TypeReplayInput): Promise<TypeReplayResult> {
  const candles = normalizeCandles(input.candles)
  const timestamps = candles.map((candle) => candle.timestamp)
  const stepMs = Math.max(1_000, Math.floor(Number(input.stepMs) || 60_000))
  const maxHoldMs = Math.max(60_000, Number(input.maxHoldMs) || DEFAULT_MAX_HOLD_MS)
  const positionCostPct = Number(input.positionCostPct) > 0 ? Number(input.positionCostPct) : 0.1
  const result: TypeReplayResult = { closes: [], steps: 0, signals: {}, openAtEnd: 0 }
  if (candles.length === 0) return result

  const settings = input.indicationSettings || {}
  const coordinatedTimeframes = parseNumericSettingList(
    settings.commonCoordination?.timeframesMinutes,
    [1, 5, 15, 30],
  ).map((value) => Math.max(1, Math.round(value)))
  const windowMs = ENGINE_STAGE_HISTORY_CANDLES * 1_000
  const firstEntryMs = Math.max(
    Number(input.rangeStartMs) || timestamps[0],
    timestamps[0] + ENGINE_STAGE_HISTORY_MINUTES * 60_000,
  )
  const lastMs = Math.min(Number(input.rangeEndMs) || timestamps[timestamps.length - 1], timestamps[timestamps.length - 1])
  const open = new Map<string, OpenPosition>()
  let exitCursor = 0

  const settle = (position: OpenPosition, candle: ReplayCandle, reason: ReplayCloseReason) => {
    const side = position.direction === "long" ? 1 : -1
    const grossPct = ((candle.close - position.entryPrice) / position.entryPrice) * 100 * side
    result.closes.push({
      type: position.type,
      direction: position.direction,
      rule: position.rule,
      entryTime: position.entryTime,
      exitTime: candle.timestamp,
      entryPrice: position.entryPrice,
      exitPrice: candle.close,
      takeProfitPct: position.takeProfitPct,
      stopLossPct: position.stopLossPct,
      grossPct,
      netPct: grossPct - positionCostPct,
      positionCostPct,
      holdMinutes: (candle.timestamp - position.entryTime) / 60_000,
      reason,
    })
    open.delete(position.key)
  }

  // Walk every 1-second close up to (and including) `untilMs`: a pseudo
  // position closes on the first close beyond its TP or SL, or at max hold.
  const advanceExits = (untilMs: number) => {
    const end = upperBound(timestamps, untilMs)
    for (; exitCursor < end; exitCursor++) {
      if (open.size === 0) continue
      const candle = candles[exitCursor]
      for (const position of [...open.values()]) {
        if (candle.timestamp <= position.entryTime) continue
        const side = position.direction === "long" ? 1 : -1
        const movePct = ((candle.close - position.entryPrice) / position.entryPrice) * 100 * side
        if (movePct >= position.takeProfitPct) settle(position, candle, "take_profit")
        else if (movePct <= -position.stopLossPct) settle(position, candle, "stop_loss")
        else if (candle.timestamp - position.entryTime >= maxHoldMs) settle(position, candle, "max_hold")
      }
    }
  }

  const firstStep = Math.ceil(firstEntryMs / stepMs) * stepMs
  for (let stepTime = firstStep; stepTime <= lastMs; stepTime += stepMs) {
    if (result.steps > 0 && result.steps % YIELD_EVERY_STEPS === 0) {
      input.assertActive?.()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    advanceExits(stepTime)
    const endIndex = upperBound(timestamps, stepTime)
    if (endIndex === 0) continue
    const startIndex = upperBound(timestamps, stepTime - windowMs)
    const window = candles.slice(startIndex, endIndex)
    const pricesOldestFirst = oneMinuteClosesOldestFirst(window)
    if (pricesOldestFirst.length < ENGINE_STAGE_HISTORY_MINUTES) continue
    const current = window[window.length - 1]
    // The step indicators resample to 1/5/15/30-minute bars; feeding the
    // window's own one-minute bars gives the same bars at 1/60 of the work.
    const stepIndicators = input.stepIndicatorsFor && settings.autoEnabled !== false
      ? await input.stepIndicatorsFor(minuteBars(window), coordinatedTimeframes).catch(() => ({}))
      : {}
    const direct = computeDirectIndications({
      symbol: input.symbol,
      candles: window,
      pricesOldestFirst,
      positionCostPct,
      indicationSettings: settings,
      stepIndicators,
      coordinatedTimeframes,
      current,
      now: current.timestamp,
    })
    result.steps++
    for (const row of [...direct.beforeSignal, ...direct.afterSignal]) {
      if (!passesStrategyValidity(row)) continue
      const direction = rowDirection(row)
      const type = String(row?.type || "")
      if (!direction || !type) continue
      result.signals[type] = (result.signals[type] || 0) + 1
      const rule = rowRule(row)
      const key = `${type}|${direction}|${rule}`
      if (open.has(key)) continue
      const protection = input.protectionFor({ type, profitFactor: Number(row.profitFactor) || 0, row })
      if (!(protection.takeProfitPct > 0) || !(protection.stopLossPct > 0)) continue
      open.set(key, {
        key,
        type,
        direction,
        rule,
        entryTime: current.timestamp,
        entryPrice: current.close,
        takeProfitPct: protection.takeProfitPct,
        stopLossPct: protection.stopLossPct,
      })
    }
  }
  advanceExits(lastMs)
  result.openAtEnd = open.size
  return result
}

export interface TypeReplaySummary {
  closed: number
  wins: number
  losses: number
  netPctSum: number
  /** Mean PositionCost-relative ratio, the coordinate the Base gate compares. */
  positionCostRatio: number | null
}

/** Per type and direction, as the Base gate's buckets see them. */
export function summarizeTypeReplay(closes: readonly TypeReplayClose[]): Record<string, TypeReplaySummary> {
  const out: Record<string, TypeReplaySummary & { ratioSum: number }> = {}
  for (const close of closes) {
    const key = `${close.type}:${close.direction}`
    const entry = out[key] || (out[key] = { closed: 0, wins: 0, losses: 0, netPctSum: 0, positionCostRatio: null, ratioSum: 0 })
    entry.closed++
    if (close.netPct > 0) entry.wins++
    else if (close.netPct < 0) entry.losses++
    entry.netPctSum += close.netPct
    entry.ratioSum += movePctToMainTradePfRatio(close.netPct, close.positionCostPct)
  }
  return Object.fromEntries(Object.entries(out).map(([key, { ratioSum, ...entry }]) => [
    key,
    { ...entry, positionCostRatio: entry.closed > 0 ? ratioSum / entry.closed : null },
  ]))
}
