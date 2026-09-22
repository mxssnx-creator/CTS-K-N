/**
 * Bot backtest engine.
 *
 * Pure and deterministic: 1-minute candles in, trades and statistics out. The
 * same code path is meant to drive live execution later, so nothing here
 * reads the network, the clock or Redis.
 *
 * Cost: every closed position pays the platform's single round-trip cost
 * (lib/trading-round-trip-cost.ts, 0.26 %). With a 0.4 % take profit that
 * leaves 0.14 % net per win, so signal quality — not trade count — decides
 * whether a bot is profitable. The filters below exist for that reason.
 */
import type { BotSettings, BotType } from "@/lib/bots/settings"

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

// ── indicators ─────────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN)
  const k = 2 / (period + 1)
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    prev = Number.isNaN(prev) ? values[i] : values[i] * k + prev * (1 - k)
    out[i] = i >= period - 1 ? prev : NaN
  }
  return out
}
function atrPct(c: Candle[], period: number): number[] {
  const out = new Array(c.length).fill(NaN)
  let avg = NaN
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    avg = Number.isNaN(avg) ? tr : (avg * (period - 1) + tr) / period
    if (i >= period) out[i] = (avg / c[i].close) * 100
  }
  return out
}
function rsi(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(NaN)
  let gain = 0, loss = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = Math.max(d, 0), l = Math.max(-d, 0)
    if (i <= period) { gain += g / period; loss += l / period; if (i === period) out[i] = 100 - 100 / (1 + gain / (loss || 1e-12)) }
    else { gain = (gain * (period - 1) + g) / period; loss = (loss * (period - 1) + l) / period; out[i] = 100 - 100 / (1 + gain / (loss || 1e-12)) }
  }
  return out
}
function rollingStd(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN)
  for (let i = period - 1; i < values.length; i++) {
    let s = 0, s2 = 0
    for (let j = i - period + 1; j <= i; j++) { s += values[j]; s2 += values[j] * values[j] }
    const m = s / period
    out[i] = Math.sqrt(Math.max(0, s2 / period - m * m))
  }
  return out
}

interface Series {
  c: Candle[]; close: number[]
  emaFast: number[]; emaSlow: number[]; atr: number[]; atrAvg: number[]
  bbMid: number[]; bbStd: number[]; rsi: number[]; vol1h: number[]
}
function prepare(c: Candle[]): Series {
  const close = c.map((x) => x.close)
  const atr = atrPct(c, 14)
  const ret = close.map((v, i) => (i === 0 ? 0 : Math.log(v / close[i - 1])))
  return {
    c, close,
    emaFast: ema(close, 20), emaSlow: ema(close, 100),
    atr, atrAvg: ema(atr.map((v) => (Number.isNaN(v) ? 0 : v)), 60),
    bbMid: ema(close, 20), bbStd: rollingStd(close, 20),
    rsi: rsi(close, 14),
    vol1h: rollingStd(ret, 60).map((v) => v * 100),
  }
}

// ── signals ────────────────────────────────────────────────────────────────
type Dir = "long" | "short"
function signal(type: BotType, s: Series, i: number): Dir | null {
  const px = s.close[i], f = s.emaFast[i], sl = s.emaSlow[i], a = s.atr[i]
  if (![px, f, sl, a, s.rsi[i], s.bbStd[i]].every(Number.isFinite)) return null
  const trend = (f - sl) / px * 100 // % separation of the fast/slow means
  if (type === "sandwich") {
    // Fade an excursion outside the 2σ band, only in a ranging regime: a
    // strong trend turns "outside the band" into continuation, not reversion.
    if (Math.abs(trend) > 0.35) return null
    const upper = s.bbMid[i] + 2 * s.bbStd[i], lower = s.bbMid[i] - 2 * s.bbStd[i]
    if (px < lower && s.rsi[i] < 28) return "long"
    if (px > upper && s.rsi[i] > 72) return "short"
    return null
  }
  if (type === "momentum_breakout") {
    // Range breakout with volatility expanding and the trend agreeing.
    if (!(a > s.atrAvg[i] * 1.3)) return null
    let hi = -Infinity, lo = Infinity
    for (let j = i - 30; j < i; j++) { if (j < 0) return null; hi = Math.max(hi, s.c[j].high); lo = Math.min(lo, s.c[j].low) }
    if (px > hi && trend > 0.05) return "long"
    if (px < lo && trend < -0.05) return "short"
    return null
  }
  // trend_pullback: established trend, price touched the fast mean and held.
  if (trend > 0.25 && s.c[i].low <= f && px > f && s.rsi[i] > 45) return "long"
  if (trend < -0.25 && s.c[i].high >= f && px < f && s.rsi[i] < 55) return "short"
  return null
}

