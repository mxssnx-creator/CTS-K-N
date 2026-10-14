/**
 * Indication lab: new causal entry families on real one-minute bars.
 *
 *   npx tsx scripts/indication-lab.ts symbol   <bars-dir> <out-dir> <stage: dev|holdout> SYMBOL
 *   npx tsx scripts/indication-lab.ts select   <out-dir>
 *   npx tsx scripts/indication-lab.ts finalize <out-dir>
 *
 * Every signal is decided at a bar's close from that bar and earlier ones
 * only, and enters at that close (the engine's per-type measurement rule).
 * Exits: lib/short-range-exits.ts sparseExits (bar high/low, both touched =
 * stop, gaps at the open; maker = post-only fill on a trade-through).
 *
 * Families: RSI (reversion crossings, extremes, momentum, divergence,
 * multi-timeframe, Stoch-RSI; periods 7/14/21, levels 30/25/20), Bollinger
 * reversion, VWAP-deviation reversion, liquidity sweep, Donchian breakout,
 * EMA pullback, squeeze breakout — each with regime filters, original and
 * faded.
 *
 * Costs: the engine's own round trip (lib/trading-round-trip-cost.ts,
 * 0.26 % = taker 0.10 % per side + 0.06 % slippage) as BASE, ×1.25 as STRESS,
 * and the BingX VIP-0 schedule (0.05 % taker + 0.03 % slippage per leg) as
 * VENUE for reference. Maker legs pay 0.02 % (0.03 % under stress).
 *
 * Selection (development only): ≥ MIN_TRADES trades, PF > 1 at base and at
 * stress, and PF > 1 at base in BOTH halves of the development window. The
 * holdout stage evaluates only the selected rows, once.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { prepare, type Candle } from "@/lib/bots/backtest"
import { wilderRsiSeries } from "@/lib/wilder-rsi"
import { rangeClass, sparseExits, type ExitConfig, type MakerExecution, type MakerResearchClose, type ResearchSignal } from "@/lib/short-range-exits"
import type { ReplayCandle } from "@/lib/trade-engine/prehistoric-type-replay"

const MINUTE_MS = 60_000
const POSITION_COST_PCT = 0.1
const MIN_TRADES = 300
const SELECT_TOP = 40

// ───────────────────────────── costs ─────────────────────────────
export const LAB_COSTS: Record<string, { maker: number; taker: number }> = {
  venue: { maker: 0.02, taker: 0.08 },
  base: { maker: 0.02, taker: 0.13 },
  stress: { maker: 0.03, taker: 0.1625 },
}
const COST_NAMES = Object.keys(LAB_COSTS)
const tradeCost = (close: MakerResearchClose, execution: "market" | "maker", model: { maker: number; taker: number }) =>
  (execution === "maker" ? model.maker : model.taker) + (execution === "maker" && close.exitLeg === "maker" ? model.maker : model.taker)

// ───────────────────────────── exit grid ─────────────────────────────
export interface LabConfig extends ExitConfig { key: string; execution: "market" | "maker"; maker?: MakerExecution; takeProfitMultiple: number; maxHoldMinutes: number }
export function labGrid(): LabConfig[] {
  const out: LabConfig[] = []
  for (const execution of ["market", "maker"] as const) {
    for (const multiple of [3, 5, 8, 12, 20]) {
      for (const stopLossPct of [0.6, 1, 1.5, 2.5]) {
        for (const maxHoldMinutes of [60, 240, 720]) {
          out.push({
            key: `${execution}_tp${multiple}x_sl${stopLossPct}_h${maxHoldMinutes}`,
            execution,
            ...(execution === "maker" && { maker: { entryOffsetPct: 0, fillWindowMinutes: 3 } }),
            takeProfitMultiple: multiple,
            takeProfitPct: Number((multiple * POSITION_COST_PCT).toFixed(6)),
            stopLossPct,
            maxHoldMs: maxHoldMinutes * MINUTE_MS,
            maxHoldMinutes,
          })
        }
      }
    }
  }
  return out
}

// ───────────────────────────── signals ─────────────────────────────
function sma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(Number.NaN)
  let sum = 0, count = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) { sum += v; count++ }
    if (i >= period) { const old = values[i - period]; if (Number.isFinite(old)) { sum -= old; count-- } }
    if (i >= period - 1 && count === period) out[i] = sum / period
  }
  return out
}
function stochRsi(rsi: number[], period = 14): number[] {
  const out = new Array(rsi.length).fill(Number.NaN)
  for (let i = period - 1; i < rsi.length; i++) {
    let lo = Infinity, hi = -Infinity, ok = true
    for (let j = i - period + 1; j <= i; j++) { if (!Number.isFinite(rsi[j])) { ok = false; break } lo = Math.min(lo, rsi[j]); hi = Math.max(hi, rsi[j]) }
    if (ok) out[i] = hi > lo ? ((rsi[i] - lo) / (hi - lo)) * 100 : 50
  }
  return out
}
/** RSI(14) of completed 5-minute bars, known at the close of each 1-minute bar (causal). */
function rsi5mAt(bars: ReplayCandle[]): number[] {
  const closes5: number[] = [], index5: number[] = []
  for (let i = 0; i < bars.length; i++) {
    // A 5-minute bucket completes with its fifth minute (timestamp % 5 min == 4 min).
    if (Math.floor(bars[i].timestamp / MINUTE_MS) % 5 === 4) { closes5.push(bars[i].close); index5.push(i) }
  }
  const r5 = wilderRsiSeries(closes5, 14)
  const out = new Array(bars.length).fill(Number.NaN)
  let k = -1
  for (let i = 0; i < bars.length; i++) {
    while (k + 1 < index5.length && index5[k + 1] <= i) k++
    if (k >= 0) out[i] = r5[k]
  }
  return out
}

