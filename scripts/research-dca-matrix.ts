#!/usr/bin/env node

/** Offline, reproducible DCA research. No connector, credential or order API. */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runDcaBacktest, type DcaBacktestCandle, type DcaBacktestConfig, type DcaBacktestEntry, type DcaBacktestResult } from "../lib/dca-backtest"
import { normalizeDcaProfile } from "../lib/dca-strategy"

type Plan = {
  evaluationStart: number; evaluationEndExclusive: number; warmupStart: number; selectionEndExclusive: number
  symbols: string[]; timeframes: Array<5 | 15 | 30>; entries: DcaBacktestEntry[]; maxSteps: number[]
  volumeLadders: number[][]; distanceLadders: number[][]; takeProfits: number[]; lastStepStopMultipliers: number[]
  maxHoldMinutes: number; baseRoundTripCostPct: number; stressRoundTripCostPct: number; slippagePct: number
}
type Candidate = { id: number; requestedStopMultipliers: number[]; config: DcaBacktestConfig }
type Metrics = [number, number | null, boolean, number, number, number, number, number, number]
type Row = { id: number; train: Metrics; trainStress: Metrics; holdout?: Metrics; holdoutStress?: Metrics; full?: Metrics; fullStress?: Metrics }

export const metricFields = ["trades", "netProfitFactor", "profitFactorUnbounded", "netPctOfInitialNotional", "adverseDrawdownBoundPctOfInitialNotional", "closedDrawdownPctOfInitialNotional", "maximumVolumeRatio", "positiveCloseActiveHours", "closeActiveHours"]

function metrics(result: DcaBacktestResult, baseCost: number, cost: number): Metrics {
  let equity = 0, peak = 0, closedDd = 0, adverseDd = 0, positive = 0, negative = 0
  const hours = new Map<number, number>()
  for (const trade of result.trades) {
    // Costs do not affect this model's entry/exit decisions. Revalue the
    // identical fills exactly instead of recomputing their price path.
    const net = trade.pnlPctOfInitialNotional - (cost - baseCost) * trade.volumeRatio
    adverseDd = Math.max(adverseDd, peak - equity - Math.min(0, trade.maxAdversePnlPct) + cost * trade.volumeRatio)
    equity += net
    peak = Math.max(peak, equity)
    closedDd = Math.max(closedDd, peak - equity)
    adverseDd = Math.max(adverseDd, closedDd)
    positive += Math.max(0, net); negative += Math.max(0, -net)
    const hour = Math.floor(trade.exitTime / 3_600_000)
    hours.set(hour, (hours.get(hour) || 0) + net)
  }
  const rounded = (value: number) => Number(value.toFixed(9))
  return [result.trades.length, negative > 0 ? rounded(positive / negative) : null, negative === 0 && positive > 0,
    rounded(equity), rounded(adverseDd), rounded(closedDd), rounded(result.maxPositionVolumeRatio),
    [...hours.values()].filter(value => value > 0).length, hours.size]
}

function qualifies(value: Metrics, minimumTrades: number): boolean {
  return value[0] >= minimumTrades && (value[2] || (value[1] ?? 0) >= 1.1) && value[3] > 0 && value[4] <= 5
}