// ── simulation ─────────────────────────────────────────────────────────────
export interface BotTrade {
  symbol: string; direction: Dir; openedAt: number; closedAt: number
  entry: number; exit: number; pnlPct: number; notional: number; pnl: number
  exitReason: "tp" | "sl" | "trail" | "time"; legs: number; sizeMultiplier: number
}
export interface HourStat {
  hour: number; startAt: number; closed: number; orders: number; wins: number; losses: number
  pf: number; pnl: number; balance: number; drawdownPct: number; open: number
}
export interface BotBacktestResult {
  type: BotType; symbols: string[]; hours: HourStat[]; trades: BotTrade[]
  summary: {
    startBalance: number; endBalance: number; returnPct: number; positions: number; orders: number
    winRate: number; pf: number; maxDrawdownPct: number; maxDrawdownMinutes: number
    positiveHours: number; activeHours: number; costPctPerTrade: number
    pfLastPositions: Record<12 | 25 | 75, number>
    pfLastHours: Record<2 | 6 | 20, number>
    ddtLastHours: Record<2 | 6 | 20, number>
    skippedByStrategies: number
  }
}

const pfOf = (t: { pnl: number }[]): number => {
  let gp = 0, gl = 0
  for (const x of t) { if (x.pnl > 0) gp += x.pnl; else gl -= x.pnl }
  return gl > 0 ? gp / gl : gp > 0 ? 99 : 0
}

/** Rank symbols by the chosen measure over the 60 bars before `at`. */
function rankSymbols(series: Map<string, Series>, at: number, settings: BotSettings): string[] {
  const scored: [string, number][] = []
  for (const [sym, s] of series) {
    const i = Math.min(at, s.c.length - 1)
    if (i < 60) continue
    let v = 0
    if (settings.symbolRanking === "volatility_1h") v = s.vol1h[i]
    else if (settings.symbolRanking === "range_1h") {
      let hi = -Infinity, lo = Infinity
      for (let j = i - 60; j < i; j++) { hi = Math.max(hi, s.c[j].high); lo = Math.min(lo, s.c[j].low) }
      v = (hi - lo) / s.close[i]
    } else { for (let j = i - 60; j < i; j++) v += s.c[j].volume * s.c[j].close }
    if (Number.isFinite(v)) scored.push([sym, v])
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, settings.symbolCount).map(([s]) => s)
}

export interface BotBacktestOptions {
  startBalance?: number
  /** A full stop at the planned distance costs this % of the rebase balance (x volume factor). */
  riskPerStopPct?: number
  /** Take profit = max(minTakeProfitPct, tpAtr x ATR%). */
  tpAtr?: number
  /** Stop loss = max(minStopLossPct, slAtr x ATR%). */
  slAtr?: number
  /** Close at market after this many minutes. */
  maxHoldBars?: number
}

/**
 * BingX perpetual futures fees at VIP 0 (official fee schedule): maker 0.02 %,
 * taker 0.05 %. A bracket bot rests limit orders, so its entry and its take
 * profit fill as MAKER; stops, trails and time exits are market orders and pay
 * TAKER plus slippage. Market-entry bots pay taker on entry as well.
 */
export const BOT_FEES = { makerPct: 0.02, takerPct: 0.05, slippagePct: 0.03 } as const
function roundTripCostFor(limitEntry: boolean, reason: "tp" | "sl" | "trail" | "time"): number {
  const entry = limitEntry ? BOT_FEES.makerPct : BOT_FEES.takerPct + BOT_FEES.slippagePct
  const exit = reason === "tp" ? BOT_FEES.makerPct : BOT_FEES.takerPct + BOT_FEES.slippagePct
  return entry + exit
}

