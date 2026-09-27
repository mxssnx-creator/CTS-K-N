#!/usr/bin/env tsx
/**
 * Historic walk-forward v2: orthogonal inputs + coordination tactics.
 *
 * Usage:
 *   node --import tsx scripts/historic-signal-eval-v2.ts \
 *     [--symbols BCH,XRP,SOL] [--primary-end 2026-09-13] [--seen-end 2026-09-27] \
 *     [--cost 0.1] [--stress 2] [--max-hold 60] [--out <dir>] [--cache <dir>]
 *
 * Windows (14 complete UTC days each):
 *   primary  = the 14 days ending at --primary-end (default 2026-08-30..09-12).
 *              Never evaluated before; days 1-7 select, days 8-14 evaluate ONCE.
 *   seen     = the 14 days ending at --seen-end (default 2026-09-13..09-26).
 *              Already used by the v1 study: reported for consistency only and
 *              explicitly NOT a holdout.
 *
 * Only public, unauthenticated, read-only GET market-data endpoints are used
 * (see lib/signal-orthogonal-sources.ts). No credentials, no orders.
 *
 * Execution: BingX swap 1m candles, entry at the decision bar close, stop-first
 * ambiguous bars, one PositionCost per trade (1x) and stress (2x). Every SL is
 * floored at the operator minimum stop-loss (0.5 %) and the trailing profile
 * uses the effective Signal trailing floor (max(0.8, 0.5) = 0.8 %).
 */
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_SIGNAL_INDICATION_SETTINGS,
  effectiveSignalStopLossMinPct,
  evaluateSignalCandles,
  normalizeSignalIndicationSettings,
} from "@/lib/signal-indication"
import { getSignalSource, type SignalCandle } from "@/lib/signal-source-registry"
import { buildSignalTrailingProfile } from "@/lib/signal-trailing"
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  aggregateHourly,
  causalCandleWindow,
  grossMovePct,
  simulateSignalExit,
  summarizeHours,
  summarizeNetResults,
  walkForwardSplit,
} from "@/lib/signal-historic-eval"
import {
  ORTHOGONAL_SIGNAL_SOURCES,
  REJECTED_ORTHOGONAL_ENDPOINTS,
  adx,
  basisPct,
  getOrthogonalSource,
  valueAsOf,
  type OrthogonalFeaturePoint,
} from "@/lib/signal-orthogonal-sources"
import { DEFAULT_MIN_STOP_LOSS_PCT } from "@/lib/protection-floors"
import { VENUE_HISTORY_SPECS, loadVenueHistory } from "./historic-signal-data"

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const SYMBOLS = arg("symbols", "BCH,XRP,SOL").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
const PRIMARY_END = Date.parse(`${arg("primary-end", "2026-09-13")}T00:00:00Z`)
const SEEN_END = Date.parse(`${arg("seen-end", "2026-09-27")}T00:00:00Z`)
const COST = Number(arg("cost", "0.1"))
const STRESS = Number(arg("stress", "2"))
const MAX_HOLD = Number(arg("max-hold", "60"))
const OUT_DIR = arg("out", path.join(process.cwd(), "tmp", "historic-signal-eval-v2"))
const CACHE_DIR = arg("cache", path.join(OUT_DIR, "hist"))
const WARMUP_MIN = 120
const DAYS = 14
const TRAIN_DAYS = 7
const MIN_TRAIN_TRADES = 15

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Grid = (SignalCandle | null)[]
type Dir = "long" | "short"

// ---------------------------------------------------------------------------
// Aux downloads (cached JSON)
// ---------------------------------------------------------------------------
async function getJson(url: string, attempts = 4): Promise<any> {
  let last: unknown
  for (let a = 0; a < attempts; a++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const res = await fetch(url, { method: "GET", signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      last = e
      await sleep(1000 * (a + 1))
    }
  }
  throw last
}

async function cached<T>(name: string, fetcher: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR, `v2_${name}.json`)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  const value = await fetcher()
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  return value
}

function dedupe(points: OrthogonalFeaturePoint[]): OrthogonalFeaturePoint[] {
  const m = new Map<number, number>()
  for (const p of points) m.set(p.availableAt, p.value)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([availableAt, value]) => ({ availableAt, value }))
}

/** Forward paging by start time (Binance data API, Gate). */
async function pagedForward(id: string, base: string, startMs: number, endMs: number, stepMs: number, limit: number, delay: number) {
  const src = getOrthogonalSource(id)!
  const out: OrthogonalFeaturePoint[] = []
  for (let s = startMs; s < endMs; s += stepMs) {
    const payload = await getJson(src.buildUrl({ base, startMs: s, endMs: Math.min(endMs, s + stepMs) - 1, limit }))
    out.push(...src.parse(payload))
    await sleep(delay)
  }
  return dedupe(out).filter((p) => p.availableAt > startMs && p.availableAt <= endMs + 5 * MINUTE_MS)
}

/** Backward paging with OKX `after` (records strictly older than the cursor). */
async function pagedBackward(id: string, base: string, startMs: number, endMs: number, limit: number, delay: number) {
  const src = getOrthogonalSource(id)!
  const out: OrthogonalFeaturePoint[] = []
  let cursor = endMs
  for (let guard = 0; guard < 2000; guard++) {
    const payload = await getJson(src.buildUrl({ base, endMs: cursor, limit }))
    const rows: any[] = Array.isArray(payload?.data) ? payload.data : []
    if (rows.length === 0) break
    const pts = src.parse(payload)
    out.push(...pts)
    const oldestRaw = Math.min(...rows.map((r: any) => Number(Array.isArray(r) ? r[0] : r?.fundingTime)))
    if (!(oldestRaw < cursor) || oldestRaw <= startMs) break
    cursor = oldestRaw
    await sleep(delay)
  }
  return dedupe(out).filter((p) => p.availableAt > startMs && p.availableAt <= endMs + MINUTE_MS)
}