async function main() {
  const directory = resolve(String(process.argv[2] || ""))
  if (!process.argv[2]) throw new Error("Provide a directory containing frozen-plan.json and input.json")
  const planBytes = await readFile(resolve(directory, "frozen-plan.json"))
  const inputBytes = await readFile(resolve(directory, "input.json"))
  const plan = JSON.parse(planBytes.toString()) as Plan
  const data = JSON.parse(inputBytes.toString()) as { start: number; end: number; warmupStart: number; market: Record<string, DcaBacktestCandle[]> }
  if (data.start !== plan.evaluationStart || data.end !== plan.evaluationEndExclusive || data.warmupStart !== plan.warmupStart || data.end - data.start !== 14 * 86_400_000
    || data.start % 86_400_000 || data.end % 86_400_000 || plan.selectionEndExclusive !== data.start + 7 * 86_400_000) {
    throw new Error("Research requires exactly fourteen complete UTC days and a frozen seven/seven split")
  }
  const candidates: Candidate[] = [], byConfig = new Map<string, Candidate>()
  let rawConfigurations = 0
  for (const timeframeMinutes of plan.timeframes) for (const entry of plan.entries) for (const maxSteps of plan.maxSteps)
    for (const volumes of plan.volumeLadders) for (const distances of plan.distanceLadders) for (const takeProfitPct of plan.takeProfits)
      for (const multiple of plan.lastStepStopMultipliers) {
        rawConfigurations++
        const profile = normalizeDcaProfile({ maxSteps, stepVolumeMultipliers: volumes, stepDistancesPct: distances,
          takeProfitMode: "average", breakevenProfitPct: .2, cooldownSeconds: 30,
          maxPositionVolumeRatio: 1 + volumes.slice(0, maxSteps).reduce((sum, value) => sum + value, 0) })
        const lastDistance = profile.stepDistancesPct[maxSteps - 1]
        const config: DcaBacktestConfig = { profile, timeframeMinutes, entry, takeProfitPct,
          stopLossPct: Math.max(lastDistance + .1, lastDistance * multiple), maxHoldMinutes: plan.maxHoldMinutes,
          roundTripCostPct: plan.baseRoundTripCostPct, slippagePct: plan.slippagePct }
        const key = JSON.stringify(config)
        const existing = byConfig.get(key)
        if (existing) { existing.requestedStopMultipliers.push(multiple); continue }
        const candidate = { id: candidates.length, requestedStopMultipliers: [multiple], config }
        candidates.push(candidate); byConfig.set(key, candidate)
      }
  const output = resolve(directory, "results")
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, "configs.json"), JSON.stringify(candidates))
  const summary = {
    inputSha256: createHash("sha256").update(inputBytes).digest("hex"), planSha256: createHash("sha256").update(planBytes).digest("hex"),
    codeSha256: createHash("sha256").update(await readFile(resolve(process.argv[1]))).digest("hex"),
    plan, rawConfigurationsPerSymbol: rawConfigurations, uniqueConfigurationsPerSymbol: candidates.length, metricFields,
    drawdownMethod: "Conservative cumulative PnL drawdown bound using each trade's worst observed intratrade adverse mark and maximum fill costs; closed-trade drawdown is reported separately. Percentage points of initial order notional, not account-equity percentages.",
    costModel: "0.15% all-in round trip at base and0.225% stress, scaled by actual DCA volume; no extra price slippage, funding, partial fills or exchange-minimum model.",
    scope: "Four generic DCA entry rules, 5/15/30-minute bars, steps1–4 and the complete frozen sizing/SL/TP grid. This is not the 135-type indication pipeline, Block/Shared/Overall execution or a live strategy-profitability proof.",
    defaultsPromoted: false,
    symbols: [] as Array<{ symbol: string; qualifyingTraining: number; selectedId: number | null; independentValidationPassed: boolean; selected: Row | null }>,
  }
  for (const symbol of plan.symbols) {
    const windows = new Map<number, { train: DcaBacktestCandle[]; holdout: DcaBacktestCandle[]; full: DcaBacktestCandle[] }>()
    for (const timeframe of plan.timeframes) {
      const candles = data.market[`${symbol}:${timeframe}`]
      const interval = timeframe * 60_000
      if (!candles || candles.length !== (data.end - plan.warmupStart) / interval
        || candles.some((bar, index) => bar.time !== plan.warmupStart + index * interval)) throw new Error(`${symbol}/${timeframe}: incomplete or gapped input`)
      windows.set(timeframe, { full: candles, train: candles.filter(bar => bar.time < plan.selectionEndExclusive),
        holdout: candles.filter(bar => bar.time >= plan.selectionEndExclusive - 2 * 86_400_000) })
    }
    const rows: Row[] = candidates.map(({ id, config }) => {
      const result = runDcaBacktest(windows.get(config.timeframeMinutes)!.train, { ...config, tradeStartTime: plan.evaluationStart })
      return { id, train: metrics(result, plan.baseRoundTripCostPct, plan.baseRoundTripCostPct), trainStress: metrics(result, plan.baseRoundTripCostPct, plan.stressRoundTripCostPct) }
    })
    const qualified = rows.filter(row => qualifies(row.train, 30) && qualifies(row.trainStress, 30))
      .sort((a, b) => a.trainStress[4] - b.trainStress[4] || Number(b.trainStress[2]) - Number(a.trainStress[2])
        || (b.trainStress[1] ?? 0) - (a.trainStress[1] ?? 0) || a.trainStress[6] - b.trainStress[6] || a.id - b.id)
    const selectedId = qualified[0]?.id ?? null
    // Persist the training-only decision before any holdout lifecycle runs.
    await writeFile(resolve(output, `${symbol}-selection-before-holdout.json`), JSON.stringify({ symbol, selectedId, qualifyingTraining: qualified.length, selectedTraining: qualified[0] ?? null }))
    for (const row of rows) {
      const config = candidates[row.id].config, market = windows.get(config.timeframeMinutes)!
      const holdout = runDcaBacktest(market.holdout, { ...config, tradeStartTime: plan.selectionEndExclusive })
      const full = runDcaBacktest(market.full, { ...config, tradeStartTime: plan.evaluationStart })
      row.holdout = metrics(holdout, plan.baseRoundTripCostPct, plan.baseRoundTripCostPct)
      row.holdoutStress = metrics(holdout, plan.baseRoundTripCostPct, plan.stressRoundTripCostPct)
      row.full = metrics(full, plan.baseRoundTripCostPct, plan.baseRoundTripCostPct)
      row.fullStress = metrics(full, plan.baseRoundTripCostPct, plan.stressRoundTripCostPct)
      if (row.id % 128 === 0) {
        const directStress = runDcaBacktest(market.holdout, { ...config, tradeStartTime: plan.selectionEndExclusive, roundTripCostPct: plan.stressRoundTripCostPct })
        const exact = metrics(directStress, plan.stressRoundTripCostPct, plan.stressRoundTripCostPct)
        if (exact.some((value, index) => typeof value === "number" && Math.abs(value - Number(row.holdoutStress![index])) > 1e-7)) throw new Error("Cost-only repricing differs from a direct stress replay")
      }
    }
    const selected = selectedId === null ? null : rows[selectedId]
    if (selectedId !== null) {
      const config = candidates[selectedId].config
      const validation = runDcaBacktest(windows.get(config.timeframeMinutes)!.holdout, { ...config, tradeStartTime: plan.selectionEndExclusive })
      await writeFile(resolve(output, `${symbol}-selected-validation-trades.json`), JSON.stringify({ symbol, selectedId, trades: validation.trades }))
    }
    summary.symbols.push({ symbol, qualifyingTraining: qualified.length, selectedId,
      independentValidationPassed: Boolean(selected && qualifies(selected.holdout!, 12) && qualifies(selected.holdoutStress!, 12)), selected })
    await writeFile(resolve(output, `${symbol}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n")
    await writeFile(resolve(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
    console.log(JSON.stringify(summary.symbols.at(-1)))
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