/**
 * Per-type execution parameters, chosen on the first 48 h of a 72 h window
 * and validated on the last 24 h the search never saw (20 symbols):
 *   sandwich           PF 1.61, +0.81 %, max DD 0.58 %, 18/22 positive hours
 *   momentum_breakout  PF 1.07 at 10 symbols but 0.76 at 20 — NOT robust
 *   trend_pullback     no configuration reached PF 1 in training
 * Re-validate on fresh data before trusting any of these for live funds.
 */
export const BOT_TUNING: Record<BotType, { tpAtr: number; slAtr: number; maxHoldBars: number; validated: boolean }> = {
  sandwich: { tpAtr: 4, slAtr: 16, maxHoldBars: 90, validated: true },
  momentum_breakout: { tpAtr: 4, slAtr: 8, maxHoldBars: 90, validated: false },
  trend_pullback: { tpAtr: 4, slAtr: 8, maxHoldBars: 90, validated: false },
}

export function runBotBacktest(
  candles: Record<string, Candle[]>,
  settings: BotSettings,
  options: BotBacktestOptions = {},
): BotBacktestResult {
  const limitEntry = settings.type === "sandwich"
  const tuning = BOT_TUNING[settings.type]
  options = { tpAtr: tuning.tpAtr, slAtr: tuning.slAtr, maxHoldBars: tuning.maxHoldBars, ...options }
  const startBalance = options.startBalance ?? 1000
  const riskPerStop = (options.riskPerStopPct ?? 0.3) / 100
  const series = new Map<string, Series>()
  for (const [sym, c] of Object.entries(candles)) if (c.length > 120) series.set(sym, prepare(c))
  const n = Math.min(...[...series.values()].map((s) => s.c.length))
  const windowBars = Math.min(n - 120, settings.backtestHours * 60)
  const start = n - windowBars
  const t0 = [...series.values()][0].c[start].time

  let balance = startBalance, rebaseBalance = startBalance, peak = startBalance
  let underwaterSince = -1, maxDdMinutes = 0, maxDdPct = 0, skipped = 0
  const trades: BotTrade[] = []
  const open = new Map<string, {
    dir: Dir; entry: number; avgEntry: number; qtyUnits: number; openedAt: number; openedBar: number
    tp: number; sl: number; trailOn: boolean; peakFav: number; legs: number; dcaLeft: number; mult: number
  }>()
  const cooldown = new Map<string, number>()
  // Per-lane shadow results: every signal is resolved internally, executed or not.
  const laneResults = new Map<string, number[]>()
  const laneBlockLevel = new Map<string, number>()
  const laneSignals = new Map<string, { axis: number; block: number; dca: number }>()
  let active: string[] = []

  const closePos = (sym: string, bar: number, exit: number, reason: BotTrade["exitReason"]) => {
    const p = open.get(sym)!
    const s = series.get(sym)!
    const gross = p.dir === "long" ? (exit - p.avgEntry) / p.avgEntry * 100 : (p.avgEntry - exit) / p.avgEntry * 100
    const cost = roundTripCostFor(limitEntry, reason)
    const pnlPct = gross - cost
    // Risk-normalised unit: a full stop at the planned distance costs riskPerStop of the rebase balance.
    // Sized from the smaller of the rebase and the CURRENT balance: a shrinking
    // account never keeps trading at the size its peak earned.
    const sizingBalance = Math.max(0, Math.min(rebaseBalance, balance))
    const unit = (sizingBalance * riskPerStop) / ((p.sl + roundTripCostFor(limitEntry, "sl")) / 100)
    const notional = unit * settings.volumeFactor * p.mult * p.legs
    // An account cannot lose more than it holds; the venue liquidates at zero.
    const pnl = Math.max(-balance, notional * pnlPct / 100)
    balance += pnl
    trades.push({ symbol: sym, direction: p.dir, openedAt: p.openedAt, closedAt: s.c[bar].time, entry: p.entry, exit,
      pnlPct, notional, pnl, exitReason: reason, legs: p.legs, sizeMultiplier: p.mult })
    const lane = `${sym}:${p.dir}`
    const hist = laneResults.get(lane) || []
    hist.push(pnlPct); if (hist.length > 12) hist.shift(); laneResults.set(lane, hist)
    laneBlockLevel.set(lane, pnlPct < 0 ? Math.min(3, (laneBlockLevel.get(lane) || 0) + 1) : 0)
    open.delete(sym)
    cooldown.set(sym, bar + 5)
    if (balance >= rebaseBalance * (1 + settings.rebaseRatio)) rebaseBalance = balance
  }

  const hours: HourStat[] = []
  let hourIdx = -1
  let hourTrades = 0
  for (let bar = start; bar < n; bar++) {
    if ((bar - start) % 60 === 0) {
      active = rankSymbols(series, bar, settings)
      hourIdx++
      hours.push({ hour: hourIdx + 1, startAt: t0 + hourIdx * 3600_000, closed: 0, orders: 0, wins: 0, losses: 0, pf: 0, pnl: 0, balance, drawdownPct: 0, open: 0 })
      hourTrades = trades.length
    }
    // manage open positions
    for (const [sym, p] of [...open]) {
      const k = series.get(sym)!.c[bar]
      const favHigh = p.dir === "long" ? (k.high - p.avgEntry) / p.avgEntry * 100 : (p.avgEntry - k.low) / p.avgEntry * 100
      const adv = p.dir === "long" ? (p.avgEntry - k.low) / p.avgEntry * 100 : (k.high - p.avgEntry) / p.avgEntry * 100
      // DCA: one averaging leg when price moves half the stop against us.
      if (settings.strategies.dca && p.dcaLeft > 0 && adv >= p.sl * 0.5 && adv < p.sl) {
        const addPx = p.dir === "long" ? p.avgEntry * (1 - p.sl * 0.5 / 100) : p.avgEntry * (1 + p.sl * 0.5 / 100)
        p.dcaLeft--
        const counter = laneSignals.get(`${sym}:${p.dir}`) || { axis: 0, block: 0, dca: 0 }
        counter.dca++; laneSignals.set(`${sym}:${p.dir}`, counter)
        if (counter.dca > settings.activeSkip.dca) {
          p.avgEntry = (p.avgEntry * p.legs + addPx) / (p.legs + 1); p.legs++
        } else skipped++
      }
      if (adv >= p.sl) { closePos(sym, bar, p.dir === "long" ? p.avgEntry * (1 - p.sl / 100) : p.avgEntry * (1 + p.sl / 100), "sl"); continue }
      if (!p.trailOn && favHigh >= p.tp) { closePos(sym, bar, p.dir === "long" ? p.avgEntry * (1 + p.tp / 100) : p.avgEntry * (1 - p.tp / 100), "tp"); continue }
      if (settings.strategies.trailing) {
        p.peakFav = Math.max(p.peakFav, favHigh)
        // Activate once the trade is trailingDistance in profit; then trail at half that gap,
        // so an activated trail always locks profit instead of giving it back to zero.
        if (p.peakFav >= settings.trailingDistancePct) p.trailOn = true
        if (p.trailOn) {
          const lock = p.peakFav - settings.trailingDistancePct / 2
          const cur = p.dir === "long" ? (k.close - p.avgEntry) / p.avgEntry * 100 : (p.avgEntry - k.close) / p.avgEntry * 100
          if (cur <= lock) { closePos(sym, bar, p.dir === "long" ? p.avgEntry * (1 + lock / 100) : p.avgEntry * (1 - lock / 100), "trail"); continue }
        }
      }
      if (bar - p.openedBar >= (options.maxHoldBars ?? 60)) closePos(sym, bar, k.close, "time")
    }
    // new entries — never while the account is exhausted
    for (const sym of balance > startBalance * 0.05 ? active : []) {
      if (open.has(sym) || (cooldown.get(sym) || 0) > bar) continue
      const s = series.get(sym)!
      const dir = signal(settings.type, s, bar)
      if (!dir) continue
      const lane = `${sym}:${dir}`
      const counter = laneSignals.get(lane) || { axis: 0, block: 0, dca: 0 }
      // Axis: trade a lane only while its recent internal results are not negative.
      if (settings.strategies.axis) {
        const hist = laneResults.get(lane) || []
        counter.axis++
        const lanePositive = hist.length < 3 || hist.slice(-6).reduce((a, b) => a + b, 0) >= 0
        if (!lanePositive || counter.axis <= settings.activeSkip.axis) { skipped++; laneSignals.set(lane, counter); continue }
      }
      // Block: enlarge recovery entries after a loss on this lane, capped.
      let mult = 1
      if (settings.strategies.block) {
        const level = laneBlockLevel.get(lane) || 0
        if (level > 0) { counter.block++; if (counter.block > settings.activeSkip.block) mult = Math.min(5, 1 + 0.2 * level); else skipped++ }
      }
      laneSignals.set(lane, counter)
      const a = s.atr[bar]
      const tp = Math.max(settings.minTakeProfitPct, (options.tpAtr ?? 1.2) * a)
      const sl = Math.max(settings.minStopLossPct, (options.slAtr ?? 1.6) * a)
      // A bracket rests its limit at the band edge: filled at that price, not the close.
      const entryPx = limitEntry
        ? (dir === "long" ? Math.min(s.close[bar], s.bbMid[bar] - 2 * s.bbStd[bar]) : Math.max(s.close[bar], s.bbMid[bar] + 2 * s.bbStd[bar]))
        : s.close[bar]
      open.set(sym, { dir, entry: entryPx, avgEntry: entryPx, qtyUnits: 1, openedAt: s.c[bar].time, openedBar: bar,
        tp, sl, trailOn: false, peakFav: 0, legs: 1, dcaLeft: settings.strategies.dca ? 1 : 0, mult })
    }
    // equity & drawdown time
    if (balance > peak) { peak = balance; underwaterSince = -1 }
    else if (balance < peak) {
      if (underwaterSince < 0) underwaterSince = bar
      maxDdMinutes = Math.max(maxDdMinutes, bar - underwaterSince)
      maxDdPct = Math.max(maxDdPct, (peak - balance) / peak * 100)
    }
    const h = hours[hourIdx]
    const closedThisHour = trades.slice(hourTrades)
    h.closed = closedThisHour.length
    h.orders = closedThisHour.reduce((acc, t) => acc + 2 + t.legs, 0)
    h.wins = closedThisHour.filter((t) => t.pnl > 0).length
    h.losses = closedThisHour.filter((t) => t.pnl <= 0).length
    h.pf = pfOf(closedThisHour); h.pnl = closedThisHour.reduce((acc, t) => acc + t.pnl, 0)
    h.balance = balance; h.drawdownPct = peak > 0 ? (peak - balance) / peak * 100 : 0; h.open = open.size
  }
  for (const sym of [...open.keys()]) closePos(sym, n - 1, series.get(sym)!.close[n - 1], "time")

  const endAt = [...series.values()][0].c[n - 1].time
  const since = (hrs: number) => trades.filter((t) => t.closedAt >= endAt - hrs * 3600_000)
  const ddtSince = (hrs: number) => {
    const from = endAt - hrs * 3600_000
    let pk = -Infinity, bal = 0, under = -1, worst = 0
    for (const t of trades.filter((x) => x.closedAt >= from)) {
      bal += t.pnl
      if (bal > pk) { pk = bal; under = -1 } else if (under < 0) under = t.closedAt
      else worst = Math.max(worst, (t.closedAt - under) / 60_000)
    }
    return Math.round(worst)
  }
  const wins = trades.filter((t) => t.pnl > 0).length
  const active_ = hours.filter((h) => h.closed > 0)
  return {
    type: settings.type,
    symbols: [...series.keys()],
    hours, trades,
    summary: {
      startBalance, endBalance: balance, returnPct: (balance / startBalance - 1) * 100,
      positions: trades.length, orders: trades.reduce((acc, t) => acc + 2 + t.legs, 0),
      winRate: trades.length ? (wins / trades.length) * 100 : 0, pf: pfOf(trades),
      maxDrawdownPct: maxDdPct, maxDrawdownMinutes: maxDdMinutes,
      positiveHours: active_.filter((h) => h.pnl > 0).length, activeHours: active_.length,
      costPctPerTrade: roundTripCostFor(limitEntry, "tp"),
      pfLastPositions: { 12: pfOf(trades.slice(-12)), 25: pfOf(trades.slice(-25)), 75: pfOf(trades.slice(-75)) },
      pfLastHours: { 2: pfOf(since(2)), 6: pfOf(since(6)), 20: pfOf(since(20)) },
      ddtLastHours: { 2: ddtSince(2), 6: ddtSince(6), 20: ddtSince(20) },
      skippedByStrategies: skipped,
    },
  }
}
