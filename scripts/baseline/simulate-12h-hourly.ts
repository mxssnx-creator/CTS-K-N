/**
 * Walk-forward simulation of the engine chain with detailed hourly statistics.
 *
 * Same chain and cost model as scripts/baseline/simulate-24h-portfolio.ts
 * (Base -> Main/Axis -> Real/Block -> Live replay, round-trip cost from
 * lib/trading-round-trip-cost.ts, PositionCost 0.10 % as sizing only), but
 * WITHOUT look-ahead: the 24 h baseline validates a lane on the last 50
 * positions of the whole window and then trades that same window. Here the
 * window is split at `end - CTS_SIM_TEST_HOURS`:
 *
 *   train  = trades that OPENED and CLOSED before the split. Base validates a
 *            lane on its last CTS_SIM_EVAL closed positions with a profit factor
 *            of at least CTS_SIM_BASE_PF.
 *   test   = the last CTS_SIM_TEST_HOURS hours. Only lanes that passed on the
 *            train data trade here. Axis and Block are derived on the lane's
 *            full sequence (they use earlier results as context, which is
 *            causal), then only trades opened in the test window are replayed.
 *
 * Environment:
 *   CTS_BASELINE_CANDLES   path to the candle JSON (BingX 1m klines by symbol)
 *   CTS_SIM_TEST_HOURS     hours simulated out of sample          (default 12)
 *   CTS_SIM_BASE_PF        Base validation profit factor          (default 1.1)
 *   CTS_SIM_EVAL           closed positions per Base window       (default 50)
 *   CTS_SIM_MAX_POS        concurrent positions in the replay     (default 100)
 *   CTS_SIM_MAX_PER_SYMBOL concurrent positions per symbol, 0=off (default 0)
 *   CTS_SIM_SYMBOLS        symbols used from the file             (default 22)
 *   CTS_SIM_OUT            optional path for the hourly rows as JSON
 */
import { readFileSync, writeFileSync } from "node:fs"
import { deriveConfigSignals } from "@/lib/historic-test-config-signals"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

const env = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && process.env[name] !== "" && process.env[name] !== undefined ? parsed : fallback
}
const candles: Record<string, any[]> = JSON.parse(readFileSync(process.env.CTS_BASELINE_CANDLES || "/tmp/sim/candles30.json", "utf8"))
const SYMBOLS = Object.keys(candles).slice(0, env("CTS_SIM_SYMBOLS", 22))
const TEST_HOURS = env("CTS_SIM_TEST_HOURS", 12)
const BASE_PF = env("CTS_SIM_BASE_PF", 1.1)
const EVAL = env("CTS_SIM_EVAL", 50)
const MAX_POS = env("CTS_SIM_MAX_POS", 100)
const MAX_PER_SYMBOL = env("CTS_SIM_MAX_PER_SYMBOL", 0)
const PC = 0.1, COST = roundTripCostPercent(), TP = PC * 5, SL = PC * 20, HOLD = 240
const START = 10, LEV = 5, RISK_PER_POS = 0.003
const SL_R = Math.abs((-SL - COST) / PC)
const COST_R = COST / PC

type T = HistoricTestTrade & { sym: string; openedAt: number; closedAt: number; family: string }
function resolve(rows: any[], s: any, sym: string): T | null {
  const st = s.index + 1, e = rows[st]
  if (!e) return null
  const en = e.close, lg = s.direction === "long", fav = (p: number) => (lg ? p - en : en - p) / en * 100
  const last = Math.min(rows.length - 1, st + HOLD)
  for (let i = st + 1; i <= last; i++) {
    const c = rows[i]
    if (fav(lg ? c.low : c.high) <= -SL) return { signedResultR: (-SL - COST) / PC, openedAt: e.time, closedAt: c.time, sym, family: "" } as T
    if (fav(lg ? c.high : c.low) >= TP) return { signedResultR: (TP - COST) / PC, openedAt: e.time, closedAt: c.time, sym, family: "" } as T
  }
  const x = rows[last]
  return { signedResultR: (fav(x.close) - COST) / PC, openedAt: e.time, closedAt: x.time, sym, family: "" } as T
}
const pf = (t: readonly { signedResultR: number }[]) => (t.length ? 1 + (t.reduce((s, x) => s + x.signedResultR, 0) / t.length) * 0.1 : 1)

const tEnd = Math.max(...SYMBOLS.map((s) => candles[s].at(-1).time))
const tStart = Math.min(...SYMBOLS.map((s) => candles[s][0].time))
const split = tEnd - TEST_HOURS * 3600_000
const RANGES = Array.from({ length: 44 }, (_, i) => i + 5)

