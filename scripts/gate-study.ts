/**
 * After-Base-gate study: what does the engine's Base gate admit, and how do
 * the admitted trades perform?
 *
 *   npx tsx scripts/gate-study.ts <bars-dir> <signals-dir> <out-file> [SYMBOL,...]
 *
 * Every captured engine row (scripts/short-range-capture.ts) trades with the
 * engine's own protection (deriveProtectionFromProfitFactor of the row PF,
 * operator floors) on the venue's real one-minute bars (sparseExits, market
 * execution, 4 h max hold) and pays the engine's round trip
 * (simulatedCloseCostPercent). The Base gate (applyBaseGate — the
 * coordinator's rule: ≥ minCount measured closes in the symbol × type ×
 * direction bucket, min(row PF, mean PositionCost ratio of the last `window`)
 * ≥ stage PF) is applied in variants; the study reports the trades it admits
 * and their PF, per variant and per type.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sparseExits, type ResearchSignal } from "@/lib/short-range-exits"
import { applyBaseGate, type BacktestTrade } from "@/lib/connection-backtest"
import { deriveProtectionFromProfitFactor } from "@/lib/strategy-coordinator"
import { setActiveProtectionFloors } from "@/lib/protection-floors"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"

const POSITION_COST_PCT = 0.1
const COST_PCT = simulatedCloseCostPercent(POSITION_COST_PCT)

export const GATE_VARIANTS = (() => {
  const out: { key: string; minCount: number; window: number; stagePf: number }[] = [{ key: "ungated", minCount: 0, window: 0, stagePf: 0 }]
  for (const stagePf of [1.1, 1.2, 1.3, 1.5])
    for (const window of [10, 25, 50])
      for (const minCount of [5, 10])
        if (minCount <= window) out.push({ key: `pf${stagePf}_w${window}_n${minCount}`, minCount, window, stagePf })
  return out
})()

/**
 * Significance-aware gate: a candidate trades only when its bucket's last
 * `window` measured closes (finished before the entry) number at least
 * `minCount` and the one-sided lower confidence bound of their mean net
 * result after costs is above zero: mean − z·sd/√n > 0.
 */
export const SIGNIFICANCE_VARIANTS = (() => {
  const out: { key: string; window: number; minCount: number; z: number }[] = []
  for (const window of [25, 50, 100])
    for (const z of [1.28, 1.645])
      out.push({ key: `sig_w${window}_z${z}`, window, minCount: Math.min(window, 20), z })
  return out
})()

export function applySignificanceGate(candidates: readonly BacktestTrade[], gate: { window: number; minCount: number; z: number }): BacktestTrade[] {
  const byBucket = new Map<string, BacktestTrade[]>()
  for (const trade of candidates) {
    const key = `${trade.symbol}|${trade.type}|${trade.direction}`
    if (!byBucket.has(key)) byBucket.set(key, [])
    byBucket.get(key)!.push(trade)
  }
  const admitted: BacktestTrade[] = []
  for (const list of byBucket.values()) {
    const byExit = [...list].sort((a, b) => a.exitTime - b.exitTime)
    for (const candidate of [...list].sort((a, b) => a.entryTime - b.entryTime)) {
      const history = byExit.filter((close) => close.exitTime <= candidate.entryTime).slice(-gate.window)
      if (history.length < gate.minCount) continue
      const values = history.map((close) => close.netPct)
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length
      const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length - 1))
      if (mean - gate.z * sd / Math.sqrt(values.length) > 0) admitted.push(candidate)
    }
  }
  return admitted
}

function book(trades: BacktestTrade[]) {
  let gp = 0, gl = 0
  for (const t of trades) { if (t.netPct > 0) gp += t.netPct; else gl -= t.netPct }
  return { trades: trades.length, pf: gl > 0 ? gp / gl : gp > 0 ? 99 : null, netPct: gp - gl, avgPct: trades.length ? (gp - gl) / trades.length : null }
}