export interface LabSignal extends ResearchSignal {}

export function labSignals(bars: ReplayCandle[]): LabSignal[] {
  const candles: Candle[] = bars.map((b) => ({ time: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
  const s = prepare(candles)
  const close = s.close
  const rsi: Record<number, number[]> = { 7: wilderRsiSeries(close, 7), 14: s.rsi, 21: wilderRsiSeries(close, 21) }
  const st = stochRsi(rsi[14]); const k = sma(st, 3); const d = sma(k, 3)
  const r5 = rsi5mAt(bars)
  const out: LabSignal[] = []
  const emit = (i: number, family: string, rule: string, direction: "long" | "short") => {
    if (i + 1 >= bars.length) return
    out.push({ type: family, direction, rule, entryTime: bars[i].timestamp + MINUTE_MS, entryPrice: close[i], profitFactor: 0 })
  }
  for (let i = 121; i < bars.length - 1; i++) {
    const px = close[i], trend = Number.isFinite(s.emaFast[i]) && Number.isFinite(s.emaSlow[i]) ? (s.emaFast[i] - s.emaSlow[i]) / px * 100 : Number.NaN
    if (!Number.isFinite(trend)) continue
    const regimes: [string, boolean][] = [["any", true], ["range", Math.abs(trend) < 0.35]]
    for (const [regime, ok] of regimes) {
      if (!ok) continue
      for (const p of [7, 14, 21]) {
        const r = rsi[p][i], rp = rsi[p][i - 1]
        if (!Number.isFinite(r) || !Number.isFinite(rp)) continue
        for (const lvl of [30, 25, 20]) {
          if (rp < lvl && r >= lvl) emit(i, "rsi_rev", `p${p}_l${lvl}_${regime}`, "long")
          if (rp > 100 - lvl && r <= 100 - lvl) emit(i, "rsi_rev", `p${p}_l${lvl}_${regime}`, "short")
          if (p !== 21) {
            if (r < lvl) emit(i, "rsi_ext", `p${p}_l${lvl}_${regime}`, "long")
            if (r > 100 - lvl) emit(i, "rsi_ext", `p${p}_l${lvl}_${regime}`, "short")
          }
        }
      }
      // Stoch-RSI (14,14,3,3) crossing in the extreme zones.
      if ([k[i], d[i], k[i - 1], d[i - 1]].every(Number.isFinite)) {
        if (k[i - 1] <= d[i - 1] && k[i] > d[i] && k[i] < 20) emit(i, "stoch_rsi", `14_14_3_3_${regime}`, "long")
        if (k[i - 1] >= d[i - 1] && k[i] < d[i] && k[i] > 80) emit(i, "stoch_rsi", `14_14_3_3_${regime}`, "short")
      }
      // Multi-timeframe: 1 m extreme confirmed by the completed 5 m RSI.
      if (Number.isFinite(rsi[14][i]) && Number.isFinite(r5[i])) {
        if (rsi[14][i] < 30 && r5[i] < 40) emit(i, "rsi_mtf", `1m30_5m40_${regime}`, "long")
        if (rsi[14][i] > 70 && r5[i] > 60) emit(i, "rsi_mtf", `1m30_5m40_${regime}`, "short")
      }
      // Bollinger reversion with RSI confirmation.
      for (const kStd of [2, 2.5]) {
        const up = s.bbMid[i] + kStd * s.bbStd[i], lo = s.bbMid[i] - kStd * s.bbStd[i]
        if (px < lo && rsi[14][i] < 30) emit(i, "bb_rev", `k${kStd}_${regime}`, "long")
        if (px > up && rsi[14][i] > 70) emit(i, "bb_rev", `k${kStd}_${regime}`, "short")
      }
      // VWAP deviation reversion.
      if (Number.isFinite(s.vwapDev[i])) {
        for (const z of [2, 2.5, 3]) {
          if (s.vwapDev[i] < -z && rsi[14][i] < 35) emit(i, "vwap_rev", `z${z}_${regime}`, "long")
          if (s.vwapDev[i] > z && rsi[14][i] > 65) emit(i, "vwap_rev", `z${z}_${regime}`, "short")
        }
      }
      // Liquidity sweep: wick through the prior 30-minute extreme, close back inside.
      {
        let hi = -Infinity, lo = Infinity
        for (let j = i - 31; j < i - 1; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low) }
        const a = s.atr[i], bar = bars[i]
        if (Number.isFinite(a)) {
          if (bar.low < lo && px > lo && (lo - bar.low) / px * 100 > 0.3 * a) emit(i, "sweep", `w30_${regime}`, "long")
          if (bar.high > hi && px < hi && (bar.high - hi) / px * 100 > 0.3 * a) emit(i, "sweep", `w30_${regime}`, "short")
        }
      }
    }
    // Trend-dependent families (regime is part of the rule).
    const r14 = rsi[14][i], r14p = rsi[14][i - 1]
    if (Number.isFinite(r14) && Number.isFinite(r14p)) {
      if (r14p < 55 && r14 >= 55 && trend > 0.1) emit(i, "rsi_mom", "p14_x55_trend", "long")
      if (r14p > 45 && r14 <= 45 && trend < -0.1) emit(i, "rsi_mom", "p14_x55_trend", "short")
      // Divergence: a new 20-bar low below the 20–60-bar low with a higher RSI.
      let minPrev = Infinity, minIdx = -1, maxPrev = -Infinity, maxIdx = -1
      for (let j = i - 60; j <= i - 20; j++) { if (close[j] < minPrev) { minPrev = close[j]; minIdx = j } if (close[j] > maxPrev) { maxPrev = close[j]; maxIdx = j } }
      let min20 = Infinity, max20 = -Infinity
      for (let j = i - 19; j <= i; j++) { min20 = Math.min(min20, close[j]); max20 = Math.max(max20, close[j]) }
      if (px === min20 && px < minPrev && minIdx >= 0 && r14 > rsi[14][minIdx] && r14 < 40) emit(i, "rsi_div", "p14_w60", "long")
      if (px === max20 && px > maxPrev && maxIdx >= 0 && r14 < rsi[14][maxIdx] && r14 > 60) emit(i, "rsi_div", "p14_w60", "short")
    }
    // Donchian breakout with ATR expansion and trend agreement.
    if (s.atr[i] > s.atrAvg[i] * 1.3) {
      let hi = -Infinity, lo = Infinity
      for (let j = i - 30; j < i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low) }
      if (px > hi && trend > 0.05) emit(i, "breakout", "d30_atr1.3", "long")
      if (px < lo && trend < -0.05) emit(i, "breakout", "d30_atr1.3", "short")
    }
    // EMA pullback in an established trend.
    if (trend > 0.25 && bars[i].low <= s.emaFast[i] && px > s.emaFast[i] && r14 > 45) emit(i, "ema_pullback", "e20_100", "long")
    if (trend < -0.25 && bars[i].high >= s.emaFast[i] && px < s.emaFast[i] && r14 < 55) emit(i, "ema_pullback", "e20_100", "short")
    // Squeeze breakout.
    const bw = s.bandWidth[i - 1], bwMin = s.bandWidthMin[i - 1]
    if (Number.isFinite(bw) && Number.isFinite(bwMin) && bw <= bwMin * 1.1) {
      if (px > s.bbMid[i] + 2 * s.bbStd[i] && trend >= 0) emit(i, "squeeze", "bw1.1", "long")
      if (px < s.bbMid[i] - 2 * s.bbStd[i] && trend <= 0) emit(i, "squeeze", "bw1.1", "short")
    }
  }
  return out
}

// ───────────────────────────── evaluation ─────────────────────────────
interface Totals { n: number; gp: number[]; gl: number[]; half: number[][]; makerExits: number; placed: number; missed: number; byDir: Record<string, number> }
const empty = (): Totals => ({ n: 0, gp: COST_NAMES.map(() => 0), gl: COST_NAMES.map(() => 0), half: [[0, 0], [0, 0]], makerExits: 0, placed: 0, missed: 0, byDir: { long: 0, short: 0 } })
const fade = (list: LabSignal[]) => list.map((sig) => ({ ...sig, direction: sig.direction === "long" ? "short" as const : "long" as const }))

function loadBars(barsDir: string, symbol: string): ReplayCandle[] {
  return readdirSync(barsDir).filter((n) => n.startsWith(`${symbol}_`) && n.endsWith(".json")).sort()
    .flatMap((n) => JSON.parse(readFileSync(path.join(barsDir, n), "utf8")))
}

function evaluateSymbol(bars: ReplayCandle[], filter?: Set<string>) {
  const signals = labSignals(bars)
  const index = new Map(bars.map((b, i) => [b.timestamp, i]))
  const midMs = bars.length > 0 ? bars[0].timestamp + (bars[bars.length - 1].timestamp - bars[0].timestamp) / 2 : 0
  const byRule = new Map<string, LabSignal[]>()
  for (const sig of signals) {
    const key = `${sig.type}:${sig.rule}`
    if (!byRule.has(key)) byRule.set(key, [])
    byRule.get(key)!.push(sig)
  }
  const results: Record<string, Record<string, Totals>> = {}
  const baseIndex = COST_NAMES.indexOf("base")
  for (const config of labGrid()) {
    for (const [ruleKey, list] of byRule) {
      for (const [prefix, variant] of [["", list], ["fade:", fade(list)]] as const) {
        const group = `${prefix}${ruleKey}`
        if (filter && !filter.has(`${config.key}|${group}`)) continue
        const result = sparseExits(bars, index, variant, config, config.maker)
        const totals = ((results[config.key] ||= {})[group] ||= empty())
        totals.placed += result.placed; totals.missed += result.missed
        for (const close of result.closes) {
          totals.n++
          totals.byDir[close.direction]++
          if (close.exitLeg === "maker") totals.makerExits++
          COST_NAMES.forEach((name, c) => {
            const net = close.grossPct - tradeCost(close, config.execution, LAB_COSTS[name])
            if (net > 0) totals.gp[c] += net; else totals.gl[c] -= net
            if (c === baseIndex) {
              const h = close.entryTime < midMs ? 0 : 1
              if (net > 0) totals.half[h][0] += net; else totals.half[h][1] -= net
            }
          })
        }
      }
    }
  }
  return { signals: signals.length, results }
}

function runSymbol(barsDir: string, outDir: string, stage: "dev" | "holdout", symbol: string) {
  const started = Date.now()
  const bars = loadBars(barsDir, symbol)
  if (bars.length < 2000) { console.log(`${stage} ${symbol}: skipped (${bars.length} bars)`); return }
  let filter: Set<string> | undefined
  if (stage === "holdout") {
    const selection = JSON.parse(readFileSync(path.join(outDir, "selection.json"), "utf8"))
    filter = new Set(selection.selected.map((row: any) => `${row.config}|${row.group}`))
    if (filter.size === 0) { console.log(`holdout ${symbol}: nothing selected`); return }
  }
  const { signals, results } = evaluateSymbol(bars, filter)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `${stage}-${symbol}.json`), JSON.stringify({ symbol, bars: bars.length, signals, results }))
  console.log(`${stage} ${symbol}: ${signals} signals in ${((Date.now() - started) / 1000).toFixed(0)} s`)
}