// STAGE BASE: validate each lane on TRAIN data only.
let lanesTotal = 0, lanesWithHistory = 0
const lanes: T[][] = []
for (const sym of SYMBOLS) for (const range of RANGES) {
  lanesTotal++
  const sig = deriveConfigSignals(candles[sym] as any, { range, drawdownRatio: 1, lastPartRatio: 0.5, factorMultiplier: 1 })
  const all = sig.map((s: any) => resolve(candles[sym], s, sym)).filter(Boolean) as T[]
  const train = all.filter((t) => t.closedAt <= split)
  if (train.length < EVAL) continue
  lanesWithHistory++
  if (pf(train.slice(-EVAL)) >= BASE_PF) lanes.push(all)
}
// STAGE MAIN (Axis) and REAL (Block) on the lane's full sequence, then only the test window.
const inTest = (t: T) => t.openedAt >= split
const axisLanes = lanes.map((l) => (deriveAxisTrades(l as any, { prev: 6, last: 2, cont: 1, pause: 8 }) as T[]).map((t) => ({ ...t, family: "axis" })))
const blockLanes = axisLanes.flatMap((l) => [1, 2].map((c) => (deriveBlockTrades(l as any, { volumeRatio: 0.2, maxStack: 6, fixedCount: c, incrementSteps: 3 }) as T[]).map((t) => ({ ...t, family: `block${c}` }))))
const candidates = [...axisLanes.flat(), ...blockLanes.flat()].filter(inTest).sort((a, b) => a.openedAt - b.openedAt)

const hh = (ms: number) => new Date(ms).toISOString().slice(11, 16)
console.log(`════ ${TEST_HOURS}h WALK-FORWARD SIMULATION — ${SYMBOLS.length} symbols, cost ${COST.toFixed(3)}%, TP ${TP.toFixed(2)}% / SL ${SL.toFixed(2)}% ════`)
console.log(`data     ${new Date(tStart).toISOString().slice(0, 16)}Z .. ${new Date(tEnd).toISOString().slice(0, 16)}Z (${((tEnd - tStart) / 3600000).toFixed(1)} h)`)
console.log(`split    ${new Date(split).toISOString().slice(0, 16)}Z   train ${((split - tStart) / 3600000).toFixed(1)} h (Base) | test ${TEST_HOURS} h (traded, unseen)`)
console.log(`BASE     ${lanesTotal} lanes, ${lanesWithHistory} with >= ${EVAL} closed train positions, ${lanes.length} validated at PF >= ${BASE_PF}`)
console.log(`MAIN     axis   ${axisLanes.flat().filter(inTest).length} test trades  PF=${pf(axisLanes.flat().filter(inTest)).toFixed(4)}`)
console.log(`REAL     block  ${blockLanes.flat().filter(inTest).length} test trades  PF=${pf(blockLanes.flat().filter(inTest)).toFixed(4)}`)
console.log(`LIVE     replay max ${MAX_POS} concurrent${MAX_PER_SYMBOL ? `, max ${MAX_PER_SYMBOL} per symbol` : ""}; a full stop costs ${(RISK_PER_POS * 100).toFixed(2)}% of balance`)

if (candidates.length === 0) {
  console.log("\nNo lane passed Base validation on the training window: nothing is traded in the test window.")
  process.exit(0)
}

type Open = T & { unit: number }
let bal = START, peak = START, maxDD = 0, rejected = 0, rejectedSymbol = 0, cursor = 0
let open: Open[] = []
const taken: Array<T & { pnl: number; gross: number }> = []
const rows: any[] = []
for (let h = 0; h < TEST_HOURS; h++) {
  const hStart = split + h * 3600_000, hEnd = hStart + 3600_000
  const closing: Open[] = []
  open = open.filter((p) => { if (p.closedAt < hEnd) { closing.push(p); return false } return true })
  let opened = 0
  while (cursor < candidates.length && candidates[cursor].openedAt < hEnd) {
    const c = candidates[cursor++]
    if (open.length >= MAX_POS) { rejected++; continue }
    if (MAX_PER_SYMBOL > 0 && open.filter((p) => p.sym === c.sym).length >= MAX_PER_SYMBOL) { rejectedSymbol++; continue }
    const unit = (RISK_PER_POS * Math.max(0, bal)) / SL_R
    opened++
    if (c.closedAt < hEnd) closing.push({ ...c, unit }); else open.push({ ...c, unit })
  }
  let pnl = 0, gross = 0, wins = 0, losses = 0
  for (const p of closing) {
    const v = p.signedResultR * p.unit, g = (p.signedResultR + COST_R) * p.unit
    pnl += v; gross += g
    if (v > 0) wins++; else if (v < 0) losses++
    taken.push({ ...p, pnl: v, gross: g })
  }
  bal = Math.max(0, bal + pnl)
  peak = Math.max(peak, bal)
  const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 0
  maxDD = Math.max(maxDD, dd)
  const cost = gross - pnl
  const gp = closing.filter((p) => p.signedResultR > 0).reduce((s, p) => s + p.signedResultR * p.unit, 0)
  const gl = Math.abs(closing.filter((p) => p.signedResultR < 0).reduce((s, p) => s + p.signedResultR * p.unit, 0))
  rows.push({
    hour: h + 1, from: hh(hStart), opened, closed: closing.length, wins, losses,
    win: closing.length ? (wins / closing.length) * 100 : null,
    pf: closing.length ? pf(closing) : null, pfGross$: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    pnl, gross, cost, bal, dd, openAtEnd: open.length, orders: closing.length * 3,
  })
}