interface WindowData {
  label: string
  seen: boolean
  startMs: number
  endMs: number
  gridStart: number
  gridLen: number
  grids: Record<string, Grid>
  spot: Record<string, Grid>
  taker: Record<string, OrthogonalFeaturePoint[]>
  index: Record<string, OrthogonalFeaturePoint[]>
  gateTaker: Record<string, OrthogonalFeaturePoint[]>
  gateAccount: Record<string, OrthogonalFeaturePoint[]>
  gateOi: Record<string, OrthogonalFeaturePoint[]>
  funding: Record<string, OrthogonalFeaturePoint[]>
  coverage: Array<{ series: string; symbol: string; points: number; expected: number; note?: string }>
}

async function loadWindow(label: string, endMs: number, seen: boolean): Promise<WindowData> {
  const startMs = endMs - DAYS * DAY_MS
  const gridStart = startMs - WARMUP_MIN * MINUTE_MS
  const gridLen = (endMs - gridStart) / MINUTE_MS
  const w: WindowData = {
    label, seen, startMs, endMs, gridStart, gridLen,
    grids: {}, spot: {}, taker: {}, index: {}, gateTaker: {}, gateAccount: {}, gateOi: {}, funding: {}, coverage: [],
  }
  const toGrid = (candles: SignalCandle[]): Grid => {
    const g: Grid = new Array(gridLen).fill(null)
    for (const c of candles) {
      const i = (c.timestamp - gridStart) / MINUTE_MS
      if (i >= 0 && i < gridLen) g[i] = c
    }
    return g
  }
  const expected1m = gridLen
  for (const base of SYMBOLS) {
    for (const venue of ["bingx-swap", "binance-spot-data"]) {
      const spec = VENUE_HISTORY_SPECS.find((s) => s.sourceId === venue)!
      const h = await loadVenueHistory({ spec, base, startMs: gridStart, endMs, cacheDir: CACHE_DIR, log })
      ;(venue === "bingx-swap" ? w.grids : w.spot)[base] = toGrid(h.candles)
      w.coverage.push({ series: venue, symbol: base, points: h.candles.length, expected: expected1m, note: h.error })
    }
    w.taker[base] = await cached(`taker_${base}_${gridStart}_${endMs}`, () =>
      pagedForward("binance-spot-taker-buy", base, gridStart, endMs, 1000 * MINUTE_MS, 1000, 120))
    w.index[base] = await cached(`index_${base}_${gridStart}_${endMs}`, () =>
      pagedBackward("okx-index-price", base, gridStart, endMs, 100, 110))
    const gate = await cached(`gate_${base}_${gridStart - DAY_MS}_${endMs}`, async () => {
      const out: any[] = []
      for (let s = gridStart - DAY_MS; s < endMs; s += 1900 * 5 * MINUTE_MS) {
        const payload = await getJson(getOrthogonalSource("gate-taker-lsr")!.buildUrl({ base, startMs: s, limit: 2000 }))
        if (Array.isArray(payload)) out.push(...payload)
        await sleep(200)
      }
      return out
    })
    w.gateTaker[base] = dedupe(getOrthogonalSource("gate-taker-lsr")!.parse(gate))
    w.gateAccount[base] = dedupe(getOrthogonalSource("gate-account-lsr")!.parse(gate))
    w.gateOi[base] = dedupe(getOrthogonalSource("gate-open-interest")!.parse(gate))
    w.funding[base] = await cached(`funding_${base}_${gridStart - 3 * DAY_MS}_${endMs}`, () =>
      pagedBackward("okx-funding-rate", base, gridStart - 3 * DAY_MS, endMs, 100, 150))
    w.coverage.push(
      { series: "binance-spot-taker-buy", symbol: base, points: w.taker[base].length, expected: expected1m },
      { series: "okx-index-price", symbol: base, points: w.index[base].length, expected: expected1m },
      { series: "gate-contract-stats-5m", symbol: base, points: w.gateTaker[base].length, expected: Math.round((endMs - gridStart + DAY_MS) / (5 * MINUTE_MS)) },
      { series: "okx-funding-rate", symbol: base, points: w.funding[base].length, expected: Math.round((endMs - gridStart + 3 * DAY_MS) / (8 * HOUR_MS)) },
    )
    log(`${label} ${base}: bingx ${w.grids[base].filter(Boolean).length}, spot ${w.spot[base].filter(Boolean).length}, taker ${w.taker[base].length}, index ${w.index[base].length}, gate ${w.gateTaker[base].length}, funding ${w.funding[base].length}`)
  }
  return w
}

// ---------------------------------------------------------------------------
// Causal features per bar (decision at close of bar i => time tsOf(i)+1m)
// ---------------------------------------------------------------------------
interface Features {
  baseDir: Int8Array // +1 long, -1 short, 0 none (repo candle indicator on BingX)
  baseStrength: Float64Array
  baseSl: Float64Array
  adx5: Float64Array
  ret15: Float64Array
  ret60: Float64Array
  takerImb15: Float64Array // volume-weighted taker-buy share - 0.5 over 15 bars
  gateTakerLog: Float64Array // ln(lsr_taker), latest completed 5m
  accountZ: Float64Array // z of lsr_account vs trailing 24h
  oiChg60: Float64Array // % change of OI over 60 min
  funding: Float64Array // latest settled funding rate
  basisZ: Float64Array // z of perp-index basis vs trailing 24h
  leadLag: Float64Array // spot 2m return - perp 2m return (%)
  hour: Int8Array
}

