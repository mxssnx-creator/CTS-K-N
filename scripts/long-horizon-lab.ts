/**
 * Long-horizon lab: do entries on hourly bars have an edge large enough to
 * pay the 0.26 % round trip? The engine's short-hold entries do not: their
 * gross PF is 0.93-1.01 for every type x direction (scripts/pf-attribution.ts),
 * so short-horizon tuning cannot help. Over hours to days a typical move is
 * several percent, and the round trip becomes a small share of it.
 *
 *   npx tsx scripts/long-horizon-lab.ts <hourly-bars-dir> <out-dir> <dev|holdout> [selection.json]
 *
 * Data discipline (fixed before any result was seen):
 *   development  bars before 2026-07-01 UTC
 *   holdout      2026-07-01 .. 2026-09-30 UTC, evaluated ONCE, only for the
 *                configurations the development selection picked
 *
 * Entries are decided on a closed bar and filled at the next bar's open.
 * Exits on later bars' high/low: a bar touching both the stop and the target
 * is a stop; a bar opening beyond a level exits at its open; max hold exits
 * at a bar's close. One position per symbol and configuration at a time.
 *
 * Costs per trade: base = 0.26 % round trip + 0.03 % per day held (funding,
 * conservative and unsigned); stress = 0.39 % + 0.06 % per day.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const HOUR_MS = 3_600_000
const SPLIT_MS = Date.UTC(2026, 6, 1)
const HOLDOUT_END_MS = Date.UTC(2026, 9, 1)
const COST = { base: { roundTrip: 0.26, perDay: 0.03 }, stress: { roundTrip: 0.39, perDay: 0.06 } }

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
type Side = "long" | "short"

// ── Indicators (causal: value at i uses bars 0..i) ─────────────────────────
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = NaN
  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k)
    out.push(i + 1 >= period ? prev : NaN)
  })
  return out
}

function atr(bars: Bar[], period = 14): number[] {
  const out: number[] = []
  let avg = NaN
  for (let i = 0; i < bars.length; i++) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].open
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose))
    if (i < period) { avg = i === 0 ? tr : (avg * i + tr) / (i + 1); out.push(NaN); continue }
    avg = (avg * (period - 1) + tr) / period
    out.push(avg)
  }
  return out
}

/** Wilder RSI over 4-hour closes, mapped back onto the hourly index (value known at the 4h bar's close). */
function rsi4h(bars: Bar[], period = 14): number[] {
  const out = new Array(bars.length).fill(NaN)
  let avgGain = 0, avgLoss = 0, n = 0, lastClose = NaN
  for (let i = 0; i < bars.length; i++) {
    const hour = new Date(bars[i].timestamp).getUTCHours()
    if (hour % 4 !== 3) { if (i > 0) out[i] = out[i - 1]; continue }
    const close = bars[i].close
    if (Number.isFinite(lastClose)) {
      const change = close - lastClose
      const gain = Math.max(0, change), loss = Math.max(0, -change)
      n++
      if (n <= period) { avgGain += gain / period; avgLoss += loss / period }
      else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period }
      if (n >= period) out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)
    }
    lastClose = close
  }
  return out
}

// ── Entry families: signal at bar i (closed) → +1 long, -1 short, 0 none ──
type EntryFn = (i: number) => number
interface Entry { key: string; make: (bars: Bar[]) => EntryFn }

const ENTRIES: Entry[] = [
  ...[24, 72, 168].map((lookback) => ({
    key: `tsmom_${lookback}h`,
    make: (bars: Bar[]) => (i: number) => {
      if (i < lookback + 1) return 0
      const now = Math.sign(bars[i].close - bars[i - lookback].close)
      const before = Math.sign(bars[i - 1].close - bars[i - 1 - lookback].close)
      return now !== before ? now : 0
    },
  })),
  ...[20, 55, 120].map((n) => ({
    key: `donchian_${n}`,
    make: (bars: Bar[]) => (i: number) => {
      if (i < n + 1) return 0
      let hi = -Infinity, lo = Infinity
      for (let j = i - n; j < i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low) }
      if (bars[i].close > hi && bars[i - 1].close <= hi) return 1
      if (bars[i].close < lo && bars[i - 1].close >= lo) return -1
      return 0
    },
  })),
  ...[[12, 48], [24, 96], [50, 200]].map(([f, s]) => ({
    key: `ema_${f}_${s}`,
    make: (bars: Bar[]) => {
      const closes = bars.map((b) => b.close)
      const fast = ema(closes, f), slow = ema(closes, s)
      return (i: number) => {
        if (i < 1 || !Number.isFinite(slow[i - 1])) return 0
        const now = Math.sign(fast[i] - slow[i]), before = Math.sign(fast[i - 1] - slow[i - 1])
        return now !== before ? now : 0
      }
    },
  })),
  ...[[25, 75], [20, 80]].map(([lo, hi]) => ({
    key: `rsi4h_rev_${lo}_${hi}`,
    make: (bars: Bar[]) => {
      const r = rsi4h(bars)
      return (i: number) => {
        if (i < 1 || !Number.isFinite(r[i]) || !Number.isFinite(r[i - 1])) return 0
        if (r[i - 1] < lo && r[i] >= lo) return 1
        if (r[i - 1] > hi && r[i] <= hi) return -1
        return 0
      }
    },
  })),
]