const f = (n: number | null, w: number, d = 2) => (n === null ? "—" : Number.isFinite(n) ? n.toFixed(d) : "∞").padStart(w)
console.log(`\n hr  start  opened closed  win  loss  win%    PF    PF$gross    pnl$    cost$   balance   dd%  open  orders`)
for (const r of rows) {
  console.log(`${String(r.hour).padStart(3)}  ${r.from}  ${String(r.opened).padStart(5)} ${String(r.closed).padStart(6)} ${String(r.wins).padStart(4)} ${String(r.losses).padStart(5)} ${f(r.win, 5, 1)} ${f(r.pf, 6, 3)} ${f(r.pfGross$, 8, 2)} ${f(r.pnl, 8, 4)} ${f(r.cost, 8, 4)} ${f(r.bal, 9, 4)} ${f(r.dd, 5, 1)} ${String(r.openAtEnd).padStart(5)} ${String(r.orders).padStart(7)}`)
}
const active = rows.filter((r) => r.closed > 0)
const positive = active.filter((r) => r.pnl > 0)
const wins = taken.filter((t) => t.pnl > 0), losses = taken.filter((t) => t.pnl < 0)
const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
const totalCost = taken.reduce((s, t) => s + (t.gross - t.pnl), 0), totalGross = taken.reduce((s, t) => s + t.gross, 0)
console.log(`\n════ SUMMARY (out of sample) ════`)
console.log(`balance        $${START.toFixed(2)} -> $${bal.toFixed(4)}   return ${((bal / START - 1) * 100).toFixed(2)}%   max drawdown ${maxDD.toFixed(2)}%`)
console.log(`positions      ${taken.length} closed, ${open.length} still open at the end, ${rejected} rejected by the ${MAX_POS} cap${MAX_PER_SYMBOL ? `, ${rejectedSymbol} by the per-symbol cap` : ""}`)
console.log(`orders         ${taken.length * 3} (entry + stop-loss + take-profit per closed position)   ${(taken.length / TEST_HOURS).toFixed(1)} positions/hour`)
console.log(`win rate       ${(wins.length / Math.max(1, taken.length) * 100).toFixed(1)}%   avg win $${(gp / Math.max(1, wins.length)).toFixed(4)}   avg loss $${(gl / Math.max(1, losses.length)).toFixed(4)}`)
console.log(`profit factor  ${gl > 0 ? (gp / gl).toFixed(4) : "∞"} (gross of trades, after cost)   ${pf(taken).toFixed(4)} (R-normalised)`)
console.log(`gross / cost   $${totalGross.toFixed(4)} before cost, $${totalCost.toFixed(4)} cost -> cost takes ${totalGross > 0 ? ((totalCost / totalGross) * 100).toFixed(0) : "n/a"}% of the gross result`)
console.log(`positive hours ${positive.length}/${active.length} with closes (${(positive.length / Math.max(1, active.length) * 100).toFixed(0)}%), ${rows.length - active.length} hour(s) without a close`)
const bySym = new Map<string, { n: number; pnl: number }>()
for (const t of taken) { const e = bySym.get(t.sym) || { n: 0, pnl: 0 }; e.n++; e.pnl += t.pnl; bySym.set(t.sym, e) }
const ranked = [...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl)
console.log(`best symbols   ${ranked.slice(0, 3).map(([s, e]) => `${s} ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(3)} (${e.n})`).join("  ")}`)
console.log(`worst symbols  ${ranked.slice(-3).reverse().map(([s, e]) => `${s} ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(3)} (${e.n})`).join("  ")}`)
const byFamily = new Map<string, { n: number; r: number }>()
for (const t of taken) { const e = byFamily.get(t.family) || { n: 0, r: 0 }; e.n++; e.r += t.signedResultR; byFamily.set(t.family, e) }
console.log(`by family      ${[...byFamily.entries()].map(([k, e]) => `${k}: ${e.n} trades, PF ${(1 + (e.r / e.n) * 0.1).toFixed(3)}`).join("  |  ")}`)
if (process.env.CTS_SIM_OUT) writeFileSync(process.env.CTS_SIM_OUT, JSON.stringify({ split, testHours: TEST_HOURS, lanes: lanes.length, rows, summary: { positions: taken.length, balance: bal, maxDD } }, null, 1))
