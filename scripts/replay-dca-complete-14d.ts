#!/usr/bin/env tsx
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { runDcaBacktest, type DcaBacktestConfig, type DcaBacktestCandle, type DcaBacktestEntry, type DcaBacktestResult } from "../lib/dca-backtest"
import { normalizeDcaProfile, type DcaTakeProfitMode } from "../lib/dca-strategy"

const DAY = 86_400_000
const refine = process.env.DCA_MATRIX_MODE === "sl-range"
const symbols = refine ? ["BCH-USDT", "XRP-USDT", "SOL-USDT"] : ["XRP-USDT", "BCH-USDT", "SOL-USDT"]
const slMultiples = [1.1, 1.2, 1.35, 1.5, 1.75, 2, 2.5, 3]
const entries: DcaBacktestEntry[] = ["trend_break", "trend", "break", "momentum", "mean_reversion", "breakout", "relative"]
const volumes = [[0.25, 0.4, 0.55, 0.8], [0.4, 0.6, 0.8, 1.2], [0.5, 0.75, 1, 1.75], [1, 1, 1, 1]]
if (refine) volumes.unshift([0.1, 0.15, 0.2, 0.3])
const distances = [[0.2, 0.4, 0.7, 1.1], [0.3, 0.6, 1, 1.6], [0.4, 0.8, 1.3, 2], [0.55, 1.1, 1.8, 2.8]]

function metrics(r: DcaBacktestResult) {
  const n = (x: number) => Math.round(x * 1e6) / 1e6
  return { trades: r.closedTrades, wins: r.wins, losses: r.losses, net: n(r.netPnlPct), pf: r.profitFactor === null ? null : n(r.profitFactor),
    pfInfinite: r.profitFactorInfinite, dd: n(r.maxEquityDrawdownPct), ddt: n(r.averageDrawdownTimeMin), maxDdt: n(r.maxDrawdownTimeMin),
    grossProfit: n(r.grossProfitPct), grossLoss: n(r.grossLossPct), volume: n(r.maxPositionVolumeRatio),
    long: r.trades.filter(t => t.direction === "long").length, short: r.trades.filter(t => t.direction === "short").length,
    dca: r.trades.filter(t => t.dcaSteps > 0).length, steps: [0, 1, 2, 3, 4].map(step => r.trades.filter(t => t.dcaSteps === step).length) }
}
type Metrics = ReturnType<typeof metrics>
function qualifies(m: Metrics, min: number) { return m.trades >= min && m.net > 0 && (m.pfInfinite || (m.pf ?? 0) >= 1.1) && m.dd <= 10 }

