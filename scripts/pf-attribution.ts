/**
 * Where did the earlier "PF 1.2–1.4" come from? Re-enable each defect that
 * was fixed on 2026-10-07 on the SAME real trades and report the PF.
 *
 *   npx tsx scripts/pf-attribution.ts <bars-dir> <signals-dir> <out-file> [SYMBOL,...]
 *
 * Every captured engine row trades with the engine's own protection
 * (deriveProtectionFromProfitFactor of the row PF) on the venue's real
 * one-minute bars (sparseExits, market execution, 4 h max hold) — the
 * corrected path. The variants then switch one old behaviour back on:
 *
 *  - cost 0.10 %: simulated closes charged PositionCost instead of the
 *    0.26 % round trip;
 *  - gross: no cost at all;
 *  - both-touch = TP: a bar touching stop and target counted as a win
 *    (old forward grading);
 *  - coin flip: the old enforceSimBoundedLifecycle outcome — a win with
 *    probability 0.45 + (PF − 1) · 0.3 (≤ 0.80) from the row's own PF,
 *    booked at TP or SL — instead of the market's exit.
 *
 * Each variant also goes through the Base gate (applyBaseGate, stage PF 1.10,
 * window 25, min 5), the same rule the engine applies.
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
const REAL_COST_PCT = simulatedCloseCostPercent(POSITION_COST_PCT)
const MINUTE_MS = 60_000
const GATE = { minCount: 5, window: 25, stagePf: 1.1 }

/** Deterministic PRNG (mulberry32) so the coin-flip variant is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function coinFlipWinProbability(profitFactor: number): number {
  return Math.min(0.8, Math.max(0, 0.45 + (profitFactor - 1) * 0.3))
}

function book(trades: readonly BacktestTrade[]) {
  let gp = 0, gl = 0, wins = 0
  for (const t of trades) { if (t.netPct > 0) { gp += t.netPct; wins++ } else gl -= t.netPct }
  return {
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    pf: gl > 0 ? gp / gl : gp > 0 ? 99 : null,
    avgNetPct: trades.length ? (gp - gl) / trades.length : null,
  }
}

type Variant = { key: string; label: string; trades: BacktestTrade[] }

async function main() {
  const [barsDir, signalsDir, outFile, symbolArg] = process.argv.slice(2)
  setActiveProtectionFloors({})
  const symbols = symbolArg ? symbolArg.split(",") : readdirSync(signalsDir).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, ""))
  const variants: Variant[] = [
    { key: "corrected", label: "Corrected engine path (real bars, stop first, 0.26 % round trip)", trades: [] },
    { key: "cost010", label: "Old cost: PositionCost 0.10 % charged instead of the round trip", trades: [] },
    { key: "gross", label: "No cost at all (gross move)", trades: [] },
    { key: "bothTp", label: "Old grading: bar touching stop and target = win, 0.10 % cost", trades: [] },
    { key: "coinflip", label: "Old pseudo closes: PF-weighted coin flip at TP/SL, 0.10 % cost", trades: [] },
  ]
  const byKey = new Map(variants.map((v) => [v.key, v]))
  const random = prng(20261007)
  for (const symbol of symbols) {
    const bars = readdirSync(barsDir).filter((n) => n.startsWith(`${symbol}_`) && n.endsWith(".json")).sort()
      .flatMap((n) => JSON.parse(readFileSync(path.join(barsDir, n), "utf8")))
    if (bars.length < 2000) continue
    const index = new Map<number, number>(bars.map((b: any, i: number) => [b.timestamp, i]))
    const captured: ResearchSignal[] = JSON.parse(readFileSync(path.join(signalsDir, `${symbol}.json`), "utf8")).signals
    const signals = captured.map((s) => {
      const protection = deriveProtectionFromProfitFactor(s.profitFactor, POSITION_COST_PCT)
      return { ...s, takeProfitPct: protection.takeProfitPct, stopLossPct: protection.stopLossPct }
    })
    const bySignal = new Map(signals.map((s) => [`${s.type}|${s.direction}|${s.rule}|${s.entryTime}`, s]))
    const result = sparseExits(bars, index, signals, { takeProfitPct: 1, stopLossPct: 1, maxHoldMs: 4 * 3_600_000 })
    for (const c of result.closes) {
      const s = bySignal.get(`${c.type}|${c.direction}|${c.rule}|${c.entryTime}`)!
      const base = {
        symbol, type: c.type, direction: c.direction, rule: c.rule, entryTime: c.entryTime, exitTime: c.exitTime,
        entryPrice: c.entryPrice, exitPrice: c.exitPrice, takeProfitPct: s.takeProfitPct!, stopLossPct: s.stopLossPct!,
        grossPct: c.grossPct, reason: c.reason, exitLeg: "taker" as const,
        profitFactor: s.profitFactor,
      }
      const at = (grossPct: number, costPct: number, reason = c.reason): BacktestTrade =>
        ({ ...base, grossPct, costPct, netPct: grossPct - costPct, reason } as BacktestTrade)
      byKey.get("corrected")!.trades.push(at(c.grossPct, REAL_COST_PCT))
      byKey.get("cost010")!.trades.push(at(c.grossPct, POSITION_COST_PCT))
      byKey.get("gross")!.trades.push(at(c.grossPct, 0))
      // Old forward grading: if the stop bar also reached the target, it was a win.
      let both = false
      if (c.reason === "stop_loss") {
        const bar = bars[index.get(c.exitTime - MINUTE_MS) ?? -1]
        const long = c.direction === "long"
        const target = c.entryPrice * (1 + (long ? 1 : -1) * s.takeProfitPct! / 100)
        both = Boolean(bar) && (long ? bar.high >= target : bar.low <= target)
      }
      byKey.get("bothTp")!.trades.push(both ? at(s.takeProfitPct!, POSITION_COST_PCT, "take_profit") : at(c.grossPct, POSITION_COST_PCT))
      const win = random() < coinFlipWinProbability(s.profitFactor)
      byKey.get("coinflip")!.trades.push(at(win ? s.takeProfitPct! : -s.stopLossPct!, POSITION_COST_PCT, win ? "take_profit" : "stop_loss"))
    }
    console.log(`${symbol}: ${result.closes.length} trades`)
  }
  const rows = variants.map((v) => {
    // The gate's ratio reads each close's net after the cost that variant
    // books (applyBaseGate subtracts the real round trip; add it back).
    const variantCost = v.trades[0]?.costPct ?? REAL_COST_PCT
    const gated = applyBaseGate(v.trades, POSITION_COST_PCT, GATE, (netPct, costPct) => movePctToMainTradePfRatio(netPct + REAL_COST_PCT - variantCost, costPct)).admitted
    return { key: v.key, label: v.label, all: book(v.trades), afterBaseGate: book(gated) }
  })
  const meanRowPf = (() => { const t = byKey.get("corrected")!.trades; return t.reduce((s, x) => s + Number(x.profitFactor || 0), 0) / Math.max(1, t.length) })()
  writeFileSync(outFile, JSON.stringify({ symbols, positionCostPct: POSITION_COST_PCT, realCostPct: REAL_COST_PCT, meanRowPf, rows }, null, 2))
  console.log(`mean row (indication) PF ${meanRowPf.toFixed(3)} → coin-flip win probability ${coinFlipWinProbability(meanRowPf).toFixed(3)}`)
  for (const r of rows) console.log(`${r.key.padEnd(10)} all: n=${r.all.trades} pf=${r.all.pf?.toFixed(3)} win=${((r.all.winRate ?? 0) * 100).toFixed(1)}%  | after Base gate: n=${r.afterBaseGate.trades} pf=${r.afterBaseGate.pf?.toFixed(3)}`)
  process.exit(0)
}
main().catch((error) => { console.error(error); process.exit(1) })
