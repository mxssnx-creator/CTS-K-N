#!/usr/bin/env tsx
import { createReadStream } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { runDcaBacktest, type DcaBacktestConfig, type DcaBacktestCandle } from "../lib/dca-backtest"
import { normalizeDcaProfile } from "../lib/dca-strategy"

// Audit every qualifying low-drawdown candidate, including candidates outside
// the initial top-100 screen. This uses observed data and cannot promote defaults.
async function main() {
  const output = process.env.DCA_MATRIX_OUTPUT, input = process.env.DCA_BACKTEST_INPUT
  if (!output || !input) throw new Error("Input and output are required")
  const symbols = (process.env.DCA_AUDIT_SYMBOLS || "BCH-USDT,XRP-USDT,SOL-USDT").split(",")
  const configs = JSON.parse(await readFile(join(output, "configs.json"), "utf8")) as DcaBacktestConfig[]
  const data = JSON.parse(await readFile(input, "utf8")) as { end: number; market: Record<string, DcaBacktestCandle[]> }
  const start = data.end - 14 * 86_400_000
  for (const symbol of symbols) {
    const candidates: any[] = []
    for await (const line of createInterface({ input: createReadStream(join(output, `${symbol}.jsonl`)), crlfDelay: Infinity })) {
      const r = JSON.parse(line)
      if (r.train.trades < 30 || r.holdout.trades < 12 || ![r.full, r.train, r.holdout].every(m => m.net > 0 && m.dd <= 5)
        || ![r.train, r.holdout].every(m => m.pfInfinite || (m.pf ?? 0) >= 1.1)) continue
      candidates.push(r)
    }
    candidates.sort((a, b) => Math.max(a.full.dd, a.train.dd, a.holdout.dd) - Math.max(b.full.dd, b.train.dd, b.holdout.dd)
      || a.full.volume - b.full.volume || b.full.net - a.full.net)
    let selected: any = null, passed = 0
    const details: any[] = []
    for (const candidate of candidates) {
      const c = configs[candidate.id]
      const r = runDcaBacktest(data.market[`${symbol}:${c.timeframeMinutes}`].filter(x => x.time >= start - 2 * 86_400_000 && x.time < data.end),
        { ...c, tradeStartTime: start, roundTripCostPct: 0.2, slippagePct: 0.04 })
      const stress = { trades: r.closedTrades, wins: r.wins, losses: r.losses, net: r.netPnlPct, pf: r.profitFactor,
        pfInfinite: r.profitFactorInfinite, dd: r.maxEquityDrawdownPct, volume: r.maxPositionVolumeRatio }
      const stressPassed = stress.trades >= 42 && stress.net > 0 && (stress.pfInfinite || (stress.pf ?? 0) >= 1.1) && stress.dd <= 5
      const result = { ...candidate, config: c, stress, stressPassed }
      if (stressPassed) { passed++; selected ??= result }
      details.push(result)
    }
    const slSweep: any[] = []
    const seed = selected ?? details[0]
    if (seed) for (const maxSteps of [1, 2, 3, 4]) for (const multiple of [1.1, 1.2, 1.35, 1.5, 1.75, 2, 2.5, 3]) {
      const ladder = [0.1, 0.15, 0.2, 0.3]
      const profile = normalizeDcaProfile({ ...seed.config.profile, maxSteps, stepVolumeMultipliers: ladder,
        maxPositionVolumeRatio: 1 + ladder.slice(0, maxSteps).reduce((a, b) => a + b, 0) })
      const last = profile.stepDistancesPct[maxSteps - 1]
      const stopLossPct = Math.max(last + 0.1, last * multiple)
      const c = { ...seed.config, profile, stopLossPct, tradeStartTime: start }
      const candles = data.market[`${symbol}:${c.timeframeMinutes}`].filter(x => x.time >= start - 2 * 86_400_000 && x.time < data.end)
      const r = runDcaBacktest(candles, c)
      const stress = runDcaBacktest(candles, { ...c, roundTripCostPct: 0.2, slippagePct: 0.04 })
      slSweep.push({ maxSteps, requestedMultiple: multiple, effectiveMultiple: stopLossPct / last, stopLossPct,
        volumeLadder: ladder, net: r.netPnlPct, dd: r.maxEquityDrawdownPct, trades: r.closedTrades,
        pf: r.profitFactor, pfInfinite: r.profitFactorInfinite, stressNet: stress.netPnlPct, stressDd: stress.maxEquityDrawdownPct })
    }
    await writeFile(join(output, `${symbol}-cost-audit.json`), JSON.stringify({ symbol, allStrictCandidates: candidates.length,
      stressCandidatesTested: candidates.length, stressCandidatesPassed: passed, lowDrawdownRetrospective: selected,
      bestRetrospectiveBeforeStress: details[0] ?? null, candidates: details, slSweep,
      sweepScope: "14-day sensitivity around selected entry/TP/exit with fixed low-volume ladder [0.1,0.15,0.2,0.3]; 4 steps x 8 requested SL multiples, ordinary and doubled costs; retrospective only",
      independentValidation: false, defaultsPromoted: false }, null, 2))
    console.log(JSON.stringify({ symbol, candidates: candidates.length, passed, selected: selected?.id ?? null }))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