interface ExitCfg { stopAtr: number; targetAtr: number | null; trailAtr: number | null; maxHoldH: number }
const EXITS: ExitCfg[] = []
for (const stopAtr of [2, 3])
  for (const [targetAtr, trailAtr] of [[3, null], [6, null], [null, 3]] as Array<[number | null, number | null]>)
    for (const maxHoldH of [48, 168]) EXITS.push({ stopAtr, targetAtr, trailAtr, maxHoldH })
const SIDES = ["both", "long", "short"] as const

interface Trade { symbol: string; entryTime: number; exitTime: number; side: Side; grossPct: number; holdH: number }

function simulate(symbol: string, bars: Bar[], atrs: number[], signal: EntryFn, side: (typeof SIDES)[number], exit: ExitCfg, fromMs: number, toMs: number): Trade[] {
  const trades: Trade[] = []
  let i = 1
  while (i < bars.length - 1) {
    const s = signal(i)
    const dir = s > 0 ? 1 : s < 0 ? -1 : 0
    if (dir === 0 || (side === "long" && dir < 0) || (side === "short" && dir > 0) || !Number.isFinite(atrs[i]) || bars[i + 1].timestamp < fromMs || bars[i + 1].timestamp >= toMs) { i++; continue }
    const entryBar = i + 1
    const entry = bars[entryBar].open
    const a = atrs[i]
    let stop = entry - dir * exit.stopAtr * a
    const target = exit.targetAtr ? entry + dir * exit.targetAtr * a : null
    let best = entry
    let exitPrice = NaN, exitIdx = -1
    for (let j = entryBar; j < bars.length; j++) {
      const bar = bars[j]
      const long = dir > 0
      if (j > entryBar && (long ? bar.open <= stop : bar.open >= stop)) { exitPrice = bar.open; exitIdx = j; break }
      if (j > entryBar && target !== null && (long ? bar.open >= target : bar.open <= target)) { exitPrice = bar.open; exitIdx = j; break }
      if (long ? bar.low <= stop : bar.high >= stop) { exitPrice = stop; exitIdx = j; break }
      if (target !== null && (long ? bar.high >= target : bar.low <= target)) { exitPrice = target; exitIdx = j; break }
      if ((bar.timestamp - bars[entryBar].timestamp) / HOUR_MS + 1 >= exit.maxHoldH || bar.timestamp + HOUR_MS >= toMs) { exitPrice = bar.close; exitIdx = j; break }
      if (exit.trailAtr) {
        best = long ? Math.max(best, bar.high) : Math.min(best, bar.low)
        const trail = best - dir * exit.trailAtr * a
        stop = long ? Math.max(stop, trail) : Math.min(stop, trail)
      }
    }
    if (exitIdx < 0) break
    trades.push({
      symbol,
      entryTime: bars[entryBar].timestamp,
      exitTime: bars[exitIdx].timestamp + HOUR_MS,
      side: dir > 0 ? "long" : "short",
      grossPct: ((exitPrice - entry) / entry) * 100 * dir,
      holdH: (bars[exitIdx].timestamp - bars[entryBar].timestamp) / HOUR_MS + 1,
    })
    i = exitIdx + 1
  }
  return trades
}

function book(trades: Trade[], cost: { roundTrip: number; perDay: number }) {
  const nets = trades.map((t) => t.grossPct - cost.roundTrip - cost.perDay * (t.holdH / 24))
  let gp = 0, gl = 0
  for (const n of nets) { if (n > 0) gp += n; else gl -= n }
  // Drawdown of the sequential equity (all symbols, ordered by exit time).
  const order = trades.map((t, k) => [t.exitTime, nets[k]] as const).sort((a, b) => a[0] - b[0])
  let eq = 0, peak = 0, maxDd = 0
  for (const [, n] of order) { eq += n; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq) }
  return { trades: trades.length, pf: gl > 0 ? gp / gl : gp > 0 ? 99 : null, netPct: gp - gl, avgPct: trades.length ? (gp - gl) / trades.length : null, maxDdPct: maxDd, winRate: trades.length ? nets.filter((n) => n > 0).length / trades.length : null }
}