async function main() {
  const [barsDir, signalsDir, outFile, symbolArg] = process.argv.slice(2)
  setActiveProtectionFloors({})
  const symbols = symbolArg ? symbolArg.split(",") : readdirSync(signalsDir).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, ""))
  const all: Record<string, BacktestTrade[]> = Object.fromEntries([...GATE_VARIANTS, ...SIGNIFICANCE_VARIANTS].map((v) => [v.key, []]))
  const startMs: number[] = []
  for (const symbol of symbols) {
    const bars = readdirSync(barsDir).filter((n) => n.startsWith(`${symbol}_`) && n.endsWith(".json")).sort()
      .flatMap((n) => JSON.parse(readFileSync(path.join(barsDir, n), "utf8")))
    if (bars.length < 2000) continue
    startMs.push(bars[0].timestamp)
    const index = new Map<number, number>(bars.map((b: any, i: number) => [b.timestamp, i]))
    const captured: ResearchSignal[] = JSON.parse(readFileSync(path.join(signalsDir, `${symbol}.json`), "utf8")).signals
    const signals = captured.map((s) => {
      const protection = deriveProtectionFromProfitFactor(s.profitFactor, POSITION_COST_PCT)
      return { ...s, takeProfitPct: protection.takeProfitPct, stopLossPct: protection.stopLossPct }
    })
    const result = sparseExits(bars, index, signals, { takeProfitPct: 1, stopLossPct: 1, maxHoldMs: 4 * 3_600_000 })
    const pfOf = new Map(signals.map((s) => [`${s.type}|${s.direction}|${s.rule}|${s.entryTime}`, s]))
    const trades: BacktestTrade[] = result.closes.map((c) => {
      const s = pfOf.get(`${c.type}|${c.direction}|${c.rule}|${c.entryTime}`)!
      return {
        symbol, type: c.type, direction: c.direction, rule: c.rule, entryTime: c.entryTime, exitTime: c.exitTime,
        entryPrice: c.entryPrice, exitPrice: c.exitPrice, takeProfitPct: s.takeProfitPct!, stopLossPct: s.stopLossPct!,
        grossPct: c.grossPct, costPct: COST_PCT, netPct: c.grossPct - COST_PCT, reason: c.reason, exitLeg: "taker",
        profitFactor: s.profitFactor,
      }
    })
    for (const variant of GATE_VARIANTS) {
      all[variant.key].push(...(variant.key === "ungated" ? trades : applyBaseGate(trades, POSITION_COST_PCT, variant, movePctToMainTradePfRatio).admitted))
    }
    for (const variant of SIGNIFICANCE_VARIANTS) all[variant.key].push(...applySignificanceGate(trades, variant))
    console.log(`${symbol}: ${trades.length} trades`)
  }
  const mid = startMs.length ? Math.min(...startMs) + 7 * 86_400_000 : 0
  const rows = [...GATE_VARIANTS, ...SIGNIFICANCE_VARIANTS].map((variant) => {
    const trades = all[variant.key]
    const byType: Record<string, ReturnType<typeof book>> = {}
    for (const type of [...new Set(trades.map((t) => t.type))].sort()) byType[type] = book(trades.filter((t) => t.type === type))
    return {
      ...variant,
      ...book(trades),
      halves: [book(trades.filter((t) => t.entryTime < mid)).pf, book(trades.filter((t) => t.entryTime >= mid)).pf],
      byType,
    }
  })
  writeFileSync(outFile, JSON.stringify({ costPct: COST_PCT, symbols, rows }, null, 2))
  for (const r of rows) console.log(`${r.key.padEnd(18)} trades=${String(r.trades).padStart(7)} pf=${r.pf?.toFixed(3)} avg=${r.avgPct?.toFixed(4)} halves=${r.halves.map((h) => h?.toFixed(2)).join("/")}`)
  process.exit(0)
}
main().catch((error) => { console.error(error); process.exit(1) })