function std(values: number[]): { mean: number; sd: number } {
  const v = values.filter(Number.isFinite)
  if (v.length < 10) return { mean: Number.NaN, sd: Number.NaN }
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  return { mean, sd }
}

function computeFeatures(w: WindowData, base: string): Features {
  const n = w.gridLen
  const grid = w.grids[base]
  const spot = w.spot[base]
  const settings = normalizeSignalIndicationSettings({ ...DEFAULT_SIGNAL_INDICATION_SETTINGS, minimumStrength: 0.2 })
  const source = getSignalSource("bingx-swap")!
  const f: Features = {
    baseDir: new Int8Array(n), baseStrength: new Float64Array(n), baseSl: new Float64Array(n),
    adx5: new Float64Array(n).fill(Number.NaN), ret15: new Float64Array(n).fill(Number.NaN), ret60: new Float64Array(n).fill(Number.NaN),
    takerImb15: new Float64Array(n).fill(Number.NaN), gateTakerLog: new Float64Array(n).fill(Number.NaN),
    accountZ: new Float64Array(n).fill(Number.NaN), oiChg60: new Float64Array(n).fill(Number.NaN),
    funding: new Float64Array(n).fill(Number.NaN), basisZ: new Float64Array(n).fill(Number.NaN),
    leadLag: new Float64Array(n).fill(Number.NaN), hour: new Int8Array(n),
  }
  const tsOf = (i: number) => w.gridStart + i * MINUTE_MS
  const closeAt = (g: Grid, i: number) => (i >= 0 && g[i] ? g[i]!.close : Number.NaN)
  // taker share per bar (Binance spot), keyed by bar index.
  const takerShare = new Float64Array(n).fill(Number.NaN)
  for (const p of w.taker[base]) {
    const i = (p.availableAt - MINUTE_MS - w.gridStart) / MINUTE_MS
    if (i >= 0 && i < n) takerShare[i] = p.value
  }
  const indexClose = new Float64Array(n).fill(Number.NaN)
  for (const p of w.index[base]) {
    const i = (p.availableAt - MINUTE_MS - w.gridStart) / MINUTE_MS
    if (i >= 0 && i < n) indexClose[i] = p.value
  }
  const basisRaw = new Float64Array(n).fill(Number.NaN)
  for (let i = 0; i < n; i++) basisRaw[i] = basisPct(closeAt(grid, i), indexClose[i])
  let adxCarry = Number.NaN
  for (let i = WARMUP_MIN; i < n; i++) {
    const t = tsOf(i) + MINUTE_MS
    f.hour[i] = new Date(tsOf(i)).getUTCHours()
    if (!grid[i]) continue
    const window = causalCandleWindow(grid, i, settings.candleLimit)
    if (window.length >= 50) {
      const e = evaluateSignalCandles({ source, candles: window, settings, positionCostPct: COST })
      if (e) {
        f.baseDir[i] = e.direction === "long" ? 1 : -1
        f.baseStrength[i] = e.strength
        f.baseSl[i] = e.stopLossPct
      }
    }
    if (i % 5 === 4) {
      const bars: { high: number; low: number; close: number }[] = []
      for (let k = i - 149; k <= i; k += 5) {
        const chunk = grid.slice(Math.max(0, k), k + 5).filter(Boolean) as SignalCandle[]
        if (chunk.length) bars.push({ high: Math.max(...chunk.map((c) => c.high)), low: Math.min(...chunk.map((c) => c.low)), close: chunk[chunk.length - 1].close })
      }
      adxCarry = adx(bars, 14)
    }
    f.adx5[i] = adxCarry
    const c = grid[i]!.close
    f.ret15[i] = (c / closeAt(grid, i - 15) - 1) * 100
    f.ret60[i] = (c / closeAt(grid, i - 60) - 1) * 100
    let vb = 0
    let vt = 0
    for (let k = i - 14; k <= i; k++) {
      const s = spot[k]
      if (s && Number.isFinite(takerShare[k])) {
        vb += takerShare[k] * s.volume
        vt += s.volume
      }
    }
    f.takerImb15[i] = vt > 0 ? vb / vt - 0.5 : Number.NaN
    const gt = valueAsOf(w.gateTaker[base], t, 15 * MINUTE_MS)
    f.gateTakerLog[i] = gt > 0 ? Math.log(gt) : Number.NaN
    const acc = valueAsOf(w.gateAccount[base], t, 15 * MINUTE_MS)
    if (i % 5 === 4 || !Number.isFinite(f.accountZ[i - 1])) {
      const hist: number[] = []
      for (let k = 1; k <= 288; k += 3) hist.push(valueAsOf(w.gateAccount[base], t - k * 5 * MINUTE_MS, 15 * MINUTE_MS))
      const { mean, sd } = std(hist)
      f.accountZ[i] = sd > 0 ? (acc - mean) / sd : Number.NaN
    } else {
      f.accountZ[i] = f.accountZ[i - 1]
    }
    const oiNow = valueAsOf(w.gateOi[base], t, 15 * MINUTE_MS)
    const oiThen = valueAsOf(w.gateOi[base], t - 60 * MINUTE_MS, 15 * MINUTE_MS)
    f.oiChg60[i] = oiNow > 0 && oiThen > 0 ? (oiNow / oiThen - 1) * 100 : Number.NaN
    f.funding[i] = valueAsOf(w.funding[base], t, 9 * HOUR_MS)
    if (i % 5 === 4 || !Number.isFinite(f.basisZ[i - 1])) {
      const hist: number[] = []
      for (let k = i - 1440; k < i; k += 7) if (k >= 0) hist.push(basisRaw[k])
      const { mean, sd } = std(hist)
      f.basisZ[i] = sd > 0 && Number.isFinite(basisRaw[i]) ? (basisRaw[i] - mean) / sd : Number.NaN
    } else {
      f.basisZ[i] = f.basisZ[i - 1]
    }
    const sRet = (closeAt(spot, i) / closeAt(spot, i - 2) - 1) * 100
    const pRet = (c / closeAt(grid, i - 2) - 1) * 100
    f.leadLag[i] = sRet - pRet
  }
  return f
}