const pf = (gp: number, gl: number) => gl > 0 ? gp / gl : gp > 0 ? 99 : null
function mergeStage(outDir: string, stage: "dev" | "holdout") {
  const merged: Record<string, Record<string, Totals>> = {}
  const symbols: string[] = []
  let signals = 0
  for (const file of readdirSync(outDir).filter((n) => n.startsWith(`${stage}-`) && n.endsWith(".json")).sort()) {
    const data = JSON.parse(readFileSync(path.join(outDir, file), "utf8"))
    symbols.push(data.symbol); signals += data.signals
    for (const [config, groups] of Object.entries<Record<string, Totals>>(data.results)) {
      for (const [group, t] of Object.entries(groups)) {
        const target = ((merged[config] ||= {})[group] ||= empty())
        target.n += t.n; target.placed += t.placed; target.missed += t.missed; target.makerExits += t.makerExits
        target.byDir.long += t.byDir.long; target.byDir.short += t.byDir.short
        t.gp.forEach((v, i) => { target.gp[i] += v }); t.gl.forEach((v, i) => { target.gl[i] += v })
        t.half.forEach((h, i) => { target.half[i][0] += h[0]; target.half[i][1] += h[1] })
      }
    }
  }
  const grid = new Map(labGrid().map((c) => [c.key, c]))
  const rows = Object.entries(merged).flatMap(([configKey, groups]) => Object.entries(groups).map(([group, t]) => {
    const config = grid.get(configKey)!
    return {
      config: configKey, group, execution: config.execution, takeProfitMultiple: config.takeProfitMultiple, stopLossPct: config.stopLossPct, maxHoldMinutes: config.maxHoldMinutes,
      rangeClass: rangeClass(config.takeProfitPct, POSITION_COST_PCT), trades: t.n, long: t.byDir.long, short: t.byDir.short,
      fillRate: t.placed > 0 ? (t.placed - t.missed) / t.placed : null, makerExitShare: t.n > 0 ? t.makerExits / t.n : null,
      pf: Object.fromEntries(COST_NAMES.map((name, i) => [name, pf(t.gp[i], t.gl[i])])),
      netPct: Object.fromEntries(COST_NAMES.map((name, i) => [name, t.gp[i] - t.gl[i]])),
      halves: t.half.map(([gp, gl]) => pf(gp, gl)),
    }
  }))
  return { rows, symbols, signals }
}

