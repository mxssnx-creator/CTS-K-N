#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { runDcaBacktest, type DcaBacktestConfig, type DcaBacktestResult, type DcaBacktestCandle, type DcaBacktestEntry } from "../lib/dca-backtest"
import { normalizeDcaProfile } from "../lib/dca-strategy"

const symbols = ["XRP-USDT", "BCH-USDT", "SOL-USDT"]
const day = 86_400_000
const hour = 3_600_000
const volumes = [[0.25, 0.4, 0.55, 0.8], [0.4, 0.6, 0.8, 1.2], [0.5, 0.75, 1, 1.75], [1, 1, 1, 1]]
const distances = [[0.2, 0.4, 0.7, 1.1], [0.3, 0.6, 1, 1.6], [0.4, 0.8, 1.3, 2], [0.55, 1.1, 1.8, 2.8]]
const entries: DcaBacktestEntry[] = ["trend_break", "trend", "break", "momentum", "mean_reversion", "breakout", "relative"]

function metrics(results: DcaBacktestResult[]) {
  const closedTrades = results.reduce((n, r) => n + r.closedTrades, 0)
  const profit = results.reduce((n, r) => n + r.grossProfitPct, 0)
  const loss = results.reduce((n, r) => n + r.grossLossPct, 0)
  return {
    closedTrades, netPnlPct: profit - loss, profitFactor: loss > 0 ? profit / loss : null,
    profitFactorInfinite: loss === 0 && profit > 0,
    worstSymbolNetPnlPct: Math.min(...results.map(r => r.netPnlPct)),
    maximumSymbolDrawdownPct: Math.max(...results.map(r => r.maxEquityDrawdownPct)),
    averageDrawdownMinutes: closedTrades ? results.reduce((n, r) => n + r.averageDrawdownTimeMin * r.closedTrades, 0) / closedTrades : 0,
    maximumVolumeRatio: Math.max(...results.map(r => r.maxPositionVolumeRatio)),
    dcaPositions: results.reduce((n, r) => n + r.trades.filter(t => t.dcaSteps > 0).length, 0),
    worstTradePct: Math.min(0, ...results.flatMap(r => r.trades.map(t => t.pnlPctOfInitialNotional))),
  }
}
type Metrics = ReturnType<typeof metrics>
function qualified(m: Metrics, minTrades: number): boolean {
  return m.closedTrades >= minTrades && m.netPnlPct > 0 && m.worstSymbolNetPnlPct >= 0
    && (m.profitFactorInfinite || Number(m.profitFactor) >= 1.1)
    && m.maximumSymbolDrawdownPct <= 10 && m.worstTradePct >= -6 && m.dcaPositions > 0
}
/** A short rolling window is useful for live adaptation, but must still have
 * enough closed trades to avoid promoting a single lucky fill. */
function qualifiedRolling(m: Metrics, minTrades = 2): boolean {
  return m.closedTrades >= minTrades && m.netPnlPct > 0
    && (m.profitFactorInfinite || Number(m.profitFactor) >= 1.05)
    && m.maximumSymbolDrawdownPct <= 8 && m.worstTradePct >= -6 && m.dcaPositions > 0
}

function compareMetrics(a: Metrics, b: Metrics, minTrades: number, shortWindow = false): number {
  const qualifies = (value: Metrics) => shortWindow
    ? qualifiedRolling(value, minTrades)
    : qualified(value, minTrades)
  return Number(qualifies(b)) - Number(qualifies(a))
    || a.maximumSymbolDrawdownPct - b.maximumSymbolDrawdownPct
    || a.averageDrawdownMinutes - b.averageDrawdownMinutes
    || b.netPnlPct - a.netPnlPct
}

function exitMode(config: DcaBacktestConfig): "fixed" | "reversal" | "cts_g" {
  if (config.ctsGExitCoordination) return "cts_g"
  if (config.exitOnConfirmedReversal) return "reversal"
  return "fixed"
}