async function main() {
  const input = process.env.DCA_BACKTEST_INPUT
  const output = process.env.DCA_MATRIX_OUTPUT
  if (!input || !output) throw new Error("DCA_BACKTEST_INPUT and DCA_MATRIX_OUTPUT are required")
  const raw = await readFile(input, "utf8")
  const data = JSON.parse(raw) as { end: number; market: Record<string, DcaBacktestCandle[]> }
  const end = data.end, start = end - 14 * DAY, split = start + 10 * DAY
  if (!Number.isFinite(end) || end % DAY) throw new Error("End must be a complete UTC-day boundary")
  const market = new Map<string, { full: DcaBacktestCandle[]; train: DcaBacktestCandle[]; holdout: DcaBacktestCandle[] }>()
  for (const symbol of symbols) for (const tf of [5, 15, 30]) {
    const key = `${symbol}:${tf}`, interval = tf * 60_000
    const rows = data.market[key]?.filter(c => c.time >= start - 2 * DAY && c.time < end)
    if (!rows || rows.length !== 16 * DAY / interval || rows[0].time !== start - 2 * DAY || rows.at(-1)!.time + interval !== end
      || rows.some((c, i) => !Object.values(c).every(Number.isFinite) || c.close <= 0 || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || (i > 0 && c.time - rows[i - 1].time !== interval))) throw new Error(`Invalid/gapped market ${key}`)
    market.set(key, { full: rows, train: rows.filter(c => c.time < split), holdout: rows.filter(c => c.time >= split - 2 * DAY) })
  }
  const configs: DcaBacktestConfig[] = []
  for (const timeframeMinutes of [5, 15, 30] as const) for (const entry of entries)
    for (const stepVolumeMultipliers of volumes) for (const stepDistancesPct of distances)
      for (const takeProfitPct of [0.4, 0.6, 0.8]) for (const buffer of (refine ? slMultiples : [0.35, 0.6]))
        for (const exitMode of ["fixed", "reversal", "cts_g"])
          for (const takeProfitMode of ["average", "first_entry", "breakeven_plus"] as DcaTakeProfitMode[])
            for (const maxSteps of [1, 2, 3, 4]) {
              configs.push({ timeframeMinutes, entry, takeProfitPct, stopLossPct: Math.round((refine ? Math.max(stepDistancesPct[maxSteps - 1] * buffer, stepDistancesPct[maxSteps - 1] + 0.1) : stepDistancesPct[maxSteps - 1] + buffer) * 1e6) / 1e6,
                profile: normalizeDcaProfile({ maxSteps, stepVolumeMultipliers, stepDistancesPct, takeProfitMode,
                  maxPositionVolumeRatio: Math.min(5, 1 + stepVolumeMultipliers.slice(0, maxSteps).reduce((a, b) => a + b, 0)) }),
                roundTripCostPct: 0.1, slippagePct: 0.02, maxHoldMinutes: 720,
                requireDcaDirectionConfirmation: ["trend", "break", "trend_break"].includes(entry),
                exitOnConfirmedReversal: exitMode === "reversal", ctsGExitCoordination: exitMode === "cts_g" })
            }
  // Normalization floors can map multiple requested SL ranges to the same executed profile.
  const seen = new Set<string>()
  for (let i = 0; i < configs.length;) {
    const key = JSON.stringify(configs[i])
    if (seen.has(key)) configs.splice(i, 1)
    else { seen.add(key); i++ }
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "configs.json"), JSON.stringify(configs))
  const summaries = []
  for (const symbol of symbols) {
    const stream = createWriteStream(join(output, `${symbol}.jsonl`))
    let positive = 0, qualified = 0
    const candidates: { id: number; train: Metrics; holdout: Metrics; full: Metrics }[] = []
    let selected: { id: number; train: Metrics; holdout: Metrics; full: Metrics } | null = null
    for (let id = 0; id < configs.length; id++) {
      const c = configs[id], rows = market.get(`${symbol}:${c.timeframeMinutes}`)!
      const fullResult = runDcaBacktest(rows.full, { ...c, tradeStartTime: start })
      const full = metrics(fullResult), train = metrics(runDcaBacktest(rows.train, { ...c, tradeStartTime: start })), holdout = metrics(runDcaBacktest(rows.holdout, { ...c, tradeStartTime: split }))
      const daily = Array.from({ length: 14 }, () => ({ trades: 0, net: 0 }))
      for (const t of fullResult.trades) {
        if (t.entryTime < start || t.exitTime >= end) throw new Error("Trade outside exact test window")
        const day = Math.floor((t.exitTime - start) / DAY); daily[day].trades++; daily[day].net += t.pnlPctOfInitialNotional
      }
      if (Math.abs(daily.reduce((n, d) => n + d.net, 0) - fullResult.netPnlPct) > 1e-7) throw new Error("Daily results do not reconcile")
      if (full.net > 0) positive++
      if (qualifies(train, 30) && qualifies(holdout, 12)) {
        qualified++
        if (full.net > 0 && full.dd <= 5) {
          candidates.push({ id, train, holdout, full })
          candidates.sort((a, b) => Math.max(a.full.dd, a.train.dd, a.holdout.dd) - Math.max(b.full.dd, b.train.dd, b.holdout.dd) || a.full.volume - b.full.volume || b.full.net - a.full.net)
          if (candidates.length > 100) candidates.pop()
        }
      }
      // Selection consumes training only. Holdout is used solely after selection.
      if (qualifies(train, 30) && (!selected || train.dd < selected.train.dd || (train.dd === selected.train.dd && train.net > selected.train.net))) selected = { id, train, holdout, full }
      if (!stream.write(JSON.stringify({ id, full, train, holdout, daily }) + "\n")) await once(stream, "drain")
      if (id % 1000 === 0) { console.error(`${symbol}: ${id}/${configs.length}`); await new Promise<void>(resolve => setImmediate(resolve)) }
    }
    stream.end(); await once(stream, "finish")
    const stressedCandidates = candidates.map(candidate => {
      const c = configs[candidate.id], rows = market.get(`${symbol}:${c.timeframeMinutes}`)!
      const stress = metrics(runDcaBacktest(rows.full, { ...c, tradeStartTime: start, roundTripCostPct: 0.2, slippagePct: 0.04 }))
      const passed = qualifies(stress, 42) && stress.dd <= 5
      return { ...candidate, stress, stressPassed: passed, config: c }
    })
    summaries.push({ symbol, lowDrawdownRetrospective: stressedCandidates.find(c => c.stressPassed) ?? null,
      stressCandidatesTested: stressedCandidates.length, stressCandidatesPassed: stressedCandidates.filter(c => c.stressPassed).length,
      profiles: configs.length, positive14d: positive, descriptiveTrainAndHoldoutPassed: qualified, selected, selectedHoldoutPassed: selected ? qualifies(selected.holdout, 12) : false })
    await writeFile(join(output, "checkpoint.json"), JSON.stringify(summaries, null, 2))
  }
  await writeFile(join(output, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), start, end, split, days: 14, trainDays: 10, holdoutDays: 4,
    sourceSha256: createHash("sha256").update(raw).digest("hex"), configs: configs.length, symbolConfigRuns: configs.length * symbols.length,
    optimization: refine ? "Retrospective SL refinement on an already observed 14-day window; split is reused, not independent confirmation" : "Initial training-only selection followed by holdout",
    slMultiples: refine ? slMultiples : null,
    priority: "positive train and validation segments, full drawdown <=5, lowest worst-segment drawdown first, lower exposure tie-break, doubled fee/slippage stress; no promotion",
    costs: { roundTripFeePct: 0.1, slippagePctPerFill: 0.02, fundingIncluded: false },
    units: "fixed initial unlevered notional percentage points; independent lanes, not account returns",
    covered: refine ? "7 entry modes x 3 timeframes x 5 volume ladders x 4 distance ladders x 3 TP values x 8 requested final-SL multiples x 3 exits x 3 TP modes x 4 step limits; normalized duplicates removed; BCH first, then XRP and SOL" : "Complete stated grid: 7 entry modes, 3 timeframes, 4 volume ladders, 4 distance ladders, 3 TP values, 2 SL buffers, 3 exit modes, 3 DCA TP modes, 4 step limits; each for XRP/BCH/SOL",
    excluded: "Not an enumeration of every continuous slider value; separate Main/Preset/Signals/Direct/Special and full Block/live coordination are not represented by this DCA model. No exchange fills, funding or mainnet qualification.",
    defaultsPromoted: false, summaries }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