// ---------------------------------------------------------------------------
// Strategy families (entry rules). Each returns +1/-1/0 at bar i.
// ---------------------------------------------------------------------------
interface Family {
  key: string
  label: string
  kind: "baseline" | "tactic" | "orthogonal-confirmation" | "orthogonal-standalone"
  params: number[]
  describe: (p: number) => string
  signal: (f: Features, i: number, p: number) => number
}
const sgn = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0)
const FAMILIES: Family[] = [
  { key: "F0-baseline", label: "Baseline candle signal (BingX)", kind: "baseline", params: [0.2, 0.35, 0.5],
    describe: (p) => `strength>=${p}`, signal: (f, i, p) => (f.baseStrength[i] >= p ? f.baseDir[i] : 0) },
  { key: "F1-regime-trend", label: "Baseline + trend regime (ADX 5m >= p)", kind: "tactic", params: [20, 25, 30, 35],
    describe: (p) => `ADX5>=${p}`, signal: (f, i, p) => (f.adx5[i] >= p ? f.baseDir[i] : 0) },
  { key: "F1b-regime-chop-fade", label: "Chop regime fade (ADX 5m < p, against baseline)", kind: "tactic", params: [15, 20, 25],
    describe: (p) => `ADX5<${p} fade`, signal: (f, i, p) => (f.adx5[i] < p ? -f.baseDir[i] : 0) },
  { key: "F2-mtf", label: "Baseline + multi-timeframe agreement (15m & 60m return)", kind: "tactic", params: [0, 0.1, 0.25],
    describe: (p) => `|ret15|,|ret60|>${p}% same sign`,
    signal: (f, i, p) => (f.baseDir[i] && sgn(f.ret15[i]) === f.baseDir[i] && sgn(f.ret60[i]) === f.baseDir[i] && Math.abs(f.ret15[i]) > p && Math.abs(f.ret60[i]) > p ? f.baseDir[i] : 0) },
  { key: "F3-taker-confirm", label: "Baseline + Binance taker-flow confirmation", kind: "orthogonal-confirmation", params: [0.02, 0.05, 0.1],
    describe: (p) => `dir*takerImb15>=${p}`, signal: (f, i, p) => (f.baseDir[i] * f.takerImb15[i] >= p ? f.baseDir[i] : 0) },
  { key: "F4-oi-confirm", label: "Baseline + rising open interest (Gate)", kind: "orthogonal-confirmation", params: [0, 0.5, 1],
    describe: (p) => `OI 60m chg>=${p}%`, signal: (f, i, p) => (f.oiChg60[i] >= p ? f.baseDir[i] : 0) },
  { key: "F5-funding-not-crowded", label: "Baseline only when funding is not crowded in trade direction", kind: "orthogonal-confirmation", params: [0, 0.00005, 0.0001],
    describe: (p) => `dir*funding<=${p}`, signal: (f, i, p) => (Number.isFinite(f.funding[i]) && f.baseDir[i] * f.funding[i] <= p ? f.baseDir[i] : 0) },
  { key: "F6-taker-momentum", label: "Standalone taker-flow momentum (Binance spot)", kind: "orthogonal-standalone", params: [0.08, 0.12, 0.16],
    describe: (p) => `|takerImb15|>=${p}`, signal: (f, i, p) => (Math.abs(f.takerImb15[i]) >= p ? sgn(f.takerImb15[i]) : 0) },
  { key: "F6b-gate-taker", label: "Standalone Gate taker buy/sell ratio momentum", kind: "orthogonal-standalone", params: [0.5, 0.8, 1.2],
    describe: (p) => `|ln lsr_taker|>=${p}`, signal: (f, i, p) => (Math.abs(f.gateTakerLog[i]) >= p ? sgn(f.gateTakerLog[i]) : 0) },
  { key: "F7-account-lsr-contrarian", label: "Standalone long/short account ratio contrarian (Gate)", kind: "orthogonal-standalone", params: [1.5, 2, 2.5],
    describe: (p) => `|z|>=${p}`, signal: (f, i, p) => (Math.abs(f.accountZ[i]) >= p ? -sgn(f.accountZ[i]) : 0) },
  { key: "F8-basis-revert", label: "Standalone perp-index basis mean reversion (OKX index)", kind: "orthogonal-standalone", params: [2, 2.5, 3],
    describe: (p) => `|basisZ|>=${p}`, signal: (f, i, p) => (Math.abs(f.basisZ[i]) >= p ? -sgn(f.basisZ[i]) : 0) },
  { key: "F9-lead-lag", label: "Standalone cross-exchange lead-lag (Binance spot leads BingX perp)", kind: "orthogonal-standalone", params: [0.05, 0.1, 0.15],
    describe: (p) => `|spot2m-perp2m|>=${p}%`, signal: (f, i, p) => (Math.abs(f.leadLag[i]) >= p ? sgn(f.leadLag[i]) : 0) },
  { key: "F10-funding-extreme", label: "Standalone funding-extreme contrarian (OKX)", kind: "orthogonal-standalone", params: [0.0001, 0.0002, 0.0004],
    describe: (p) => `|funding|>=${p}`, signal: (f, i, p) => (Math.abs(f.funding[i]) >= p ? -sgn(f.funding[i]) : 0) },
  { key: "F12-combined", label: "Baseline + MTF + taker confirmation + trend regime", kind: "tactic", params: [0.02, 0.05],
    describe: (p) => `mtf & ADX5>=20 & taker>=${p}`,
    signal: (f, i, p) => (f.baseDir[i] && f.adx5[i] >= 20 && sgn(f.ret15[i]) === f.baseDir[i] && sgn(f.ret60[i]) === f.baseDir[i] && f.baseDir[i] * f.takerImb15[i] >= p ? f.baseDir[i] : 0) },
]