function mode<T extends string | number>(values: T[], fallback: T): T {
  if (values.length === 0) return fallback
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  return values.reduce((best, value) => (counts.get(value)! > counts.get(best)! ? value : best), values[0])
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

type RankedCandidate = {
  config: DcaBacktestConfig
  train: Metrics
  perSymbolTrain: Metrics[]
  rolling20h: Metrics
  perSymbol20h: Metrics[]
}

function averageBestConfig(rows: RankedCandidate[]): DcaBacktestConfig | null {
  if (rows.length === 0) return null
  const configs = rows.map(row => row.config)
  const profiles = configs.map(config => config.profile)
  const timeframeMinutes = mode(configs.map(config => config.timeframeMinutes), 15 as const)
  const entry = mode(configs.map(config => config.entry), "trend_break" as const)
  const modes = mode(configs.map(exitMode), "cts_g" as const)
  const profile = normalizeDcaProfile({
    maxSteps: Math.round(mean(profiles.map(value => value.maxSteps))),
    stepVolumeMultipliers: [0, 1, 2, 3].map(index => mean(profiles.map(value => value.stepVolumeMultipliers[index]))),
    stepDistancesPct: [0, 1, 2, 3].map(index => mean(profiles.map(value => value.stepDistancesPct[index]))),
    maxPositionVolumeRatio: mean(profiles.map(value => value.maxPositionVolumeRatio)),
    takeProfitMode: "average",
    breakevenProfitPct: mean(profiles.map(value => value.breakevenProfitPct)),
    cooldownSeconds: Math.round(mean(profiles.map(value => value.cooldownSeconds))),
  })
  return {
    profile,
    timeframeMinutes,
    entry,
    takeProfitPct: mean(configs.map(config => config.takeProfitPct)),
    stopLossPct: mean(configs.map(config => config.stopLossPct)),
    roundTripCostPct: mean(configs.map(config => config.roundTripCostPct || 0.1)),
    slippagePct: mean(configs.map(config => config.slippagePct || 0.02)),
    maxHoldMinutes: mean(configs.map(config => config.maxHoldMinutes || 720)),
    requireDcaDirectionConfirmation: ["trend", "break", "trend_break"].includes(entry),
    exitOnConfirmedReversal: modes === "reversal",
    ctsGExitCoordination: modes === "cts_g",
  }
}

function configDistance(config: DcaBacktestConfig, average: DcaBacktestConfig): number {
  const profile = config.profile
  const target = average.profile
  const profileDistance = profile.stepVolumeMultipliers.reduce((sum, value, index) =>
    sum + Math.abs(value - target.stepVolumeMultipliers[index]), 0)
    + profile.stepDistancesPct.reduce((sum, value, index) => sum + Math.abs(value - target.stepDistancesPct[index]), 0)
  return Math.abs(config.timeframeMinutes - average.timeframeMinutes) * 0.05
    + (config.entry === average.entry ? 0 : 2)
    + (exitMode(config) === exitMode(average) ? 0 : 0.5)
    + Math.abs(config.takeProfitPct - average.takeProfitPct)
    + Math.abs(config.stopLossPct - average.stopLossPct) * 0.25
    + profileDistance
}
// Risk first among viable profiles. Holdout data is never used in this ordering.
function compare(a: { train: Metrics; config: DcaBacktestConfig }, b: typeof a) {
  return Number(qualified(b.train, 42)) - Number(qualified(a.train, 42))
    || a.train.maximumSymbolDrawdownPct - b.train.maximumSymbolDrawdownPct
    || a.train.averageDrawdownMinutes - b.train.averageDrawdownMinutes
    || b.train.netPnlPct - a.train.netPnlPct
}

async function main() {
  const inputPath = process.env.DCA_BACKTEST_INPUT
  const outputPath = process.env.DCA_BACKTEST_OUTPUT
  if (!inputPath || !outputPath) throw new Error("DCA_BACKTEST_INPUT and DCA_BACKTEST_OUTPUT are required")
  const raw = await readFile(inputPath, "utf8")
  const data = JSON.parse(raw) as { start: number; end: number; market: Record<string, DcaBacktestCandle[]> }
  if (data.end - data.start !== 20 * day) throw new Error("The input must contain exactly 20 complete days")
  const split = data.start + 14 * day
  const train = new Map<string, DcaBacktestCandle[]>()
  const heldout = new Map<string, DcaBacktestCandle[]>()
  const rolling = new Map<string, DcaBacktestCandle[]>()
  const rollingStart = data.end - 20 * hour
  for (const symbol of symbols) for (const tf of [5, 15, 30]) {
    const key = `${symbol}:${tf}`
    const rows = data.market[key]
    if (!rows?.length || rows[0].time > data.start - day || rows[rows.length-1].time + tf * 60000 !== data.end)
      throw new Error(`Missing or incomplete history: ${key}`)
    train.set(key, rows.filter(c => c.time < split))
    heldout.set(key, rows.filter(c => c.time >= split - 2 * day))
    // Include two days of indicator warmup, while tradeStartTime below keeps
    // every measured entry inside the exact trailing 20-hour window.
    rolling.set(key, rows.filter(c => c.time >= rollingStart - 2 * day))
  }
  const candidates: DcaBacktestConfig[] = []
  for (const timeframeMinutes of [5, 15, 30] as const) for (const entry of entries)
    for (const stepVolumeMultipliers of volumes) for (const stepDistancesPct of distances)
      for (const takeProfitPct of [0.4, 0.6, 0.8]) for (const buffer of [0.35, 0.6])
        for (const exitMode of ["fixed", "reversal", "cts_g"] as const) {
          const profile = normalizeDcaProfile({ maxSteps: 4, stepVolumeMultipliers, stepDistancesPct,
            maxPositionVolumeRatio: 1 + stepVolumeMultipliers.reduce((a,b) => a+b, 0), takeProfitMode: "average" })
          candidates.push({ profile, timeframeMinutes, entry, takeProfitPct, stopLossPct: stepDistancesPct[3]+buffer,
            roundTripCostPct: 0.1, slippagePct: 0.02, maxHoldMinutes: 720,
            requireDcaDirectionConfirmation: ["trend", "break", "trend_break"].includes(entry), exitOnConfirmedReversal: exitMode === "reversal", ctsGExitCoordination: exitMode === "cts_g" })
        }
  const ranked: RankedCandidate[] = candidates.map((config, index) => {
    const results = symbols.map(symbol => runDcaBacktest(train.get(`${symbol}:${config.timeframeMinutes}`)!, { ...config, tradeStartTime: data.start }))
    const rollingResults = symbols.map(symbol => runDcaBacktest(rolling.get(`${symbol}:${config.timeframeMinutes}`)!, { ...config, tradeStartTime: rollingStart }))
    if (index % 500 === 0) process.stderr.write(`Training ${index}/${candidates.length}\n`)
    return {
      config,
      train: metrics(results),
      perSymbolTrain: results.map(r => metrics([r])),
      rolling20h: metrics(rollingResults),
      perSymbol20h: rollingResults.map(r => metrics([r])),
    }
  }).sort(compare)
  const evaluate = (candidate: typeof ranked[number] | undefined, selectedSymbols = symbols, selectionMode = "training-only") => {
    if (!candidate) return null
    const heldoutResults = selectedSymbols.map(symbol => runDcaBacktest(heldout.get(`${symbol}:${candidate.config.timeframeMinutes}`)!, { ...candidate.config, tradeStartTime: split }))
    const fullResults = selectedSymbols.map(symbol => runDcaBacktest(data.market[`${symbol}:${candidate.config.timeframeMinutes}`], { ...candidate.config, tradeStartTime: data.start }))
    const rollingResults = selectedSymbols.map(symbol => runDcaBacktest(rolling.get(`${symbol}:${candidate.config.timeframeMinutes}`)!, { ...candidate.config, tradeStartTime: rollingStart }))
    const validation = metrics(heldoutResults)
    return { config: candidate.config, train: candidate.train, rolling20h: metrics(rollingResults), heldout: validation, full20Days: metrics(fullResults),
      historicalMetricsPassed: qualified(validation, selectedSymbols.length === 1 ? 6 : 18),
      validationPassed: selectionMode === "training-only" && qualified(validation, selectedSymbols.length === 1 ? 6 : 18),
      selectionMode,
      holdoutOverlapsSelection: selectionMode !== "training-only",
      symbols: selectedSymbols.map((symbol, i) => ({ symbol, rolling20h: metrics([rollingResults[i]]), heldout: metrics([heldoutResults[i]]), full20Days: metrics([fullResults[i]]) })) }
  }
  const best = ranked.find(c => qualified(c.train, 42))
  const bestTrendBreak = ranked.find(c => ["trend", "break", "trend_break"].includes(c.config.entry) && qualified(c.train, 42))
  const perSymbolSelections = symbols.map((symbol, symbolIndex) => {
    const rows = ranked.map(candidate => ({
      ...candidate,
      train: candidate.perSymbolTrain[symbolIndex],
      rolling20h: candidate.perSymbol20h[symbolIndex],
    }))
    const viable = rows.filter(candidate => qualified(candidate.train, 8) && qualifiedRolling(candidate.rolling20h, 2))
    const ordered = [...(viable.length ? viable : rows)].sort((a, b) =>
      compareMetrics(a.rolling20h, b.rolling20h, 2, true)
        || compareMetrics(a.train, b.train, 8, false))
    return { symbol, candidate: ordered[0], viableCount: viable.length }
  })
  const selectedRows = perSymbolSelections.flatMap(value => value.candidate ? [value.candidate] : [])
  const averaged = averageBestConfig(selectedRows)
  const nearestAverage = averaged
    ? ranked.slice().sort((a, b) => configDistance(a.config, averaged) - configDistance(b.config, averaged))[0]
    : undefined
  const averagedEvaluation = evaluate(nearestAverage, symbols, "rolling20h")
  const historicalCandidateGate = selectedRows.length === symbols.length
    && perSymbolSelections.every(value => value.viableCount > 0)
    && Boolean(averagedEvaluation)
    && averagedEvaluation!.symbols.every(value => qualified(value.heldout, 6))
    && averagedEvaluation!.heldout.netPnlPct > 0
    && averagedEvaluation!.heldout.maximumSymbolDrawdownPct <= 10
  // The dynamic selection consumes the last 20h, which overlap the 6d
  // holdout. That holdout is descriptive for dynamic/averaged candidates,
  // not independent validation. No automatic promotion without forward data.
  const defaultsGate = false
  const defaultsPath = process.env.DCA_DEFAULTS_OUTPUT || `${outputPath}.defaults.json`
  const defaultsArtifact = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    active: defaultsGate,
    policy: "candidate only; the latest-20h selection overlaps the 6d holdout. Every symbol must pass historical gates and an untouched forward window before production defaults can change.",
    symbols,
    averageBestConfig: averaged,
    selectedGridConfig: averagedEvaluation?.config || null,
    quality: {
      perSymbol: perSymbolSelections.map(value => ({
        symbol: value.symbol,
        viableCount: value.viableCount,
        rolling20h: value.candidate?.rolling20h || null,
        train14d: value.candidate?.train || null,
      })),
      selectedHoldout: averagedEvaluation?.heldout || null,
      historicalCandidateGate,
      independentForwardValidationAvailable: false,
      gate: defaultsGate,
    },
  }
  await writeFile(defaultsPath, JSON.stringify(defaultsArtifact, null, 2) + "\n")
  const report = {
    generatedAt: new Date().toISOString(), historyDays: 20, symbols,
    source: "BingX public swap v3 klines", sourceSha256: createHash("sha256").update(raw).digest("hex"),
    rangeStart: new Date(data.start).toISOString(), rangeEndExclusive: new Date(data.end).toISOString(),
    trainDays: 14, holdoutDays: 6, split: new Date(split).toISOString(), candidateCount: candidates.length,
    units: "PnL and drawdown are percentage points of fixed initial unlevered notional per symbol; aggregate PnL is their sum, not account return. Drawdown includes open adverse marks.",
    costModel: { roundTripFeePct: 0.1, slippagePctPerFill: 0.02, fundingIncluded: false, intrabar: "pre-existing protective stop first, existing TP next; DCA-adjusted TP effective next bar" },
    selection: "Global selected and selectedTrendBreak profiles rank only 14d training: positive results, PF>=1.1, every symbol nonnegative, DD<=10, worst trade>=-6 and actual DCA fills; then lowest DD, shortest drawdown, highest net profit. Their 6d holdout is untouched. Per-symbol/average profiles also select on the last20h; their 6d figures overlap selection and are descriptive, not out-of-sample validation.",
    qualifiedTrainingCount: ranked.filter(c => qualified(c.train, 42)).length,
    selected: evaluate(best), selectedTrendBreak: evaluate(bestTrendBreak),
    rolling20hStart: new Date(rollingStart).toISOString(),
    rolling20hSelection: "Per-symbol selection requires positive net, PF>=1.05, DD<=8, worst trade>=-6 and at least two closed DCA trades; 14-day training also requires positive net, PF>=1.1, DD<=10 and at least eight trades.",
    defaultsPath,
    defaultsSaved: defaultsGate,
    averageBest: averagedEvaluation,
    perSymbol: perSymbolSelections.map(value => ({ symbol: value.symbol, viableCount: value.viableCount, selected: value.candidate ? evaluate(value.candidate, [value.symbol], "rolling20h") : null })),
    trainingLeaders: ranked.slice(0, 10).map(c => ({ config: c.config, train: c.train, rolling20h: c.rolling20h, qualified: qualified(c.train, 42) })),
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n")
  process.stdout.write(JSON.stringify({ outputPath, defaultsPath, defaultsSaved: defaultsGate, candidateCount: candidates.length, qualifiedTrainingCount: report.qualifiedTrainingCount,
    selected: report.selected, selectedTrendBreak: report.selectedTrendBreak, averageBest: report.averageBest, perSymbol: report.perSymbol }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