function select(outDir: string) {
  const dev = mergeStage(outDir, "dev")
  const qualifies = (r: any) => r.trades >= MIN_TRADES && (r.pf.base ?? 0) > 1 && (r.pf.stress ?? 0) > 1 && r.halves.every((h: number | null) => (h ?? 0) > 1)
  const candidates = dev.rows.filter(qualifies).sort((a, b) => (b.pf.stress ?? 0) - (a.pf.stress ?? 0))
  const selected = candidates.slice(0, SELECT_TOP).map((r) => ({ config: r.config, group: r.group }))
  writeFileSync(path.join(outDir, "dev-rows.json"), JSON.stringify({ symbols: dev.symbols, signals: dev.signals, rows: dev.rows }))
  writeFileSync(path.join(outDir, "selection.json"), JSON.stringify({
    rule: `development only: ≥ ${MIN_TRADES} trades; PF > 1 at base (0.26 % round trip) and stress (×1.25); PF > 1 at base in both halves; top ${SELECT_TOP} by stress PF`,
    candidates: candidates.length, selected,
  }, null, 2))
  const best = [...dev.rows].filter((r) => r.trades >= MIN_TRADES).sort((a, b) => (b.pf.base ?? 0) - (a.pf.base ?? 0)).slice(0, 10)
  console.log(`select: ${dev.rows.length} rows over ${dev.symbols.length} symbols; ${candidates.length} candidates; ${selected.length} to the holdout`)
  for (const r of best) console.log(`  ${r.group.padEnd(36)} ${r.config.padEnd(30)} n=${r.trades} venue=${r.pf.venue?.toFixed(3)} base=${r.pf.base?.toFixed(3)} stress=${r.pf.stress?.toFixed(3)} halves=${r.halves.map((h: any) => h?.toFixed(2)).join("/")}`)
}

