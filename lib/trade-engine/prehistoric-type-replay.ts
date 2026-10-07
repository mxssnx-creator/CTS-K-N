/**
 * Prehistoric measurement per indication type.
 *
 * The Base gate judges a Set on the measured results of its
 * (symbol × indication type × direction) bucket until the Set has its own
 * result window. Those buckets used to be filled from one generic replay
 * (momentum entries, TP 1–10 % / SL 0.5–5 %) mirrored into every type, so
 * every type showed the same — and on real data uniformly negative — history.
 *
 * This replay measures each type with what its live Sets do. The venue keeps
 * no old seconds, so a prehistoric range is measured on its real one-minute
 * bars (seconds interpolated from them carry neither the wicks nor the path
 * inside a minute):
 *  - entries: the engine's own DIRECT indication rules (computeDirectIndications,
 *    the code realtime runs), evaluated once per completed minute on the last
 *    90 one-minute closes with that minute's bar as the current candle — only
 *    data known when the minute has closed — entering at its close;
 *  - the Strategy validity floor (PF ≥ MAIN_TRADE_BASE_PF_RATIO_MIN);
 *  - exits: the Sets' protection (injected — the engine passes
 *    deriveProtectionFromProfitFactor, i.e. PositionCost-derived TP and the
 *    operator stop-loss floor) against every later bar's real high and low.
 *    A bar reaching both levels counts as a stop (the order inside a minute
 *    is unknown), a bar opening beyond a level exits at its open, and the
 *    pseudo maximum hold closes at a bar's close;
 *  - result: net of PositionCost, the same record a pseudo close writes.
 *
 * One open position per (type, direction, rule) at a time, like one pseudo
 * position per Set. Positions still open at the range end are not results
 * yet: they are returned with the last processed bar, and a later call that
 * passes them back (`initialOpen`, `resumeAfterMs`) continues exactly where
 * this one stopped, as one continuous replay would. Only complete bars are
 * processed. Signal (remote, realtime-only) cannot be replayed and is not
 * measured here.
 */
