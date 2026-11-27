import { readFileSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { COMMON_INDICATOR_DEFINITIONS, DEFAULT_COMMON_INDICATION_SETTINGS, commonIndicatorParameterConfigurations, type CommonIndicatorSettings } from "@/lib/common-indicator-config"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { resampleNormalizedCandles } from "@/lib/common-indicators/kn-math"
import { COMMON_RULES, commonRuleStates } from "@/lib/common-indicators/registry"
import { createHistoricCandleSimulator, HISTORIC_TEST_SIMULATED_FAMILIES, type HistoricCandleSimulatorOptions } from "@/lib/historic-test-replay"
import type { HistoricTestStrategyFamily } from "@/lib/historic-test-settings"
import { normalizeSignalIndicationSettings } from "@/lib/signal-indication"
import { replaySignalSourceOutcomes } from "@/lib/signal-source-optimizer"
import { ALL_SIGNAL_SOURCE_DEFINITIONS, signalSourceSupportsSymbol } from "@/lib/signal-source-registry"
import { backtestSpecialStrategy, type SpecialBacktestTrade } from "@/lib/special-strategy"
import { deriveAdaptiveTrendProtection, deriveProtectionFromActiveOutbreak, deriveProtectionFromProfitFactor, deriveProtectionFromSpecial } from "@/lib/strategy-coordinator"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import { replayDirectIndicationTypes } from "@/lib/trade-engine/prehistoric-type-replay"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import { simulateGeneralTrailingExit, TRAILING_ACTIVATION_TP_SHARE } from "@/lib/trailing-activation"
import { DAY, MINUTE, loadReplayCandles, type ReplayPeriod } from "./replay-market-input"

const COST = roundTripCostPercent()
const STRESS = roundTripCostPercent({ takerFeeFraction: 0.001, slippageFraction: 0.0006 })
const POSITION_COST = 0.1
const HOUR = 60 * MINUTE
const TIMEFRAMES = [1, 5, 15, 30] as const
const COMMON_BATCH_SIZE = 96
const DIRECTIONS = ["long", "short"] as const
const PROFILES = [
  { name: "micro", tp: 0.3, sl: 0.6, hold: 15 },
  { name: "minimal", tp: 0.5, sl: 0.6, hold: 45 },
  { name: "short", tp: 0.9, sl: 0.6, hold: 120 },
  { name: "normal", tp: 1.5, sl: 0.9, hold: 180 },
  { name: "wide", tp: 2.0, sl: 1.2, hold: 240 },
  { name: "long", tp: 2.6, sl: 1.6, hold: 240 },
]
const INDICATIONS = ["momentum", "breakout", "mean_reversion", "relative"]

type Close = { when: number; earlier: number; base: number; stress: number }
type Score = [positions: number, wins: number, losses: number, drawdown: number, positiveHours: number, activeHours: number]
type Identity = { kind: "common" | "direct" | "family" | "signal"; name: string; config: string; range: string; side: string; tf?: number }
type Row = { id: Identity; scores: Score[] }
const empty = (): Score => [0, 0, 0, 0, 0, 0]

function summarize(closes: Close[], start: number, end: number, cost: "base" | "stress"): Score {
  const result = empty()
  let equity = 0, peak = 0
  const hours = new Map<number, number>()
  for (const trade of closes) {
    if (trade.earlier < start || trade.when >= end) continue
    const pnl = trade[cost]
    result[0]++
    result[1] += Math.max(0, pnl)
    result[2] += Math.max(0, -pnl)
    equity += pnl
    peak = Math.max(peak, equity)
    result[3] = Math.max(result[3], (peak - equity) / (10000 + peak) * 100)
    const hour = Math.floor(trade.when / HOUR)
    hours.set(hour, (hours.get(hour) || 0) + pnl)
  }
  result[4] = [...hours.values()].filter(value => value > 0).length
  result[5] = hours.size
  return result
}

const specialOnly = process.argv.includes("--special-only")
const [inputPath, outputPath, symbolsArg, periodArg] = process.argv.slice(2).filter(value => value !== "--special-only")
if (!inputPath || !outputPath) throw new Error("Expected STUDY.json RESULTS.json [SYMBOLS] [PERIOD_INDEX] [--special-only]")
const allowedSymbols = symbolsArg && new Set(symbolsArg.split(","))
const allPeriods: ReplayPeriod[] = JSON.parse(readFileSync(inputPath, "utf8"))
const periods = periodArg === undefined ? allPeriods : allPeriods.filter((_, index) => index === Number(periodArg))
if (periods.length === 0) throw new Error("No matching UTC periods")
const configurations = COMMON_INDICATOR_DEFINITIONS.flatMap(definition => {
  const rule = COMMON_RULES.get(definition.type)
  if (!rule) throw new Error(`Missing Common rule for ${definition.type}`)
  const settings = DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings
  return commonIndicatorParameterConfigurations(definition, settings).map(params => ({ definition, rule, params, config: JSON.stringify(params) }))
})
const signalSettings = normalizeSignalIndicationSettings({})

async function main() {
  const started = performance.now()
  const studies = []
  for (const period of periods) {
    const { begin, warmupEnd, end } = period
    if (warmupEnd - begin !== 2 * DAY || end - warmupEnd !== 2 * DAY || begin % DAY !== 0) {
      throw new Error(`Expected two complete warm-up days and two complete measured days for ${period.name}`)
    }
    const rows = new Map<string, Row>()
    const book = (row: Row, base: Close[], stress: Close[]) => {
      if (base.length === 0 && stress.length === 0) return
      const scores = [summarize(base, begin, warmupEnd, "base"), summarize(stress, begin, warmupEnd, "stress"),
        summarize(base, warmupEnd, end, "base"), summarize(stress, warmupEnd, end, "stress")]
      scores.forEach((s, i) => s.forEach((v, j) => { row.scores[i][j] = j === 3 ? Math.max(row.scores[i][j], v) : row.scores[i][j] + v }))
    }
    const add = (id: Identity, base: Close[], stress = base) => {
      const key = JSON.stringify(id)
      let row = rows.get(key)
      if (!row) {
        row = { id, scores: [empty(), empty(), empty(), empty()] }
        rows.set(key, row)
      }
      book(row, base, stress)
    }
    const commonRows: Row[][] = specialOnly ? [] : TIMEFRAMES.map(tf => configurations.flatMap(({ definition, config }) =>
      PROFILES.flatMap(profile => DIRECTIONS.map(side => ({
        id: { kind: "common", name: definition.type, config, tf, range: profile.name, side },
        scores: [empty(), empty(), empty(), empty()],
      }))),
    ))
    const markets = period.markets.filter(market => !allowedSymbols || allowedSymbols.has(market.symbol))
    if (markets.length === 0) throw new Error(`No matching markets for ${period.name}`)
    for (const market of markets) {
      const candles = loadReplayCandles(market, period)
      if (specialOnly) {
        const series = [{ symbol: market.symbol, closes: candles.map(bar => bar.close), volumes: candles.map(bar => bar.volume),
          timestamps: candles.map(bar => bar.time + MINUTE) }]
        for (const trailingEnabled of [false, true]) {
          const run = (roundTripCostPct: number) => backtestSpecialStrategy({ series, positionCostPct: POSITION_COST,
            settings: { trailingEnabled, timeframe15sEnabled: false, roundTripCostPct } }).trades
          const base = run(COST)
          const stress = run(STRESS)
          for (const side of DIRECTIONS) {
            const closes = (trades: SpecialBacktestTrade[]) => trades
              .filter(trade => trade.direction === side && trade.exitReason !== "end_of_series")
              .map(trade => ({ earlier: trade.entryTimestamp!, when: trade.exitTimestamp!, base: trade.pnlPct, stress: trade.pnlPct }))
            add({ kind: "family", name: "special", config: trailingEnabled ? "trailing" : "fixed", range: "native", side, tf: 1 },
              closes(base), closes(stress))
          }
        }
        process.stderr.write(`${period.name} ${market.symbol} Special completed\n`)
        continue
      }
      const bars = candles.map(candle => ({ ...candle, timestamp: candle.time }))
      // Same signal timestamp, side and bracket have the same physical exit.
      // Reuse those bounded paths across every Common parameter tuple and timeframe.
      const brackets = PROFILES.map(profile => DIRECTIONS.map(direction => candles.map((bar, i): Close | null => {
        const exit = simulateGeneralTrailingExit({
          direction, entryPrice: bar.close, bars: candles, fromIndex: i + 1, toIndexExclusive: i + profile.hold + 1,
          takeProfitPct: profile.tp, stopLossPct: profile.sl, startRatio: 0, stopRatio: 0,
          activationMode: TRAILING_ACTIVATION_TP_SHARE, trailingEnabled: false,
        })
        if (!exit && i + profile.hold >= candles.length) return null
        const later = exit ? candles[exit.index] : candles[i + profile.hold]
        const gross = ((exit?.price ?? later.close) / bar.close - 1) * (direction === "long" ? 100 : -100)
        return { when: later.time + MINUTE, earlier: bar.time + MINUTE, base: gross - COST, stress: gross - STRESS }
      })))

      for (const [tfIndex, tf] of TIMEFRAMES.entries()) {
        const sampled = resampleNormalizedCandles(bars, tf)
        for (let first = 0; first < configurations.length; first += COMMON_BATCH_SIZE) {
          const ctx = createCommonSeriesContext(sampled, { normalized: true, tfMin: tf })
          for (let configIndex = first; configIndex < Math.min(first + COMMON_BATCH_SIZE, configurations.length); configIndex++) {
            const { rule, params } = configurations[configIndex]
            const states = commonRuleStates(ctx, rule, params)
            const signalIndices: [number[], number[]] = [[], []]
            for (let i = 0; i < states.length; i++) {
              if (!states[i]) continue
              const index = (sampled[i].timestamp - begin) / MINUTE + tf - 1
              if (index >= 0 && index < candles.length) signalIndices[states[i] === 1 ? 0 : 1].push(index)
            }
            brackets.forEach((profile, profileIndex) => profile.forEach((exits, directionIndex) => {
              const trades: Close[] = []
              let availableAfter = 0
              for (const index of signalIndices[directionIndex]) {
                const close = exits[index]
                if (!close || close.earlier <= availableAfter) continue
                trades.push(close)
                availableAfter = close.when
              }
              const index = (configIndex * PROFILES.length + profileIndex) * DIRECTIONS.length + directionIndex
              book(commonRows[tfIndex][index], trades, trades)
            }))
          }
        }
      }

      const direct = await replayDirectIndicationTypes({
        symbol: market.symbol, bars, rangeStartMs: begin, rangeEndMs: end,
        indicationSettings: { commonIndicatorTypes: COMMON_INDICATOR_DEFINITIONS
          .filter(definition => (DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings).enabled)
          .map(definition => definition.type) },
        positionCostPct: POSITION_COST,
        protectionFor: ({ type, profitFactor, row }) => {
          const meta = row?.metadata
          return (type === "trend" ? deriveAdaptiveTrendProtection(meta?.adaptiveTpRange?.factors, POSITION_COST) :
            type === "active" ? deriveProtectionFromActiveOutbreak(meta?.activeProtection) :
              type === "special" ? deriveProtectionFromSpecial(meta?.specialPositionPlan?.protection) : null)
            ?? deriveProtectionFromProfitFactor(profitFactor, POSITION_COST)
        },
        stepIndicatorSeries: (candles, minutes) => StepBasedIndicators.createSummarySeries(candles, minutes),
      })
      const directCloses = new Map<string, { id: Identity; closes: Close[] }>()
      for (const trade of direct.closes) {
        const id: Identity = { kind: "direct", name: trade.type, config: trade.rule, range: "native", side: trade.direction }
        const key = JSON.stringify(id)
        let group = directCloses.get(key)
        if (!group) directCloses.set(key, group = { id, closes: [] })
        group.closes.push({ earlier: trade.entryTime, when: trade.exitTime, base: trade.grossPct - COST, stress: trade.grossPct - STRESS })
      }
      for (const group of directCloses.values()) add(group.id, group.closes)

      const priceBars = resampleNormalizedCandles(bars, 15).map(bar => ({ ...bar, time: bar.timestamp + 15 * MINUTE - 1 }))
      const familyOptions = { loadCandles: async () => priceBars, timeframeMinutes: 15 as const, maxHoldMinutes: 120,
        takeProfitPct: 1.2, stopLossPct: 0.9, positionCostPercent: POSITION_COST, slippagePct: 0 }
      const families = HISTORIC_TEST_SIMULATED_FAMILIES.flatMap<[HistoricTestStrategyFamily, string]>(family =>
        family === "block" ? [1, 2, 3, 4, 5, 6].map<[HistoricTestStrategyFamily, string]>(count => [family, `count:${count}`]) :
          family === "trailing" ? [[family, "entry"], [family, "peak"]] : [[family, "default"]])
      for (const [family, variant] of families) {
        const methods: HistoricCandleSimulatorOptions = { ...familyOptions, ...(variant === "entry" || variant === "peak" ? { trailingGapBasis: variant } : {}) }
        const base = createHistoricCandleSimulator(methods)
        const stress = createHistoricCandleSimulator({ ...methods, takerFeeFraction: 0.001, slippageFraction: 0.0006 })
        for (const indication of INDICATIONS) {
          const request = { connectionId: "market-replay", symbol: market.symbol, indication, family, variant,
            window: { fromMs: begin, toMs: end, hours: 96 }, maxProgressCount: 10000 }
          const [ordinary, adverse] = await Promise.all([base(request), stress(request)])
          const format = (trades: typeof ordinary) => trades.map(trade => ({
            earlier: trade.openedAt!, when: trade.closedAt!, base: trade.signedResultR * POSITION_COST, stress: trade.signedResultR * POSITION_COST,
          }))
          add({ kind: "family", name: family, config: `${indication} / ${variant}`, range: "1.2 / 0.9", side: "both", tf: 15 }, format(ordinary), format(adverse))
        }
      }

      for (const source of ALL_SIGNAL_SOURCE_DEFINITIONS) {
        if ((source.id !== "bingx-swap" && source.candleSourceId !== "bingx-swap") || !signalSourceSupportsSymbol(source, market.symbol)) continue
        const sourceBars = source.timeframeMinutes === 1 ? bars : resampleNormalizedCandles(bars, source.timeframeMinutes)
        const options = { source, symbol: market.symbol, candles: sourceBars, positionCostPct: POSITION_COST, settings: signalSettings }
        const scores = replaySignalSourceOutcomes(options)
        const measured = scores.map(row => ({ earlier: row.openedAt!, when: row.closedAt, base: row.netPct, stress: row.netPct - (STRESS - COST) }))
        add({ kind: "signal", name: source.id, config: source.candleSourceId ?? source.id, range: "source", side: "both", tf: source.timeframeMinutes }, measured)
      }
      process.stderr.write(`${period.name} ${market.symbol} completed\n`)
    }
    studies.push({ period: { ...period, markets: markets.map(({ symbol, sha256 }) => ({ symbol, sha256 })) }, rows: commonRows.flat().concat([...rows.values()]) })
  }
  writeFileSync(outputPath, JSON.stringify({
    costs: [COST, STRESS], profiles: PROFILES, timeframes: TIMEFRAMES,
    commonTypes: COMMON_INDICATOR_DEFINITIONS.length, commonTuples: configurations.length,
    registeredSignalSources: ALL_SIGNAL_SOURCE_DEFINITIONS.map(source => source.id), studies,
    elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS,
  }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