interface ExitCfg { key: string; slPct: number; rr: number; trailing: boolean }
const EXITS: ExitCfg[] = []
for (const slPct of [0.5, 0.8, 1.2]) for (const rr of [1.5, 2.5]) for (const trailing of [false, true]) {
  EXITS.push({ key: `sl${slPct}_rr${rr}${trailing ? "_trail" : ""}`, slPct, rr, trailing })
}
const SIGNAL_SETTINGS = normalizeSignalIndicationSettings({})
const SL_FLOOR = effectiveSignalStopLossMinPct(SIGNAL_SETTINGS)
const TRAIL_PROFILE = buildSignalTrailingProfile(SIGNAL_SETTINGS)

interface Trade { symbol: string; direction: Dir; entryTs: number; exitTs: number; grossPct: number; reason: string }

function runConfig(w: WindowData, feats: Record<string, Features>, fam: Family, p: number, exit: ExitCfg, fromMs: number, toMs: number, hourMask?: Set<number>): Trade[] {
  const trades: Trade[] = []
  for (const base of SYMBOLS) {
    const f = feats[base]
    const grid = w.grids[base]
    const from = Math.max(WARMUP_MIN, (fromMs - w.gridStart) / MINUTE_MS)
    const to = (toMs - w.gridStart) / MINUTE_MS
    let busy = -1
    for (let i = from; i < to; i++) {
      if (i <= busy || !grid[i]) continue
      if (hourMask && !hourMask.has(f.hour[i])) continue
      const d = fam.signal(f, i, p)
      if (!d) continue
      const direction: Dir = d > 0 ? "long" : "short"
      const sl = Math.max(SL_FLOOR, exit.slPct)
      const ex = simulateSignalExit({ grid, entryIndex: i, direction, stopLossPct: sl, takeProfitPct: sl * exit.rr, maxHoldBars: MAX_HOLD, trailing: exit.trailing ? TRAIL_PROFILE : null })
      if (!ex) continue
      trades.push({ symbol: base, direction, entryTs: w.gridStart + i * MINUTE_MS, exitTs: w.gridStart + ex.exitIndex * MINUTE_MS, grossPct: grossMovePct(direction, grid[i]!.close, ex.exitPrice), reason: ex.reason })
      busy = ex.exitIndex
    }
  }
  return trades.sort((a, b) => a.exitTs - b.exitTs)
}