import { MAIN_TRADE_BASE_PF_RATIO_MIN, movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { ENGINE_STAGE_HISTORY_MINUTES } from "@/lib/engine-stage-history"
import {
  commonMultiRangeCoordinationFor,
  computeDirectIndications,
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
  /** Real one-minute bars, any order; the replay aligns, de-duplicates and sorts them. */
  bars: readonly any[]
  /** Earliest close an entry may be taken at (90 bars of history must precede it). */
  rangeStartMs: number
  rangeEndMs: number
  positionCostPct: number
  /** IndicationProcessor settings (the shape realtime uses). */
  indicationSettings: any
  /** The Sets' TP/SL for one indication row. */
  protectionFor: (row: { type: string; profitFactor: number; row: any }) => ReplayProtection
  /** Step-based indicator summaries for Auto; omitted = Auto is not measured. */
  stepIndicatorsFor?: (bars: ReplayCandle[], timeframesMinutes: number[]) => Promise<any>
  maxHoldMs?: number
  /** Positions a previous call left open; they continue with the bars after `resumeAfterMs`. */
  initialOpen?: readonly TypeReplayOpenPosition[]
  /** The last bar a previous call processed: bars up to it only provide history. */
  resumeAfterMs?: number
  /** Throws to cancel (superseded prehistoric generation). */
  assertActive?: () => void
}

export interface TypeReplayResult {
  closes: TypeReplayClose[]
  steps: number
  /** Steps at which Auto could fire and the step indicators were computed. */
  stepIndicatorCalls: number
  signals: Record<string, number>
  openAtEnd: number
  /** Positions still open after the last processed bar (the state to resume from). */
  open: TypeReplayOpenPosition[]
  /** Timestamp of the last processed bar; null when none was processed. */
  lastBarMs: number | null
}

export interface TypeReplayOpenPosition {
  key: string
  type: string
  direction: "long" | "short"
  rule: string
  entryTime: number
  entryPrice: number
  takeProfitPct: number
  stopLossPct: number
}

/** A stored open position that can safely be resumed, or null. */
export function normalizeOpenPosition(value: any): TypeReplayOpenPosition | null {
  const direction = value?.direction === "long" || value?.direction === "short" ? value.direction : null
  const type = String(value?.type || "")
  const rule = String(value?.rule || "")
  const numbers = [value?.entryTime, value?.entryPrice, value?.takeProfitPct, value?.stopLossPct].map(Number)
  if (!direction || !type || !rule || !numbers.every((entry) => Number.isFinite(entry) && entry > 0)) return null
  const [entryTime, entryPrice, takeProfitPct, stopLossPct] = numbers
  return { key: `${type}|${direction}|${rule}`, type, direction, rule, entryTime, entryPrice, takeProfitPct, stopLossPct }
}

const MINUTE_MS = 60_000
const DEFAULT_MAX_HOLD_MS = 4 * 60 * 60 * 1000
const YIELD_EVERY_STEPS = 30

/** Valid bars, aligned to their minute, oldest first; a repeated minute keeps its last bar. */
function normalizeBars(raw: readonly any[]): ReplayCandle[] {
  const byMinute = new Map<number, ReplayCandle>()
  for (const bar of raw || []) {
    const timestamp = timestampMs(bar?.timestamp ?? bar?.time ?? bar?.t)
    const close = Number(bar?.close ?? bar?.c ?? bar?.price)
    if (timestamp === null || !(close > 0)) continue
    const open = Number(bar?.open ?? bar?.o) > 0 ? Number(bar?.open ?? bar?.o) : close
    const high = Number(bar?.high ?? bar?.h) > 0 ? Number(bar?.high ?? bar?.h) : close
    const low = Number(bar?.low ?? bar?.l) > 0 ? Number(bar?.low ?? bar?.l) : close
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
    byMinute.set(minute, {
      timestamp: minute,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Number(bar?.volume ?? bar?.v) || 0,
    })
  }
  return [...byMinute.values()].sort((left, right) => left.timestamp - right.timestamp)
}

/** One-minute OHLCV bars from finer candles (the fallback when no venue bars exist). */
export function minuteBars(candles: readonly ReplayCandle[]): ReplayCandle[] {
  const bars: ReplayCandle[] = []
  let current: ReplayCandle | null = null
  for (const candle of candles) {
    const minute = Math.floor(candle.timestamp / MINUTE_MS) * MINUTE_MS
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
  const bars = normalizeBars(input.bars)
  const maxHoldMs = Math.max(MINUTE_MS, Number(input.maxHoldMs) || DEFAULT_MAX_HOLD_MS)
  const positionCostPct = Number(input.positionCostPct) > 0 ? Number(input.positionCostPct) : 0.1
  const open = new Map<string, TypeReplayOpenPosition>()
  for (const raw of input.initialOpen || []) {
    const position = normalizeOpenPosition(raw)
    if (position) open.set(position.key, position)
  }
  const result: TypeReplayResult = {
    closes: [], steps: 0, stepIndicatorCalls: 0, signals: {}, openAtEnd: 0, open: [], lastBarMs: null,
  }
  const finish = (): TypeReplayResult => {
    result.open = [...open.values()]
    result.openAtEnd = result.open.length
    return result
  }
  if (bars.length === 0) return finish()

  const settings = input.indicationSettings || {}
  const coordinatedTimeframes = parseNumericSettingList(
    settings.commonCoordination?.timeframesMinutes,
    [1, 5, 15, 30],
  ).map((value) => Math.max(1, Math.round(value)))
  const rangeStartMs = Number(input.rangeStartMs) || bars[0].timestamp
  const rangeEndMs = Number(input.rangeEndMs) || bars[bars.length - 1].timestamp + MINUTE_MS
  const resumeAfterMs = Number(input.resumeAfterMs) || Number.NEGATIVE_INFINITY

  const settle = (position: TypeReplayOpenPosition, exitTime: number, exitPrice: number, reason: ReplayCloseReason) => {
    const side = position.direction === "long" ? 1 : -1
    const grossPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100 * side
    result.closes.push({
      type: position.type,
      direction: position.direction,
      rule: position.rule,
      entryTime: position.entryTime,
      exitTime,
      entryPrice: position.entryPrice,
      exitPrice,
      takeProfitPct: position.takeProfitPct,
      stopLossPct: position.stopLossPct,
      grossPct,
      netPct: grossPct - positionCostPct,
      positionCostPct,
      holdMinutes: (exitTime - position.entryTime) / MINUTE_MS,
      reason,
    })
    open.delete(position.key)
  }

  // A bar's real range decides the exits of every position opened before it.
  const settleExits = (bar: ReplayCandle) => {
    const barEnd = bar.timestamp + MINUTE_MS
    for (const position of [...open.values()]) {
      if (bar.timestamp < position.entryTime) continue
      const long = position.direction === "long"
      const stopPrice = position.entryPrice * (1 + (long ? -1 : 1) * position.stopLossPct / 100)
      const targetPrice = position.entryPrice * (1 + (long ? 1 : -1) * position.takeProfitPct / 100)
      if (long ? bar.open <= stopPrice : bar.open >= stopPrice) settle(position, bar.timestamp, bar.open, "stop_loss")
      else if (long ? bar.open >= targetPrice : bar.open <= targetPrice) settle(position, bar.timestamp, bar.open, "take_profit")
      else if (long ? bar.low <= stopPrice : bar.high >= stopPrice) settle(position, barEnd, stopPrice, "stop_loss")
      else if (long ? bar.high >= targetPrice : bar.low <= targetPrice) settle(position, barEnd, targetPrice, "take_profit")
      else if (barEnd - position.entryTime >= maxHoldMs) settle(position, barEnd, bar.close, "max_hold")
    }
  }

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]
    const closedAt = bar.timestamp + MINUTE_MS
    // History only (already processed by a previous call), or not complete yet.
    if (bar.timestamp <= resumeAfterMs) continue
    if (closedAt > rangeEndMs) break
    settleExits(bar)
    result.lastBarMs = bar.timestamp
    if (index + 1 < ENGINE_STAGE_HISTORY_MINUTES || closedAt < rangeStartMs) continue
    // The stage contract: the 90 one-minute closes before the decision, complete.
    const history = bars.slice(index + 1 - ENGINE_STAGE_HISTORY_MINUTES, index + 1)
    if (bar.timestamp - history[0].timestamp !== (ENGINE_STAGE_HISTORY_MINUTES - 1) * MINUTE_MS) continue
    if (result.steps > 0 && result.steps % YIELD_EVERY_STEPS === 0) {
      input.assertActive?.()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const pricesOldestFirst = history.map((entry) => entry.close)
    // Auto is the only consumer of the step indicators and can only fire
    // when the Common coordination passes, so the costly summaries are
    // computed only then.
    const autoPossible = Boolean(input.stepIndicatorsFor) &&
      settings.autoEnabled !== false &&
      commonMultiRangeCoordinationFor(pricesOldestFirst, positionCostPct, settings).passed
    if (autoPossible) result.stepIndicatorCalls++
    const stepIndicators = autoPossible
      ? await input.stepIndicatorsFor!(history, coordinatedTimeframes).catch(() => ({}))
      : {}
    const direct = computeDirectIndications({
      symbol: input.symbol,
      candles: history,
      pricesOldestFirst,
      positionCostPct,
      indicationSettings: settings,
      stepIndicators,
      coordinatedTimeframes,
      current: bar,
      now: closedAt,
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
        entryTime: closedAt,
        entryPrice: bar.close,
        takeProfitPct: protection.takeProfitPct,
        stopLossPct: protection.stopLossPct,
      })
    }
  }
  return finish()
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