function finalize(outDir: string) {
  const selection = JSON.parse(readFileSync(path.join(outDir, "selection.json"), "utf8"))
  const holdout = readdirSync(outDir).some((n) => n.startsWith("holdout-")) ? mergeStage(outDir, "holdout") : { rows: [], symbols: [], signals: 0 }
  const byKey = new Map(holdout.rows.map((r) => [`${r.config}|${r.group}`, r]))
  const rows = selection.selected.map((s: any) => ({ ...s, holdout: byKey.get(`${s.config}|${s.group}`) ?? null }))
  const validated = rows.filter((r: any) => r.holdout && r.holdout.trades >= MIN_TRADES / 2 && (r.holdout.pf.base ?? 0) > 1 && (r.holdout.pf.stress ?? 0) > 1)
  writeFileSync(path.join(outDir, "holdout-rows.json"), JSON.stringify({ symbols: holdout.symbols, signals: holdout.signals, rows, validated }))
  console.log(`finalize: ${rows.length} evaluated on the holdout; ${validated.length} positive at base and stress`)
  for (const r of rows) {
    const h = r.holdout
    console.log(`  ${r.group.padEnd(36)} ${r.config.padEnd(30)} ${h ? `n=${h.trades} venue=${h.pf.venue?.toFixed(3)} base=${h.pf.base?.toFixed(3)} stress=${h.pf.stress?.toFixed(3)}` : "no trades"}`)
  }
}

const [mode, a, b, c, d] = process.argv.slice(2)
if (mode === "symbol") runSymbol(a, b, c as "dev" | "holdout", d)
else if (mode === "select") select(a)
else if (mode === "finalize") finalize(a)
else { console.error("usage: indication-lab.ts symbol|select|finalize …"); process.exit(2) }