function metrics(trades: Trade[], costMult: number, fromMs: number, toMs: number) {
  const net = trades.map((t) => t.grossPct - COST * costMult)
  const s = summarizeNetResults(net)
  const hours = summarizeHours(aggregateHourly(trades.map((t, k) => ({ exitTs: t.exitTs, netPct: net[k] })), fromMs, toMs))
  const gross = trades.reduce((a, t) => a + t.grossPct, 0)
  return { ...s, grossPct: round(gross, 4), hours }
}
const score = (m: ReturnType<typeof metrics>) => m.netPct - 0.5 * m.maxDrawdownPct

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const primary = await loadWindow("primary", PRIMARY_END, false)
  const seen = await loadWindow("seen", SEEN_END, true)
  const results: any[] = []
  const featsP: Record<string, Features> = {}
  const featsS: Record<string, Features> = {}
  for (const b of SYMBOLS) {
    featsP[b] = computeFeatures(primary, b)
    featsS[b] = computeFeatures(seen, b)
    log(`features ${b} done`)
  }
  const sp = walkForwardSplit(PRIMARY_END, DAYS, TRAIN_DAYS)
  const allConfigs: any[] = []
  const familyRows: any[] = []
  const curves: Record<string, { ts: number; eq: number }[]> = {}
  const hourlyEval: Record<string, { hourStart: number; netPct: number; trades: number }[]> = {}
  const runFamily = (fam: Family, hourMaskFor?: (p: number, exit: ExitCfg) => Set<number> | undefined) => {
    let best: any = null
    for (const p of fam.params) for (const exit of EXITS) {
      const mask = hourMaskFor?.(p, exit)
      const tr = runConfig(primary, featsP, fam, p, exit, sp.train.startMs, sp.train.endMs, mask)
      const m = metrics(tr, 1, sp.train.startMs, sp.train.endMs)
      const te = runConfig(primary, featsP, fam, p, exit, sp.test.startMs, sp.test.endMs, mask)
      const e1 = metrics(te, 1, sp.test.startMs, sp.test.endMs)
      allConfigs.push({ family: fam.key, param: fam.describe(p), exit: exit.key, trainTrades: m.trades, trainNet: m.netPct, trainDd: m.maxDrawdownPct, evalTrades: e1.trades, evalNet1x: e1.netPct, evalNet2x: round(e1.netPct - COST * (STRESS - 1) * e1.trades, 4), evalGross: e1.grossPct })
      if (m.trades < MIN_TRAIN_TRADES) continue
      if (!best || score(m) > score(best.train)) best = { p, exit, train: m, mask }
    }
    if (!best) {
      familyRows.push({ family: fam.key, label: fam.label, kind: fam.kind, selected: "—", note: `no config with >=${MIN_TRAIN_TRADES} train trades` })
      return null
    }
    const te = runConfig(primary, featsP, fam, best.p, best.exit, sp.test.startMs, sp.test.endMs, best.mask)
    const e1 = metrics(te, 1, sp.test.startMs, sp.test.endMs)
    const e2 = metrics(te, STRESS, sp.test.startMs, sp.test.endMs)
    const seenTr = runConfig(seen, featsS, fam, best.p, best.exit, seen.startMs, seen.endMs, best.mask)
    const s1 = metrics(seenTr, 1, seen.startMs, seen.endMs)
    const s2 = metrics(seenTr, STRESS, seen.startMs, seen.endMs)
    let eq = 0
    curves[fam.key] = te.map((t) => ({ ts: t.exitTs, eq: round((eq += t.grossPct - COST), 4) }))
    hourlyEval[fam.key] = aggregateHourly(te.map((t) => ({ exitTs: t.exitTs, netPct: t.grossPct - COST })), sp.test.startMs, sp.test.endMs)
    const row = {
      family: fam.key, label: fam.label, kind: fam.kind,
      selected: `${fam.describe(best.p)} · ${best.exit.key}${best.mask ? ` · hours ${[...best.mask].sort((a, b) => a - b).join(",")}` : ""}`,
      train: best.train, eval1x: e1, eval2x: e2, seen1x: s1, seen2x: s2,
      positiveEval1x: e1.netPct > 0, positiveEval2x: e2.netPct > 0,
    }
    familyRows.push(row)
    log(`${fam.key}: train ${best.train.netPct} (${best.train.trades}) | eval 1x ${e1.netPct} 2x ${e2.netPct} (${e1.trades}) posHours ${e1.hours.positiveShareOfActive} | seen 1x ${s1.netPct}`)
    return row
  }
  for (const fam of FAMILIES) runFamily(fam)
  // F11: hour-of-day filter selected on train only (hours whose train net is positive for the baseline).
  const f0 = FAMILIES[0]
  runFamily({ ...f0, key: "F11-hour-filter", label: "Baseline restricted to UTC hours positive on train", kind: "tactic" }, (p, exit) => {
    const tr = runConfig(primary, featsP, f0, p, exit, sp.train.startMs, sp.train.endMs)
    const net = new Array(24).fill(0)
    const cnt = new Array(24).fill(0)
    for (const t of tr) { const h = new Date(t.entryTs).getUTCHours(); net[h] += t.grossPct - COST; cnt[h]++ }
    return new Set(net.map((v, h) => (cnt[h] >= 3 && v > 0 ? h : -1)).filter((h) => h >= 0))
  })

  const report = {
    generatedAt: new Date().toISOString(),
    windows: {
      primary: { start: new Date(primary.startMs).toISOString(), end: new Date(primary.endMs).toISOString(), train: [new Date(sp.train.startMs).toISOString(), new Date(sp.train.endMs).toISOString()], eval: [new Date(sp.test.startMs).toISOString(), new Date(sp.test.endMs).toISOString()], status: "unseen before this run; eval half used once" },
      seen: { start: new Date(seen.startMs).toISOString(), end: new Date(seen.endMs).toISOString(), status: "SEEN (v1 study) — consistency check only, not a holdout" },
    },
    cost: { positionCostPct: COST, stress: STRESS, maxHoldBars: MAX_HOLD, slFloorPct: SL_FLOOR, trailingMinStopPct: round((TRAIL_PROFILE.minStopRatio ?? 0) * 100, 4), defaultMinStopLossPct: DEFAULT_MIN_STOP_LOSS_PCT },
    symbols: SYMBOLS,
    exitGrid: EXITS.map((e) => e.key),
    sources: ORTHOGONAL_SIGNAL_SOURCES.map((s) => ({ id: s.id, name: s.name, kind: s.kind, historicReplay: s.historicReplay, periodMinutes: s.periodMinutes, docs: s.officialDocs })),
    rejectedSources: REJECTED_ORTHOGONAL_ENDPOINTS,
    coverage: { primary: primary.coverage, seen: seen.coverage },
    families: familyRows,
    allConfigs,
    curves,
    hourlyEval,
  }
  fs.writeFileSync(path.join(OUT_DIR, "signal-eval-v2.json"), JSON.stringify(report, null, 1))
  fs.writeFileSync(path.join(OUT_DIR, "signal-eval-v2.html"), renderHtml(report))
  log(`wrote ${path.join(OUT_DIR, "signal-eval-v2.html")}`)
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function esc(s: unknown) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)) }
function fmt(v: number, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : "—" }
function cls(v: number) { return v > 0 ? "pos" : v < 0 ? "neg" : "" }