function main() {
  const [barsDir, outDir, mode, selectionFile] = process.argv.slice(2)
  if (!barsDir || !outDir || (mode !== "dev" && mode !== "holdout")) throw new Error("usage: long-horizon-lab.ts <bars-dir> <out-dir> <dev|holdout> [selection.json]")
  mkdirSync(outDir, { recursive: true })
  const symbols = readdirSync(barsDir).filter((n) => n.endsWith("USDT.json")).map((n) => n.replace(/\.json$/, ""))
  const data = symbols.map((symbol) => {
    const bars: Bar[] = JSON.parse(readFileSync(path.join(barsDir, `${symbol}.json`), "utf8"))
    return { symbol, bars, atrs: atr(bars) }
  }).filter((d) => d.bars.length > 24 * 60)
  const [fromMs, toMs] = mode === "dev" ? [0, SPLIT_MS] : [SPLIT_MS, HOLDOUT_END_MS]
  const selected: string[] | null = mode === "holdout" ? JSON.parse(readFileSync(selectionFile!, "utf8")).selected.map((r: any) => r.key) : null
  if (mode === "holdout" && (!selected || selected.length === 0)) {
    console.log("nothing selected on development: the holdout stays unviewed")
    return
  }
  const rows: any[] = []
  for (const entry of ENTRIES) {
    const signals = new Map(data.map((d) => [d.symbol, entry.make(d.bars)]))
    for (const side of SIDES) for (const exit of EXITS) {
      const key = `${entry.key}|${side}|sl${exit.stopAtr}|${exit.targetAtr ? `tp${exit.targetAtr}` : `trail${exit.trailAtr}`}|h${exit.maxHoldH}`
      if (selected && !selected.includes(key)) continue
      const trades = data.flatMap((d) => simulate(d.symbol, d.bars, d.atrs, signals.get(d.symbol)!, side, exit, fromMs, toMs))
      const devStart = Math.min(...data.map((d) => d.bars[0].timestamp))
      const mid = mode === "dev" ? devStart + (SPLIT_MS - devStart) / 2 : (SPLIT_MS + HOLDOUT_END_MS) / 2
      const gross = book(trades, { roundTrip: 0, perDay: 0 })
      rows.push({
        key, family: entry.key.replace(/_[^_]*$/, ""), entry: entry.key, side, ...exit,
        base: book(trades, COST.base), stress: book(trades, COST.stress), grossPf: gross.pf, avgHoldH: trades.length ? trades.reduce((s, t) => s + t.holdH, 0) / trades.length : null,
        halves: [book(trades.filter((t) => t.entryTime < mid), COST.base).pf, book(trades.filter((t) => t.entryTime >= mid), COST.base).pf],
      })
    }
    console.log(`${entry.key}: done`)
  }
  writeFileSync(path.join(outDir, `${mode}-rows.json`), JSON.stringify({ symbols: data.map((d) => d.symbol), fromMs, toMs, cost: COST, rows }, null, 1))
  if (mode === "dev") {
    const rule = "≥ 300 trades; PF > 1 under base AND stress costs; base PF > 1 in both halves; ranked by max drawdown, then base PF; top 5"
    const candidates = rows.filter((r) => r.base.trades >= 300 && (r.base.pf ?? 0) > 1 && (r.stress.pf ?? 0) > 1 && r.halves.every((h: number | null) => (h ?? 0) > 1))
    const selectedRows = [...candidates].sort((a, b) => a.base.maxDdPct - b.base.maxDdPct || (b.base.pf ?? 0) - (a.base.pf ?? 0)).slice(0, 5)
    writeFileSync(path.join(outDir, "selection.json"), JSON.stringify({ rule, candidates: candidates.length, selected: selectedRows }, null, 2))
    console.log(`configs=${rows.length} candidates=${candidates.length}`)
    for (const r of [...rows].sort((a, b) => (b.base.pf ?? 0) - (a.base.pf ?? 0)).slice(0, 15)) {
      console.log(`${r.key.padEnd(44)} n=${String(r.base.trades).padStart(5)} grossPF=${r.grossPf?.toFixed(2)} PF=${r.base.pf?.toFixed(3)} stress=${r.stress.pf?.toFixed(3)} halves=${r.halves.map((h: number | null) => h?.toFixed(2)).join("/")} dd=${r.base.maxDdPct.toFixed(1)}`)
    }
  } else {
    for (const r of rows) console.log(`HOLDOUT ${r.key} n=${r.base.trades} PF=${r.base.pf?.toFixed(3)} stress=${r.stress.pf?.toFixed(3)} dd=${r.base.maxDdPct.toFixed(1)}`)
  }
}
main()