function renderHtml(r: any): string {
  const rows = r.families.filter((f: any) => f.eval1x)
  const tableRows = rows.map((f: any) => `<tr>
    <td><b>${esc(f.family)}</b><div class="sub">${esc(f.label)}</div></td><td>${esc(f.kind)}</td><td class="sel">${esc(f.selected)}</td>
    <td class="num">${f.train.trades}</td><td class="num ${cls(f.train.netPct)}">${fmt(f.train.netPct)}</td>
    <td class="num">${f.eval1x.trades}</td><td class="num ${cls(f.eval1x.netPct)}">${fmt(f.eval1x.netPct)}</td><td class="num ${cls(f.eval2x.netPct)}">${fmt(f.eval2x.netPct)}</td>
    <td class="num">${fmt(f.eval1x.profitFactor)}</td><td class="num">${fmt(f.eval1x.maxDrawdownPct)}</td><td class="num">${fmt(f.eval1x.winRate * 100, 1)}%</td>
    <td class="num">${fmt(f.eval1x.hours.positiveShareOfActive * 100, 1)}%</td><td class="num">${fmt(f.eval1x.hours.nonNegativeShareOfAll * 100, 1)}%</td>
    <td class="num ${cls(f.seen1x.netPct)}">${fmt(f.seen1x.netPct)}</td><td class="num ${cls(f.seen2x.netPct)}">${fmt(f.seen2x.netPct)}</td></tr>`).join("")
  const skipped = r.families.filter((f: any) => !f.eval1x).map((f: any) => `<li>${esc(f.family)}: ${esc(f.note)}</li>`).join("")
  const posCount = r.allConfigs.filter((c: any) => c.evalNet1x > 0).length
  const pos2Count = r.allConfigs.filter((c: any) => c.evalNet2x > 0).length
  const grossPos = r.allConfigs.filter((c: any) => c.evalGross > 0).length
  // equity chart
  const W = 900, H = 300, P = 40
  const keys = Object.keys(r.curves).filter((k) => r.curves[k].length)
  const allPts = keys.flatMap((k) => r.curves[k])
  const t0 = Date.parse(r.windows.primary.eval[0]), t1 = Date.parse(r.windows.primary.eval[1])
  const yMin = Math.min(0, ...allPts.map((p: any) => p.eq)), yMax = Math.max(0, ...allPts.map((p: any) => p.eq))
  const x = (t: number) => P + ((t - t0) / (t1 - t0)) * (W - 2 * P)
  const y = (v: number) => H - P - ((v - yMin) / (yMax - yMin || 1)) * (H - 2 * P)
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#4d7c0f", "#b45309", "#1e40af", "#7c3aed", "#059669", "#e11d48", "#475569", "#0d9488"]
  const lines = keys.map((k, idx) => `<polyline fill="none" stroke="${palette[idx % palette.length]}" stroke-width="1.6" points="${esc([`${x(t0)},${y(0)}`, ...r.curves[k].map((p: any) => `${x(p.ts).toFixed(1)},${y(p.eq).toFixed(1)}`)].join(" "))}"><title>${esc(k)}</title></polyline>`).join("")
  const legend = keys.map((k, idx) => `<span class="lg"><i style="background:${palette[idx % palette.length]}"></i>${esc(k)}</span>`).join("")
  const hourCharts = rows.map((f: any) => {
    const hb = r.hourlyEval[f.family] || []
    const mx = Math.max(0.01, ...hb.map((b: any) => Math.abs(b.netPct)))
    const bw = (W - 2 * P) / Math.max(1, hb.length)
    const bars = hb.map((b: any, i: number) => {
      const h = (Math.abs(b.netPct) / mx) * 40
      return b.trades ? `<rect x="${(P + i * bw).toFixed(1)}" y="${(b.netPct >= 0 ? 50 - h : 50).toFixed(1)}" width="${Math.max(0.6, bw - 0.4).toFixed(1)}" height="${h.toFixed(1)}" fill="${b.netPct >= 0 ? "var(--pos)" : "var(--neg)"}"><title>${new Date(b.hourStart).toISOString().slice(5, 13)}h ${b.netPct.toFixed(3)}% (${b.trades})</title></rect>` : ""
    }).join("")
    return `<div class="hc"><div class="sub">${esc(f.family)} — eval hourly net 1× (${fmt(f.eval1x.hours.positiveShareOfActive * 100, 1)}% of active hours positive)</div><svg viewBox="0 0 ${W} 100" preserveAspectRatio="none"><line x1="${P}" x2="${W - P}" y1="50" y2="50" stroke="var(--grid)"/>${bars}</svg></div>`
  }).join("")
  const cov = (list: any[]) => list.map((c) => `<tr><td>${esc(c.series)}</td><td>${esc(c.symbol)}</td><td class="num">${c.points}</td><td class="num">${c.expected}</td><td class="num">${fmt((c.points / c.expected) * 100, 1)}%</td><td>${esc(c.note || "")}</td></tr>`).join("")
  const enabled = rows.filter((f: any) => f.positiveEval1x)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signal Eval v2</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1c1c;--mut:#666;--card:#fff;--line:#e5e5e2;--pos:#15803d;--neg:#b91c1c;--grid:#ccc}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161616;--fg:#eaeaea;--mut:#9a9a9a;--card:#1f1f1f;--line:#333;--pos:#4ade80;--neg:#f87171;--grid:#444}}
:root[data-theme="dark"]{--bg:#161616;--fg:#eaeaea;--mut:#9a9a9a;--card:#1f1f1f;--line:#333;--pos:#4ade80;--neg:#f87171;--grid:#444}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1300px;margin:auto}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}.sub{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}.pos{color:var(--pos)}.neg{color:var(--neg)}.sel{font-family:ui-monospace,monospace;font-size:11.5px}
svg{width:100%;height:auto}.lg{display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11.5px}.lg i{width:10px;height:10px;display:inline-block;border-radius:2px}
.hc svg{height:70px}.warn{border-left:4px solid #d97706}
</style></head><body>
<h1>Signal evaluation v2 — orthogonal inputs and coordination tactics</h1>
<div class="sub">Generated ${esc(r.generatedAt)} · symbols ${esc(r.symbols.join(", "))} · execution BingX swap 1m · cost ${r.cost.positionCostPct}% per trade (stress ${r.cost.stress}×) · max hold ${r.cost.maxHoldBars} min · SL floor ${r.cost.slFloorPct}% · trailing min stop ${r.cost.trailingMinStopPct}%</div>
<div class="card warn"><b>Data honesty.</b> Primary window ${esc(r.windows.primary.start.slice(0, 10))} … ${esc(r.windows.primary.end.slice(0, 10))} (exclusive) was not used before this run. Every parameter/exit/hour choice uses train days 1–7 only (${esc(r.windows.primary.train[0].slice(0, 10))}–${esc(r.windows.primary.train[1].slice(0, 10))}); eval days 8–14 are reported once. Having now been viewed, the eval half is <b>no longer an independent holdout</b> for any further tuning. The ${esc(r.windows.seen.start.slice(0, 10))} … ${esc(r.windows.seen.end.slice(0, 10))} window was already used by the v1 study and is shown only as a consistency check (<b>SEEN, not a holdout</b>).</div>
<h2>Verdict</h2>
<div class="card">${enabled.length ? `Positive on eval half after 1× cost: <b>${esc(enabled.map((f: any) => f.family).join(", "))}</b>. Positive under 2× cost too: <b>${esc(rows.filter((f: any) => f.positiveEval2x).map((f: any) => f.family).join(", ") || "none")}</b>.` : "<b>No train-selected family is positive after costs on the evaluation half.</b>"}
<br>All ${r.allConfigs.length} executed configurations on the eval half: ${grossPos} positive before costs, ${posCount} positive after 1× cost, ${pos2Count} after 2× cost (reported for context only — choosing from these would be selection on the eval half).</div>
<h2>Train-selected configuration per family (score = net − 0.5×maxDD on train, ≥${MIN_TRAIN_TRADES} trades)</h2>
<div class="card"><table><thead><tr><th>Family</th><th>Kind</th><th>Selected on train</th><th class="num">Train n</th><th class="num">Train net %</th><th class="num">Eval n</th><th class="num">Eval net 1× %</th><th class="num">Eval net 2× %</th><th class="num">Eval PF</th><th class="num">Eval max DD %</th><th class="num">Win</th><th class="num">+ hours / active</th><th class="num">non-neg hours / all</th><th class="num">Seen net 1× %</th><th class="num">Seen net 2× %</th></tr></thead><tbody>${tableRows}</tbody></table>${skipped ? `<ul class="sub">${skipped}</ul>` : ""}
<div class="sub">Net = sum of per-trade % results (unlevered, non-overlapping per symbol and family, pooled over symbols).</div></div>
<h2>Eval-half cumulative net (1× cost) of the train-selected configurations</h2>
<div class="card"><svg viewBox="0 0 ${W} ${H}"><line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" stroke="var(--grid)"/><text x="4" y="${y(yMax) + 4}" font-size="10" fill="currentColor">${fmt(yMax, 1)}%</text><text x="4" y="${y(yMin)}" font-size="10" fill="currentColor">${fmt(yMin, 1)}%</text>${lines}</svg><div>${legend}</div></div>
<h2>Hourly results on the eval half</h2><div class="card">${hourCharts}</div>
<h2>Orthogonal sources (candidates, validation gate unchanged)</h2>
<div class="card"><table><thead><tr><th>ID</th><th>Name</th><th>Kind</th><th>Historic replay</th><th>Period</th></tr></thead><tbody>${r.sources.map((s: any) => `<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.kind)}</td><td>${s.historicReplay ? "yes" : "no (live only)"}</td><td>${s.periodMinutes || "event"}</td></tr>`).join("")}</tbody></table>
<div class="sub">Rejected: ${r.rejectedSources.map((s: any) => `${esc(s.id)} — ${esc(s.reason)}`).join("; ")}</div></div>
<h2>Configuration dimensions</h2><div class="card">Entry families × thresholds: ${FAMILIES.map((f) => `${f.key} [${f.params.join(", ")}]`).join("; ")}; F11 hour filter derived on train. Exit grid (${r.exitGrid.length}): ${esc(r.exitGrid.join(", "))}. Not covered: order-book imbalance (no history), Binance futures data (region restricted), leverage/position sizing, multiple concurrent positions per symbol.</div>
<h2>Data coverage</h2><div class="card"><table><thead><tr><th>Series</th><th>Symbol</th><th class="num">Points</th><th class="num">Expected</th><th class="num">Coverage</th><th>Note</th></tr></thead><tbody><tr><td colspan="6"><b>Primary</b></td></tr>${cov(r.coverage.primary)}<tr><td colspan="6"><b>Seen</b></td></tr>${cov(r.coverage.seen)}</tbody></table></div>
<h2>All executed configurations (eval half)</h2><div class="card"><table><thead><tr><th>Family</th><th>Param</th><th>Exit</th><th class="num">Train n</th><th class="num">Train net</th><th class="num">Train DD</th><th class="num">Eval n</th><th class="num">Eval gross</th><th class="num">Eval 1×</th><th class="num">Eval 2×</th></tr></thead><tbody>${r.allConfigs.map((c: any) => `<tr><td>${esc(c.family)}</td><td class="sel">${esc(c.param)}</td><td class="sel">${esc(c.exit)}</td><td class="num">${c.trainTrades}</td><td class="num ${cls(c.trainNet)}">${fmt(c.trainNet)}</td><td class="num">${fmt(c.trainDd)}</td><td class="num">${c.evalTrades}</td><td class="num ${cls(c.evalGross)}">${fmt(c.evalGross)}</td><td class="num ${cls(c.evalNet1x)}">${fmt(c.evalNet1x)}</td><td class="num ${cls(c.evalNet2x)}">${fmt(c.evalNet2x)}</td></tr>`).join("")}</tbody></table></div>
</body></html>`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
