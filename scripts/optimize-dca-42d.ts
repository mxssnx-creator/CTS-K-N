#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  runDcaBacktest,
  type DcaBacktestCandle,
  type DcaBacktestConfig,
  type DcaBacktestDirection,
  type DcaBacktestEntry,
  type DcaBacktestResult,
  type DcaBacktestTrade,
} from "../lib/dca-backtest"
import { normalizeDcaProfile } from "../lib/dca-strategy"

const DEFAULT_SYMBOLS = [
  "BTC-USDT", "SOL-USDT", "BCH-USDT", "XRP-USDT", "ETH-USDT", "BNB-USDT",
  "DOGE-USDT", "ADA-USDT", "AVAX-USDT", "LINK-USDT", "DOT-USDT", "ATOM-USDT",
  "LTC-USDT", "UNI-USDT", "NEAR-USDT", "OP-USDT", "ARB-USDT", "APT-USDT",
] as const
const DEFAULT_TIMEFRAMES = [5, 15] as const
const ENTRY_MODES: DcaBacktestEntry[] = ["momentum", "mean_reversion", "breakout", "relative"]
const API_ORIGIN = "https://open-api.bingx.com"
const DAY_MS = 24 * 60 * 60 * 1_000
const WEEK_MS = 7 * DAY_MS

type Timeframe = DcaBacktestConfig["timeframeMinutes"]
type Candidate = {
  id: string
  config: DcaBacktestConfig
  lastStepStopBufferPct: number
}
type AnnotatedTrade = DcaBacktestTrade & { symbol: string }
type SymbolRun = { symbol: string; result: DcaBacktestResult }
type CandidateEvaluation = {
  candidate: Candidate
  aggregate: ReturnType<typeof summarizeRuns>
  score: number
}
type MarketFold = {
  index: number
  start: number
  end: number
  market: Map<string, DcaBacktestCandle[]>
}

function finiteNumber(raw: unknown, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseList(raw: string | undefined): string[] {
  return String(raw || "")
    .split(/[\s,|]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function normalizeSymbol(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[-_]/g, "")
  return compact.endsWith("USDT") ? `${compact.slice(0, -4)}-USDT` : value.trim().toUpperCase()
}

function parseTimeframes(raw: string | undefined): Timeframe[] {
  const parsed = parseList(raw).map(Number).filter((value): value is Timeframe =>
    value === 5 || value === 15 || value === 30,
  )
  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_TIMEFRAMES]
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))
  return sorted[index]
}

function candidateId(config: DcaBacktestConfig): string {
  const lastDistance = config.profile.stepDistancesPct[config.profile.maxSteps - 1]
  return [
    `${config.timeframeMinutes}m`,
    config.entry,
    `tp${config.takeProfitPct}`,
    `last${lastDistance}`,
    `buf${round(config.stopLossPct - lastDistance, 3)}`,
    `hold${config.maxHoldMinutes || 0}`,
    `v${config.profile.stepVolumeMultipliers.join("-")}`,
    `d${config.profile.stepDistancesPct.join("-")}`,
  ].join("|")
}

async function fetchJsonWithRetry(url: URL, label: string): Promise<{
  code?: number
  msg?: string
  data?: Array<Record<string, unknown>>
}> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) return await response.json() as {
        code?: number
        msg?: string
        data?: Array<Record<string, unknown>>
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function fetchHistoricRange(input: {
  symbol: string
  timeframe: Timeframe
  startTime: number
  endTime: number
}): Promise<DcaBacktestCandle[]> {
  const rows = new Map<number, DcaBacktestCandle>()
  let pageEnd = input.endTime
  const expectedCandles = Math.ceil((input.endTime - input.startTime) / (input.timeframe * 60_000))
  const maximumPages = Math.min(96, Math.ceil(expectedCandles / 1_000) + 3)
  for (let page = 0; page < maximumPages; page++) {
    const url = new URL("/openApi/swap/v3/quote/klines", API_ORIGIN)
    url.searchParams.set("symbol", input.symbol)
    url.searchParams.set("interval", `${input.timeframe}m`)
    url.searchParams.set("limit", "1440")
    url.searchParams.set("endTime", String(pageEnd))
    const payload = await fetchJsonWithRetry(url, `${input.symbol} ${input.timeframe}m page ${page + 1}`)
    if (Number(payload.code) !== 0 || !Array.isArray(payload.data)) {
      throw new Error(`${input.symbol} ${input.timeframe}m: ${payload.msg || "invalid response"}`)
    }
    let earliest = Number.POSITIVE_INFINITY
    for (const raw of payload.data) {
      const time = Number(raw.time)
      earliest = Math.min(earliest, time)
      if (time < input.startTime || time > input.endTime) continue
      const candle = {
        time,
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        volume: Number(raw.volume),
      }
      if (Object.values(candle).every(Number.isFinite) && candle.close > 0) rows.set(time, candle)
    }
    if (!Number.isFinite(earliest) || earliest <= input.startTime || payload.data.length === 0) break
    pageEnd = earliest - 1
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return [...rows.values()].sort((left, right) => left.time - right.time)
}

function cacheFilename(cacheDir: string, symbol: string, timeframe: Timeframe, startTime: number, endTime: number): string {
  return resolve(
    cacheDir,
    `${symbol.replace(/[^A-Z0-9]/g, "")}-${timeframe}m-${startTime}-${endTime}.json`,
  )
}

async function loadMarket(input: {
  cacheDir: string
  symbol: string
  timeframe: Timeframe
  startTime: number
  endTime: number
}): Promise<DcaBacktestCandle[]> {
  const filename = cacheFilename(input.cacheDir, input.symbol, input.timeframe, input.startTime, input.endTime)
  try {
    const cached = JSON.parse(await readFile(filename, "utf8")) as { candles?: DcaBacktestCandle[] }
    if (Array.isArray(cached.candles) && cached.candles.length > 30) return cached.candles
  } catch { /* cache miss */ }
  const candles = await fetchHistoricRange(input)
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, `${JSON.stringify({
    symbol: input.symbol,
    timeframeMinutes: input.timeframe,
    rangeStart: new Date(input.startTime).toISOString(),
    rangeEnd: new Date(input.endTime).toISOString(),
    candles,
  })}\n`, "utf8")
  return candles
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(lanes)
  return results
}

function makeCandidate(input: {
  timeframeMinutes: Timeframe
  entry: DcaBacktestEntry
  volumes: number[]
  distances: number[]
  takeProfitPct: number
  stopBufferPct: number
  maxHoldMinutes: number
}): Candidate {
  const profile = normalizeDcaProfile({
    maxSteps: 4,
    stepVolumeMultipliers: input.volumes,
    stepDistancesPct: input.distances,
    takeProfitMode: "average",
    breakevenProfitPct: 0.2,
    cooldownSeconds: 30,
    maxPositionVolumeRatio: Math.min(5, 1 + input.volumes.reduce((sum, value) => sum + value, 0)),
  })
  const config: DcaBacktestConfig = {
    profile,
    timeframeMinutes: input.timeframeMinutes,
    entry: input.entry,
    takeProfitPct: input.takeProfitPct,
    stopLossPct: input.distances[input.distances.length - 1] + input.stopBufferPct,
    maxHoldMinutes: input.maxHoldMinutes,
    roundTripCostPct: 0.1,
    slippagePct: 0.02,
  }
  return { id: candidateId(config), config, lastStepStopBufferPct: input.stopBufferPct }
}

function buildCandidates(timeframes: Timeframe[]): Candidate[] {
  const volumeLadders = [
    [0.15, 0.25, 0.4, 0.6],
    [0.25, 0.4, 0.55, 0.8],
    [0.35, 0.5, 0.65, 1],
  ]
  const distanceLadders = [
    [0.1, 0.2, 0.32, 0.5],
    [0.12, 0.25, 0.42, 0.65],
    [0.16, 0.32, 0.52, 0.8],
    [0.2, 0.4, 0.65, 0.95],
    [0.25, 0.5, 0.8, 1.2],
  ]
  const takeProfits = [0.3, 0.45, 0.6]
  // 0.35% is the current runtime-compatible comparator; the surrounding
  // shorter values make the requested tighter final-step protection explicit.
  const stopBuffers = [0.1, 0.15, 0.2, 0.3, 0.35, 0.45]
  const maxHolds = [6 * 60, 12 * 60]
  const candidates: Candidate[] = []
  for (const timeframeMinutes of timeframes) {
    for (const entry of ENTRY_MODES) {
      for (const volumes of volumeLadders) {
        for (const distances of distanceLadders) {
          for (const takeProfitPct of takeProfits) {
            for (const stopBufferPct of stopBuffers) {
              for (const maxHoldMinutes of maxHolds) {
                candidates.push(makeCandidate({
                  timeframeMinutes,
                  entry,
                  volumes,
                  distances,
                  takeProfitPct,
                  stopBufferPct,
                  maxHoldMinutes,
                }))
              }
            }
          }
        }
      }
    }
  }

  // Preserve both existing evidence profiles as explicit comparators even
  // though the new search deliberately concentrates on shorter final ranges.
  candidates.push(makeCandidate({
    timeframeMinutes: 15,
    entry: "relative",
    volumes: [1, 1, 1, 1],
    distances: [0.3, 0.6, 1, 1.6],
    takeProfitPct: 0.6,
    stopBufferPct: 0.35,
    maxHoldMinutes: 12 * 60,
  }))
  candidates.push(makeCandidate({
    timeframeMinutes: 15,
    entry: "relative",
    volumes: [1, 1, 1, 1],
    distances: [0.55, 1.1, 1.8, 2.8],
    takeProfitPct: 0.6,
    stopBufferPct: 0.35,
    maxHoldMinutes: 12 * 60,
  }))
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
}

function profitFactor(grossProfit: number, grossLoss: number): { value: number | null; infinite: boolean } {
  const infinite = grossLoss === 0 && grossProfit > 0
  return {
    value: grossLoss > 0 ? grossProfit / grossLoss : infinite ? null : 0,
    infinite,
  }
}

function directionSummary(trades: AnnotatedTrade[], direction: DcaBacktestDirection) {
  const selected = trades.filter((trade) => trade.direction === direction)
  const grossProfitPct = selected.reduce((sum, trade) => sum + Math.max(0, trade.pnlPctOfInitialNotional), 0)
  const grossLossPct = selected.reduce((sum, trade) => sum + Math.max(0, -trade.pnlPctOfInitialNotional), 0)
  const pf = profitFactor(grossProfitPct, grossLossPct)
  return {
    positions: selected.length,
    wins: selected.filter((trade) => trade.pnlPctOfInitialNotional > 0).length,
    winRatePct: selected.length > 0
      ? selected.filter((trade) => trade.pnlPctOfInitialNotional > 0).length / selected.length * 100
      : 0,
    netPnlPct: grossProfitPct - grossLossPct,
    grossProfitPct,
    grossLossPct,
    profitFactor: pf.value,
    profitFactorInfinite: pf.infinite,
  }
}

function portfolioDrawdown(trades: AnnotatedTrade[]): number {
  let equity = 0
  let peak = 0
  let maximum = 0
  for (const trade of [...trades].sort((left, right) =>
    left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol),
  )) {
    equity += trade.pnlPctOfInitialNotional
    peak = Math.max(peak, equity)
    maximum = Math.max(maximum, peak - equity)
  }
  return maximum
}

function summarizeRuns(runs: SymbolRun[]) {
  const trades: AnnotatedTrade[] = runs.flatMap(({ symbol, result }) =>
    result.trades.map((trade) => ({ ...trade, symbol })),
  )
  const grossProfitPct = runs.reduce((sum, item) => sum + item.result.grossProfitPct, 0)
  const grossLossPct = runs.reduce((sum, item) => sum + item.result.grossLossPct, 0)
  const pf = profitFactor(grossProfitPct, grossLossPct)
  const wins = trades.filter((trade) => trade.pnlPctOfInitialNotional > 0).length
  const symbolRows = runs.map(({ symbol, result }) => ({
    symbol: symbol.replace("-", ""),
    closedTrades: result.closedTrades,
    wins: result.wins,
    winRatePct: result.winRatePct,
    netPnlPct: result.netPnlPct,
    profitFactor: result.profitFactor,
    profitFactorInfinite: result.profitFactorInfinite,
    maxEquityDrawdownPct: result.maxEquityDrawdownPct,
    averageDrawdownTimeMin: result.averageDrawdownTimeMin,
    maxDrawdownTimeMin: result.maxDrawdownTimeMin,
    maxPositionVolumeRatio: result.maxPositionVolumeRatio,
    averagePositionVolumeRatio: result.averagePositionVolumeRatio,
  }))
  const closedTrades = trades.length
  const dcaStepCounts = Object.fromEntries([0, 1, 2, 3, 4].map((steps) => [
    steps,
    trades.filter((trade) => trade.dcaSteps === steps).length,
  ]))
  const exitReasons = Object.fromEntries((["tp", "sl", "timeout"] as const).map((reason) => {
    const selected = trades.filter((trade) => trade.exitReason === reason)
    return [reason, {
      positions: selected.length,
      sharePct: closedTrades > 0 ? selected.length / closedTrades * 100 : 0,
      netPnlPct: selected.reduce((sum, trade) => sum + trade.pnlPctOfInitialNotional, 0),
    }]
  }))
  return {
    closedTrades,
    wins,
    losses: closedTrades - wins,
    winRatePct: closedTrades > 0 ? wins / closedTrades * 100 : 0,
    netPnlPct: grossProfitPct - grossLossPct,
    equalWeightNetPnlPct: runs.length > 0 ? (grossProfitPct - grossLossPct) / runs.length : 0,
    grossProfitPct,
    grossLossPct,
    profitFactor: pf.value,
    profitFactorInfinite: pf.infinite,
    portfolioEquityDrawdownPct: portfolioDrawdown(trades),
    equalWeightPortfolioDrawdownPct: runs.length > 0 ? portfolioDrawdown(trades) / runs.length : 0,
    maxSymbolEquityDrawdownPct: Math.max(0, ...runs.map((item) => item.result.maxEquityDrawdownPct)),
    averageDrawdownTimeMin: closedTrades > 0
      ? trades.reduce((sum, trade) => sum + trade.drawdownTimeMin, 0) / closedTrades
      : 0,
    maxDrawdownTimeMin: Math.max(0, ...trades.map((trade) => trade.drawdownTimeMin)),
    averageHoldTimeMin: closedTrades > 0
      ? trades.reduce((sum, trade) => sum + trade.holdTimeMin, 0) / closedTrades
      : 0,
    holdTimeP50Min: percentile(trades.map((trade) => trade.holdTimeMin), 0.5),
    holdTimeP95Min: percentile(trades.map((trade) => trade.holdTimeMin), 0.95),
    drawdownTimeP95Min: percentile(trades.map((trade) => trade.drawdownTimeMin), 0.95),
    adversePnlP05Pct: percentile(trades.map((trade) => trade.maxAdversePnlPct), 0.05),
    worstTradePnlPct: Math.min(0, ...trades.map((trade) => trade.pnlPctOfInitialNotional)),
    worstAdversePnlPct: Math.min(0, ...trades.map((trade) => trade.maxAdversePnlPct)),
    maxPositionVolumeRatio: Math.max(1, ...trades.map((trade) => trade.volumeRatio)),
    averagePositionVolumeRatio: closedTrades > 0
      ? trades.reduce((sum, trade) => sum + trade.volumeRatio, 0) / closedTrades
      : 1,
    dcaPositions: trades.filter((trade) => trade.dcaSteps > 0).length,
    dcaPositionSharePct: closedTrades > 0
      ? trades.filter((trade) => trade.dcaSteps > 0).length / closedTrades * 100
      : 0,
    dcaStepCounts,
    exitReasons,
    directions: {
      long: directionSummary(trades, "long"),
      short: directionSummary(trades, "short"),
    },
    profitableSymbols: symbolRows.filter((row) => row.netPnlPct > 0).length,
    nonNegativeSymbols: symbolRows.filter((row) => row.netPnlPct >= 0).length,
    worstSymbolPnlPct: Math.min(0, ...symbolRows.map((row) => row.netPnlPct)),
    bestSymbolPnlPct: Math.max(0, ...symbolRows.map((row) => row.netPnlPct)),
    symbols: symbolRows,
  }
}

function symbolResultScore(input: {
  closedTrades: number
  netPnlPct: number
  profitFactor: number | null
  profitFactorInfinite: boolean
  maxEquityDrawdownPct: number
  averageDrawdownTimeMin: number
}, historyDays: number, stopBufferPct: number): number {
  const profitFactorValue = input.profitFactorInfinite ? 8 : Math.min(8, Number(input.profitFactor || 0))
  const positionsPerWeek = input.closedTrades / Math.max(1, historyDays / 7)
  return (
    input.netPnlPct * 0.8 +
    Math.log1p(profitFactorValue) * 5 +
    positionsPerWeek * 0.6 +
    Math.log1p(input.closedTrades) * 0.5 -
    input.maxEquityDrawdownPct * 1.25 -
    input.averageDrawdownTimeMin / 360 -
    stopBufferPct * 0.75
  )
}

function summarizeDirectionTrades(trades: DcaBacktestTrade[], direction: DcaBacktestDirection) {
  const selected = trades.filter((trade) => trade.direction === direction)
  const grossProfitPct = selected.reduce((sum, trade) => sum + Math.max(0, trade.pnlPctOfInitialNotional), 0)
  const grossLossPct = selected.reduce((sum, trade) => sum + Math.max(0, -trade.pnlPctOfInitialNotional), 0)
  const pf = profitFactor(grossProfitPct, grossLossPct)
  return {
    positions: selected.length,
    netPnlPct: grossProfitPct - grossLossPct,
    profitFactor: pf.value,
    profitFactorInfinite: pf.infinite,
  }
}

function compactBacktestResult(result: DcaBacktestResult) {
  return {
    closedTrades: result.closedTrades,
    wins: result.wins,
    losses: result.losses,
    winRatePct: result.winRatePct,
    netPnlPct: result.netPnlPct,
    grossProfitPct: result.grossProfitPct,
    grossLossPct: result.grossLossPct,
    profitFactor: result.profitFactor,
    profitFactorInfinite: result.profitFactorInfinite,
    maxEquityDrawdownPct: result.maxEquityDrawdownPct,
    averageDrawdownTimeMin: result.averageDrawdownTimeMin,
    maxDrawdownTimeMin: result.maxDrawdownTimeMin,
    maxPositionVolumeRatio: result.maxPositionVolumeRatio,
    averagePositionVolumeRatio: result.averagePositionVolumeRatio,
    worstTradePnlPct: Math.min(0, ...result.trades.map((trade) => trade.pnlPctOfInitialNotional)),
    averageHoldTimeMin: result.closedTrades > 0
      ? result.trades.reduce((sum, trade) => sum + trade.holdTimeMin, 0) / result.closedTrades
      : 0,
    long: summarizeDirectionTrades(result.trades, "long"),
    short: summarizeDirectionTrades(result.trades, "short"),
  }
}

function evaluateCandidate(candidate: Candidate, market: Map<string, DcaBacktestCandle[]>, symbols: string[]) {
  const runs = symbols.map((symbol) => ({
    symbol,
    result: runDcaBacktest(
      market.get(`${symbol}:${candidate.config.timeframeMinutes}`) || [],
      candidate.config,
    ),
  }))
  return summarizeRuns(runs)
}

function scoreSummary(summary: ReturnType<typeof summarizeRuns>, symbolCount: number, historyDays: number, stopBuffer: number): number {
  const pf = summary.profitFactorInfinite ? 8 : Math.min(8, Number(summary.profitFactor || 0))
  const positionsPerSymbolWeek = summary.closedTrades / Math.max(1, symbolCount * historyDays / 7)
  return (
    Math.log1p(summary.closedTrades) * 2.5 +
    Math.log1p(pf) * 4 +
    positionsPerSymbolWeek * 1.5 +
    summary.netPnlPct / Math.max(20, symbolCount * 4) +
    summary.profitableSymbols / Math.max(1, symbolCount) * 3 +
    summary.winRatePct / 100 -
    summary.maxSymbolEquityDrawdownPct * 1.4 -
    summary.portfolioEquityDrawdownPct * 0.35 -
    Math.abs(Math.min(0, summary.worstTradePnlPct)) * 0.6 -
    summary.averageDrawdownTimeMin / 480 -
    stopBuffer * 0.75
  )
}

function configProjection(candidate: Candidate) {
  return {
    id: candidate.id,
    timeframeMinutes: candidate.config.timeframeMinutes,
    entry: candidate.config.entry,
    takeProfitPct: candidate.config.takeProfitPct,
    stopLossPct: candidate.config.stopLossPct,
    lastStepDistancePct: candidate.config.profile.stepDistancesPct[candidate.config.profile.maxSteps - 1],
    lastStepStopBufferPct: candidate.lastStepStopBufferPct,
    maxHoldMinutes: candidate.config.maxHoldMinutes,
    profile: candidate.config.profile,
  }
}

function buildSymbolAdaptiveValidation(input: {
  candidates: CandidateEvaluation[]
  symbols: string[]
  fullMarket: Map<string, DcaBacktestCandle[]>
  trainingMarket: Map<string, DcaBacktestCandle[]>
  folds: MarketFold[]
  trainingEnd: number
  historyDays: number
}) {
  const trainingDays = Math.max(1, input.historyDays - 14)
  const trainingFolds = input.folds.filter((fold) => fold.end <= input.trainingEnd)
  const validationFolds = input.folds.filter((fold) => fold.start >= input.trainingEnd)
  const validationMarket = new Map<string, DcaBacktestCandle[]>()
  for (const symbol of input.symbols) {
    for (const timeframe of [...new Set(input.candidates.map((item) => item.candidate.config.timeframeMinutes))]) {
      validationMarket.set(
        `${symbol}:${timeframe}`,
        (input.fullMarket.get(`${symbol}:${timeframe}`) || []).filter((candle) => candle.time >= input.trainingEnd),
      )
    }
  }

  const selections = input.symbols.map((symbol) => {
    const normalizedSymbol = symbol.replace("-", "")
    const ranked = input.candidates.filter((item) => {
      const distances = item.candidate.config.profile.stepDistancesPct
      return distances[item.candidate.config.profile.maxSteps - 1] <= 1.2
    }).map((item) => {
      const row = item.aggregate.symbols.find((candidateRow) => candidateRow.symbol === normalizedSymbol)
      return row ? {
        candidate: item.candidate,
        row,
        score: symbolResultScore(row, trainingDays, item.candidate.lastStepStopBufferPct),
      } : null
    }).filter((item): item is NonNullable<typeof item> => item !== null)
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => right.score - left.score)

    const evaluated = ranked.slice(0, 32).map((item) => {
      const config = item.candidate.config
      const trainingResult = runDcaBacktest(
        input.trainingMarket.get(`${symbol}:${config.timeframeMinutes}`) || [],
        config,
      )
      const foldResults = trainingFolds.map((fold) => runDcaBacktest(
        fold.market.get(`${symbol}:${config.timeframeMinutes}`) || [],
        config,
      ))
      const compact = compactBacktestResult(trainingResult)
      const compactFolds = foldResults.map(compactBacktestResult)
      const positiveFolds = compactFolds.filter((fold) => fold.netPnlPct > 0).length
      const minimumFoldProfitFactor = Math.min(...compactFolds.map((fold) =>
        fold.profitFactorInfinite ? 99 : Number(fold.profitFactor || 0),
      ))
      const longPf = compact.long.profitFactorInfinite ? 99 : Number(compact.long.profitFactor || 0)
      const shortPf = compact.short.profitFactorInfinite ? 99 : Number(compact.short.profitFactor || 0)
      const strict = (
        compact.closedTrades >= 16 &&
        compact.netPnlPct > 0 &&
        (compact.profitFactorInfinite || Number(compact.profitFactor || 0) >= 1.15) &&
        compact.maxEquityDrawdownPct <= 6 &&
        compact.long.positions >= 3 && compact.short.positions >= 3 &&
        compact.long.netPnlPct >= 0 && compact.short.netPnlPct >= 0 &&
        positiveFolds === trainingFolds.length &&
        minimumFoldProfitFactor >= 1
      )
      const robust = strict || (
        compact.closedTrades >= 12 &&
        compact.netPnlPct > 0 &&
        (compact.profitFactorInfinite || Number(compact.profitFactor || 0) >= 1.08) &&
        compact.maxEquityDrawdownPct <= 8 &&
        compact.long.positions >= 2 && compact.short.positions >= 2 &&
        longPf >= 0.7 && shortPf >= 0.7 &&
        positiveFolds >= Math.max(1, trainingFolds.length - 1) &&
        minimumFoldProfitFactor >= 0.7
      )
      const foldPenalty = compactFolds.reduce((sum, fold) =>
        sum + Math.max(0, -fold.netPnlPct) * 1.5 + fold.maxEquityDrawdownPct * 0.2,
      0)
      return {
        candidate: item.candidate,
        qualification: strict ? "strict" : robust ? "robust" : "unqualified",
        positiveFolds,
        minimumFoldProfitFactor,
        score: symbolResultScore(compact, trainingDays, item.candidate.lastStepStopBufferPct) - foldPenalty,
        training: compact,
        trainingFolds: compactFolds,
      }
    }).sort((left, right) =>
      Number(right.qualification === "strict") - Number(left.qualification === "strict") ||
      Number(right.qualification === "robust") - Number(left.qualification === "robust") ||
      right.score - left.score,
    )

    const selected = evaluated.find((item) => item.qualification === "strict") ||
      evaluated.find((item) => item.qualification === "robust") || null
    const fallback = evaluated[0] || null
    if (!selected) {
      return {
        symbol: normalizedSymbol,
        enabledFromTrainingOnly: false,
        trainingQualification: "unqualified",
        reason: "No profile passed the four-week training PF, drawdown, direction and weekly-fold gates.",
        bestTrainingFallback: fallback ? {
          config: configProjection(fallback.candidate),
          score: fallback.score,
          training: fallback.training,
          positiveFolds: fallback.positiveFolds,
        } : null,
      }
    }

    const config = selected.candidate.config
    const fullResult = runDcaBacktest(
      input.fullMarket.get(`${symbol}:${config.timeframeMinutes}`) || [],
      config,
    )
    const validationResult = runDcaBacktest(
      validationMarket.get(`${symbol}:${config.timeframeMinutes}`) || [],
      config,
    )
    const validationFoldResults = validationFolds.map((fold) => runDcaBacktest(
      fold.market.get(`${symbol}:${config.timeframeMinutes}`) || [],
      config,
    ))
    return {
      symbol: normalizedSymbol,
      enabledFromTrainingOnly: true,
      trainingQualification: selected.qualification,
      config: configProjection(selected.candidate),
      training: selected.training,
      trainingPositiveFolds: selected.positiveFolds,
      trainingMinimumFoldProfitFactor: selected.minimumFoldProfitFactor,
      trainingFolds: selected.trainingFolds,
      fullRange: compactBacktestResult(fullResult),
      outOfSample: compactBacktestResult(validationResult),
      outOfSampleFolds: validationFoldResults.map(compactBacktestResult),
      _candidate: selected.candidate,
      _fullResult: fullResult,
      _validationResult: validationResult,
    }
  })

  const enabled = selections.filter((selection): selection is typeof selection & {
    enabledFromTrainingOnly: true
    _candidate: Candidate
    _fullResult: DcaBacktestResult
    _validationResult: DcaBacktestResult
  } => selection.enabledFromTrainingOnly)
  const fullRangeAggregate = summarizeRuns(enabled.map((selection) => ({
    symbol: selection.symbol,
    result: selection._fullResult,
  })))
  const outOfSampleAggregate = summarizeRuns(enabled.map((selection) => ({
    symbol: selection.symbol,
    result: selection._validationResult,
  })))
  const outOfSampleFolds = validationFolds.map((fold, foldIndex) => {
    const aggregate = summarizeRuns(enabled.map((selection) => ({
      symbol: selection.symbol,
      result: runDcaBacktest(
        fold.market.get(`${selection.symbol.replace(/USDT$/, "-USDT")}:${selection._candidate.config.timeframeMinutes}`) || [],
        selection._candidate.config,
      ),
    })))
    return {
      index: foldIndex + 1,
      rangeStart: new Date(fold.start).toISOString(),
      rangeEnd: new Date(fold.end).toISOString(),
      aggregate,
    }
  })
  const positiveValidationFolds = outOfSampleFolds.filter((fold) => fold.aggregate.netPnlPct > 0).length
  const activeSymbols = enabled.length
  const strict = (
    activeSymbols >= 6 &&
    outOfSampleAggregate.closedTrades >= activeSymbols * 4 &&
    outOfSampleAggregate.netPnlPct > 0 &&
    (outOfSampleAggregate.profitFactorInfinite || Number(outOfSampleAggregate.profitFactor || 0) >= 1.1) &&
    outOfSampleAggregate.equalWeightPortfolioDrawdownPct <= 6 &&
    outOfSampleAggregate.maxSymbolEquityDrawdownPct <= 8 &&
    outOfSampleAggregate.profitableSymbols >= Math.ceil(activeSymbols * 0.8) &&
    positiveValidationFolds === validationFolds.length
  )
  const robust = strict || (
    activeSymbols >= 4 &&
    outOfSampleAggregate.closedTrades >= activeSymbols * 3 &&
    outOfSampleAggregate.netPnlPct > 0 &&
    (outOfSampleAggregate.profitFactorInfinite || Number(outOfSampleAggregate.profitFactor || 0) >= 1.05) &&
    outOfSampleAggregate.equalWeightPortfolioDrawdownPct <= 7.5 &&
    outOfSampleAggregate.maxSymbolEquityDrawdownPct <= 10 &&
    outOfSampleAggregate.profitableSymbols >= Math.ceil(activeSymbols * 0.7) &&
    positiveValidationFolds >= Math.max(1, validationFolds.length - 1)
  )

  return {
    method: "Per-symbol profile selection on the first 28 days only; untouched final 14 days are out-of-sample.",
    trainingDays,
    outOfSampleDays: input.historyDays - trainingDays,
    activeSymbols,
    disabledSymbols: input.symbols.length - activeSymbols,
    qualification: strict ? "strict" : robust ? "robust" : "unqualified",
    recommendation: strict || robust ? "demo_soak_only" : "keep_dca_disabled",
    positiveOutOfSampleFolds: positiveValidationFolds,
    fullRangeAggregate,
    outOfSampleAggregate,
    outOfSampleFolds,
    symbols: selections.map((selection) => {
      const { _candidate, _fullResult, _validationResult, ...serializable } = selection as any
      return serializable
    }),
  }
}

function markdownNumber(value: unknown, digits = 4): string {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "∞"
}

function renderMarkdown(report: any): string {
  const selected = report.selected
  const metrics = selected?.aggregate
  const config = selected?.config
  const adaptive = report.symbolAdaptive
  const adaptiveMetrics = adaptive?.outOfSampleAggregate
  const lines = [
    `# Historic DCA 42-day / 18-symbol validation — ${report.generatedAt.slice(0, 10)}`,
    "",
    "## Scope and decision",
    "",
    `- Exact UTC range: \`${report.rangeStart}\` through \`${report.rangeEnd}\`.`,
    `- ${report.symbols.length} symbols, ${report.historyDays} days, ${report.foldCount} chronological weekly folds.`,
    `- ${report.candidateCount} complete short-range configurations screened; ${report.fullValidationCandidateCount} diversified finalists re-run over every symbol and fold.`,
    `- Conservative costs: ${report.costModel.roundTripCostPct}% round trip plus ${report.costModel.slippagePctPerFill}% adverse slippage per fill.`,
    `- Global-profile status: **${selected?.qualification || "none"}**. Symbol-adaptive out-of-sample status: **${adaptive?.qualification || "none"}**.`,
    `- Runtime recommendation: **${adaptive?.recommendation || "keep_dca_disabled"}**. This is measured historical evidence, not a profit guarantee.`,
    "",
    "## 28-day training / 14-day out-of-sample decision",
    "",
    `Profiles were selected independently per symbol using only the first 28 days. The final 14 days were not consulted until selection was frozen. ${adaptive?.activeSymbols ?? 0} of ${report.symbols.length} symbols passed the training-only gates.`,
    "",
    "| Metric | Out-of-sample result |",
    "| --- | ---: |",
    `| Active / disabled symbols | ${adaptive?.activeSymbols ?? 0} / ${adaptive?.disabledSymbols ?? report.symbols.length} |`,
    `| Closed positions | ${adaptiveMetrics?.closedTrades ?? 0} |`,
    `| Long / Short | ${adaptiveMetrics?.directions?.long?.positions ?? 0} / ${adaptiveMetrics?.directions?.short?.positions ?? 0} |`,
    `| Win rate | ${markdownNumber(adaptiveMetrics?.winRatePct, 2)}% |`,
    `| Profit factor | ${adaptiveMetrics?.profitFactorInfinite ? "∞" : markdownNumber(adaptiveMetrics?.profitFactor)} |`,
    `| Equal-weight net PnL | ${markdownNumber(adaptiveMetrics?.equalWeightNetPnlPct)}% |`,
    `| Equal-weight portfolio drawdown | ${markdownNumber(adaptiveMetrics?.equalWeightPortfolioDrawdownPct)}% |`,
    `| Worst per-symbol equity drawdown | ${markdownNumber(adaptiveMetrics?.maxSymbolEquityDrawdownPct)}% |`,
    `| Profitable symbols | ${adaptiveMetrics?.profitableSymbols ?? 0}/${adaptive?.activeSymbols ?? 0} |`,
    `| Positive OOS weeks | ${adaptive?.positiveOutOfSampleFolds ?? 0}/2 |`,
    `| Worst closed position | ${markdownNumber(adaptiveMetrics?.worstTradePnlPct)}% |`,
    `| DCA positions | ${adaptiveMetrics?.dcaPositions ?? 0} (${markdownNumber(adaptiveMetrics?.dcaPositionSharePct, 2)}%) |`,
    "",
    "### Symbol-level frozen-profile validation",
    "",
    "| Symbol | Train gate | TF / entry | Last step + buffer | OOS pos. | OOS PnL | OOS PF | OOS DD |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...(adaptive?.symbols || []).map((row: any) => row.enabledFromTrainingOnly
      ? `| ${row.symbol} | ${row.trainingQualification} | ${row.config.timeframeMinutes}m / ${row.config.entry} | ${markdownNumber(row.config.lastStepDistancePct, 2)}% + ${markdownNumber(row.config.lastStepStopBufferPct, 2)}% | ${row.outOfSample.closedTrades} | ${markdownNumber(row.outOfSample.netPnlPct)}% | ${row.outOfSample.profitFactorInfinite ? "∞" : markdownNumber(row.outOfSample.profitFactor)} | ${markdownNumber(row.outOfSample.maxEquityDrawdownPct)}% |`
      : `| ${row.symbol} | disabled | — | — | — | — | — | — |`,
    ),
    "",
    "## Best global-profile diagnostic (not enabled)",
    "",
    "| Setting | Value |",
    "| --- | ---: |",
    `| Timeframe / entry | ${config?.timeframeMinutes ?? "—"}m / ${config?.entry ?? "—"} |`,
    `| TP / original-entry SL | ${markdownNumber(config?.takeProfitPct, 2)}% / ${markdownNumber(config?.stopLossPct, 2)}% |`,
    `| Last DCA step / SL buffer | ${markdownNumber(config?.lastStepDistancePct, 2)}% / ${markdownNumber(config?.lastStepStopBufferPct, 2)}% |`,
    `| DCA distances | ${config?.profile?.stepDistancesPct?.join(" / ") || "—"}% |`,
    `| Add ratios | ${config?.profile?.stepVolumeMultipliers?.join(" / ") || "—"}× |`,
    `| Maximum hold | ${config?.maxHoldMinutes ?? "—"} minutes |`,
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Closed positions | ${metrics?.closedTrades ?? 0} |`,
    `| Long / Short | ${metrics?.directions?.long?.positions ?? 0} / ${metrics?.directions?.short?.positions ?? 0} |`,
    `| Win rate | ${markdownNumber(metrics?.winRatePct, 2)}% |`,
    `| Net PnL (sum of initial-notional %) | ${markdownNumber(metrics?.netPnlPct)}% |`,
    `| Profit factor | ${metrics?.profitFactorInfinite ? "∞" : markdownNumber(metrics?.profitFactor)} |`,
    `| Aggregate drawdown (initial-notional units) | ${markdownNumber(metrics?.portfolioEquityDrawdownPct)}% |`,
    `| Equal-weight portfolio drawdown | ${markdownNumber(metrics?.equalWeightPortfolioDrawdownPct)}% |`,
    `| Worst per-symbol equity drawdown | ${markdownNumber(metrics?.maxSymbolEquityDrawdownPct)}% |`,
    `| Worst closed position | ${markdownNumber(metrics?.worstTradePnlPct)}% |`,
    `| Profitable / non-negative symbols | ${metrics?.profitableSymbols ?? 0} / ${metrics?.nonNegativeSymbols ?? 0} |`,
    `| Positive weekly folds | ${selected?.positiveFolds ?? 0} / ${report.foldCount} |`,
    `| DCA positions | ${metrics?.dcaPositions ?? 0} (${markdownNumber(metrics?.dcaPositionSharePct, 2)}%) |`,
    `| SL / timeout positions | ${metrics?.exitReasons?.sl?.positions ?? 0} / ${metrics?.exitReasons?.timeout?.positions ?? 0} |`,
    `| Average / p95 drawdown time | ${markdownNumber(metrics?.averageDrawdownTimeMin, 1)} / ${markdownNumber(metrics?.drawdownTimeP95Min, 1)} min |`,
    "",
    "## Weekly walk-forward folds",
    "",
    "| Week | Positions | Net PnL | PF | Max symbol DD | Profitable symbols |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(selected?.folds || []).map((fold: any) =>
      `| ${fold.index} | ${fold.aggregate.closedTrades} | ${markdownNumber(fold.aggregate.netPnlPct)}% | ${fold.aggregate.profitFactorInfinite ? "∞" : markdownNumber(fold.aggregate.profitFactor)} | ${markdownNumber(fold.aggregate.maxSymbolEquityDrawdownPct)}% | ${fold.aggregate.profitableSymbols}/${report.symbols.length} |`,
    ),
    "",
    "## Per-symbol result",
    "",
    "| Symbol | Positions | Win rate | Net PnL | PF | Max DD | Avg DDT |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(metrics?.symbols || []).map((row: any) =>
      `| ${row.symbol} | ${row.closedTrades} | ${markdownNumber(row.winRatePct, 2)}% | ${markdownNumber(row.netPnlPct)}% | ${row.profitFactorInfinite ? "∞" : markdownNumber(row.profitFactor)} | ${markdownNumber(row.maxEquityDrawdownPct)}% | ${markdownNumber(row.averageDrawdownTimeMin, 1)} min |`,
    ),
    "",
    "## Last-step stop-buffer comparison",
    "",
    "| Buffer | Finalists | Max positions | Best PF | Best net PnL | Best max-symbol DD |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(report.stopBufferAnalysis || []).map((row: any) =>
      `| ${markdownNumber(row.lastStepStopBufferPct, 2)}% | ${row.candidates} | ${row.maximumClosedTrades} | ${row.bestScoreCandidate?.aggregate?.profitFactorInfinite ? "∞" : markdownNumber(row.bestScoreCandidate?.aggregate?.profitFactor)} | ${markdownNumber(row.bestScoreCandidate?.aggregate?.netPnlPct)}% | ${markdownNumber(row.bestScoreCandidate?.aggregate?.maxSymbolEquityDrawdownPct)}% |`,
    ),
    "",
    "## Interpretation",
    "",
    "The optimizer favors high position coverage and explicitly penalizes per-symbol and portfolio drawdown, long drawdown duration, large single losses, and wider final-step stop buffers. A losing fallback is reported for transparency but is never converted into an enabled recommendation. The complete JSON artifact contains the diversified finalist table, frozen-profile out-of-sample results, buffer comparison, coverage checks, direction/exit/DCA-step distributions, and both legacy comparators.",
    "",
    "Production DCA remains subject to runtime PF/DDT gates, the 5× exposure ceiling, venue fills, funding, latency, and live slippage. The backtest never enables real order placement.",
    "",
  ]
  return `${lines.join("\n")}\n`
}

async function main() {
  const historyDays = Math.max(42, Math.min(90, Math.floor(finiteNumber(process.env.DCA_BACKTEST_DAYS, 42))))
  const requestedSymbols = parseList(process.env.DCA_BACKTEST_SYMBOLS)
  const symbols = (requestedSymbols.length > 0 ? requestedSymbols : [...DEFAULT_SYMBOLS])
    .map(normalizeSymbol)
    .slice(0, 18)
  if (symbols.length !== 18) throw new Error(`42-day validation requires exactly 18 symbols, received ${symbols.length}`)
  const timeframes = parseTimeframes(process.env.DCA_BACKTEST_TIMEFRAMES)
  const foldCount = Math.max(6, Math.min(12, Math.floor(finiteNumber(process.env.DCA_BACKTEST_FOLDS, 6))))
  const alignmentMs = Math.max(...timeframes) * 60_000
  const requestedEnd = Number(process.env.DCA_BACKTEST_END_MS)
  const endTime = Number.isFinite(requestedEnd) && requestedEnd > 0
    ? requestedEnd
    : Math.floor(Date.now() / alignmentMs) * alignmentMs - alignmentMs
  const startTime = endTime - historyDays * DAY_MS
  const cacheDir = resolve(String(process.env.DCA_MARKET_CACHE_DIR || ".dca-cache/42d-18"))
  const outputJson = resolve(String(
    process.env.DCA_BACKTEST_OUTPUT ||
    `validation-results/dca-historic-42d-18s-${new Date(endTime).toISOString().slice(0, 10)}.json`,
  ))
  const outputMarkdown = resolve(String(
    process.env.DCA_BACKTEST_MARKDOWN ||
    `docs/DCA-HISTORIC-42D-18S-VALIDATION-${new Date(endTime).toISOString().slice(0, 10)}.md`,
  ))

  const jobs = symbols.flatMap((symbol) => timeframes.map((timeframe) => ({ symbol, timeframe })))
  const market = new Map<string, DcaBacktestCandle[]>()
  const coverage = await mapConcurrent(jobs, 3, async ({ symbol, timeframe }, index) => {
    const candles = await loadMarket({ cacheDir, symbol, timeframe, startTime, endTime })
    market.set(`${symbol}:${timeframe}`, candles)
    const expected = Math.floor((endTime - startTime) / (timeframe * 60_000))
    const coverageRatio = expected > 0 ? candles.length / expected : 0
    const maximumGapMinutes = candles.length > 1
      ? Math.max(...candles.slice(1).map((candle, candleIndex) =>
          (candle.time - candles[candleIndex].time) / 60_000,
        ))
      : 0
    process.stderr.write(
      `[dca-42d] market ${index + 1}/${jobs.length} ${symbol} ${timeframe}m ` +
      `${candles.length}/${expected} (${(coverageRatio * 100).toFixed(2)}%)\n`,
    )
    return { symbol: symbol.replace("-", ""), timeframeMinutes: timeframe, candles: candles.length, expected, coverageRatio, maximumGapMinutes }
  })
  const incomplete = coverage.filter((item) => item.coverageRatio < 0.98)
  if (incomplete.length > 0) {
    throw new Error(`Historic candle coverage below 98%: ${JSON.stringify(incomplete)}`)
  }

  const candidates = buildCandidates(timeframes)
  const screenDays = Math.min(28, historyDays - 14)
  const screenEnd = startTime + screenDays * DAY_MS
  // Use the complete 18-symbol basket for the training screen. The earlier
  // six-symbol shortcut was useful for runtime but could select a profile that
  // was structurally poor for the remaining twelve markets.
  const screeningSymbols = symbols
  const screeningMarket = new Map<string, DcaBacktestCandle[]>()
  for (const symbol of screeningSymbols) {
    for (const timeframe of timeframes) {
      screeningMarket.set(
        `${symbol}:${timeframe}`,
        (market.get(`${symbol}:${timeframe}`) || []).filter((candle) =>
          candle.time >= startTime && candle.time < screenEnd,
        ),
      )
    }
  }

  const screening: CandidateEvaluation[] = candidates.map((candidate, index) => {
    if (index > 0 && index % 250 === 0) {
      process.stderr.write(`[dca-42d] screened ${index}/${candidates.length}\n`)
    }
    const aggregate = evaluateCandidate(candidate, screeningMarket, screeningSymbols)
    return {
      candidate,
      aggregate,
      score: scoreSummary(aggregate, screeningSymbols.length, screenDays, candidate.lastStepStopBufferPct),
    }
  }).sort((left, right) => right.score - left.score)

  const overallTop = Math.max(80, Math.min(300, Math.floor(finiteNumber(process.env.DCA_SCREEN_TOP, 160))))
  const shortlist = new Map<string, Candidate>()
  for (const item of screening.slice(0, overallTop)) shortlist.set(item.candidate.id, item.candidate)
  const diversity = new Map<string, typeof screening[number]>()
  for (const item of screening) {
    const key = `${item.candidate.config.timeframeMinutes}|${item.candidate.config.entry}|${item.candidate.lastStepStopBufferPct}`
    if (!diversity.has(key)) diversity.set(key, item)
  }
  for (const item of diversity.values()) shortlist.set(item.candidate.id, item.candidate)
  // Always validate the existing default and prior 14-day risk candidate.
  for (const candidate of candidates.slice(-2)) shortlist.set(candidate.id, candidate)

  const foldMarkets = Array.from({ length: foldCount }, (_, foldIndex) => {
    const foldStart = startTime + foldIndex * ((historyDays * DAY_MS) / foldCount)
    const foldEnd = foldIndex === foldCount - 1
      ? endTime
      : startTime + (foldIndex + 1) * ((historyDays * DAY_MS) / foldCount)
    const values = new Map<string, DcaBacktestCandle[]>()
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        values.set(
          `${symbol}:${timeframe}`,
          (market.get(`${symbol}:${timeframe}`) || []).filter((candle) =>
            candle.time >= foldStart && candle.time < foldEnd,
          ),
        )
      }
    }
    return { index: foldIndex + 1, start: foldStart, end: foldEnd, market: values }
  })

  const minimumClosedTrades = Math.max(270, Math.floor(finiteNumber(process.env.DCA_MIN_CLOSED_TRADES, 360)))
  const maximumSymbolDrawdownPct = Math.max(1, finiteNumber(process.env.DCA_MAX_SYMBOL_DRAWDOWN_PCT, 6))
  const fullEvaluations = [...shortlist.values()].map((candidate, index) => {
    process.stderr.write(`[dca-42d] full validation ${index + 1}/${shortlist.size} ${candidate.id}\n`)
    const aggregate = evaluateCandidate(candidate, market, symbols)
    const folds = foldMarkets.map((fold) => ({
      index: fold.index,
      rangeStart: new Date(fold.start).toISOString(),
      rangeEnd: new Date(fold.end).toISOString(),
      aggregate: evaluateCandidate(candidate, fold.market, symbols),
    }))
    const positiveFolds = folds.filter((fold) => fold.aggregate.netPnlPct > 0).length
    const minimumFoldProfitFactor = Math.min(...folds.map((fold) =>
      fold.aggregate.profitFactorInfinite ? 99 : Number(fold.aggregate.profitFactor || 0),
    ))
    const strict = (
      aggregate.closedTrades >= minimumClosedTrades &&
      aggregate.symbols.every((row) => row.closedTrades >= 8) &&
      aggregate.directions.long.positions >= 80 &&
      aggregate.directions.short.positions >= 80 &&
      aggregate.netPnlPct > 0 &&
      (aggregate.profitFactorInfinite || Number(aggregate.profitFactor || 0) >= 1.1) &&
      aggregate.nonNegativeSymbols === symbols.length &&
      aggregate.maxSymbolEquityDrawdownPct <= maximumSymbolDrawdownPct &&
      aggregate.worstTradePnlPct >= -5 &&
      aggregate.maxPositionVolumeRatio <= 5 &&
      positiveFolds === foldCount &&
      minimumFoldProfitFactor >= 1
    )
    const robust = strict || (
      aggregate.closedTrades >= minimumClosedTrades &&
      aggregate.symbols.every((row) => row.closedTrades >= 6) &&
      aggregate.directions.long.positions >= 60 &&
      aggregate.directions.short.positions >= 60 &&
      aggregate.netPnlPct > 0 &&
      (aggregate.profitFactorInfinite || Number(aggregate.profitFactor || 0) >= 1.05) &&
      aggregate.profitableSymbols >= 15 &&
      aggregate.maxSymbolEquityDrawdownPct <= maximumSymbolDrawdownPct * 1.25 &&
      aggregate.worstTradePnlPct >= -6 &&
      aggregate.maxPositionVolumeRatio <= 5 &&
      positiveFolds >= foldCount - 1 &&
      minimumFoldProfitFactor >= 0.9
    )
    const foldPenalty = folds.reduce((sum, fold) =>
      sum + Math.max(0, -fold.aggregate.netPnlPct) + fold.aggregate.maxSymbolEquityDrawdownPct * 0.25,
    0)
    return {
      config: configProjection(candidate),
      qualification: strict ? "strict" : robust ? "robust" : "unqualified",
      positiveFolds,
      minimumFoldProfitFactor,
      score: scoreSummary(aggregate, symbols.length, historyDays, candidate.lastStepStopBufferPct) - foldPenalty,
      aggregate,
      folds,
    }
  }).sort((left, right) =>
    Number(right.qualification === "strict") - Number(left.qualification === "strict") ||
    Number(right.qualification === "robust") - Number(left.qualification === "robust") ||
    right.score - left.score,
  )

  const selected = fullEvaluations.find((item) => item.qualification === "strict") ||
    fullEvaluations.find((item) => item.qualification === "robust") ||
    fullEvaluations.find((item) =>
      item.aggregate.netPnlPct > 0 &&
      item.aggregate.maxPositionVolumeRatio <= 5 &&
      item.positiveFolds >= Math.ceil(foldCount * 0.67),
    ) ||
    fullEvaluations[0]

  const existingDefaultId = candidateId(makeCandidate({
    timeframeMinutes: 15,
    entry: "relative",
    volumes: [1, 1, 1, 1],
    distances: [0.3, 0.6, 1, 1.6],
    takeProfitPct: 0.6,
    stopBufferPct: 0.35,
    maxHoldMinutes: 12 * 60,
  }).config)
  const priorRiskId = candidateId(makeCandidate({
    timeframeMinutes: 15,
    entry: "relative",
    volumes: [1, 1, 1, 1],
    distances: [0.55, 1.1, 1.8, 2.8],
    takeProfitPct: 0.6,
    stopBufferPct: 0.35,
    maxHoldMinutes: 12 * 60,
  }).config)
  const baseline = fullEvaluations.find((item) => item.config.id === existingDefaultId) || null
  const priorRiskCandidate = fullEvaluations.find((item) => item.config.id === priorRiskId) || null

  const symbolAdaptive = buildSymbolAdaptiveValidation({
    candidates: screening,
    symbols,
    fullMarket: market,
    trainingMarket: screeningMarket,
    folds: foldMarkets,
    trainingEnd: screenEnd,
    historyDays,
  })

  const positiveCandidates = fullEvaluations.filter((item) => item.aggregate.netPnlPct > 0)
  const pareto = positiveCandidates.filter((candidate) => !positiveCandidates.some((other) =>
    other !== candidate &&
    other.aggregate.closedTrades >= candidate.aggregate.closedTrades &&
    other.aggregate.maxSymbolEquityDrawdownPct <= candidate.aggregate.maxSymbolEquityDrawdownPct &&
    Number(other.aggregate.profitFactorInfinite ? 99 : other.aggregate.profitFactor || 0) >=
      Number(candidate.aggregate.profitFactorInfinite ? 99 : candidate.aggregate.profitFactor || 0) &&
    (
      other.aggregate.closedTrades > candidate.aggregate.closedTrades ||
      other.aggregate.maxSymbolEquityDrawdownPct < candidate.aggregate.maxSymbolEquityDrawdownPct ||
      Number(other.aggregate.profitFactor || 0) > Number(candidate.aggregate.profitFactor || 0)
    )
  ))

  const stopBuffers = [...new Set(fullEvaluations.map((item) => item.config.lastStepStopBufferPct))].sort((a, b) => a - b)
  const stopBufferAnalysis = stopBuffers.map((buffer) => {
    const rows = fullEvaluations.filter((item) => item.config.lastStepStopBufferPct === buffer)
    const best = [...rows].sort((left, right) => right.score - left.score)[0]
    const safest = [...rows].filter((item) => item.aggregate.netPnlPct > 0)
      .sort((left, right) => left.aggregate.maxSymbolEquityDrawdownPct - right.aggregate.maxSymbolEquityDrawdownPct)[0]
    return {
      lastStepStopBufferPct: buffer,
      candidates: rows.length,
      strict: rows.filter((item) => item.qualification === "strict").length,
      robust: rows.filter((item) => item.qualification === "robust").length,
      maximumClosedTrades: Math.max(0, ...rows.map((item) => item.aggregate.closedTrades)),
      bestScoreCandidate: best ? { id: best.config.id, score: best.score, aggregate: best.aggregate } : null,
      lowestPositiveDrawdownCandidate: safest ? {
        id: safest.config.id,
        maxSymbolEquityDrawdownPct: safest.aggregate.maxSymbolEquityDrawdownPct,
        closedTrades: safest.aggregate.closedTrades,
        profitFactor: safest.aggregate.profitFactor,
      } : null,
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    historyDays,
    rangeStart: new Date(startTime).toISOString(),
    rangeEnd: new Date(endTime).toISOString(),
    symbols: symbols.map((symbol) => symbol.replace("-", "")),
    timeframesMinutes: timeframes,
    foldCount,
    candidateCount: candidates.length,
    screening: {
      symbols: screeningSymbols.map((symbol) => symbol.replace("-", "")),
      days: screenDays,
      rangeStart: new Date(startTime).toISOString(),
      rangeEnd: new Date(screenEnd).toISOString(),
      overallTop,
      diversityKey: "timeframe × entry × last-step SL buffer",
    },
    fullValidationCandidateCount: fullEvaluations.length,
    qualification: {
      minimumClosedTrades,
      strictRequiresAllSymbolsNonNegative: true,
      strictRequiresAllWeeklyFoldsPositive: true,
      minimumProfitFactor: 1.1,
      maximumSymbolEquityDrawdownPct: maximumSymbolDrawdownPct,
      maximumPositionVolumeRatio: 5,
      maximumSingleLossPct: 5,
    },
    qualifiedCounts: {
      strict: fullEvaluations.filter((item) => item.qualification === "strict").length,
      robust: fullEvaluations.filter((item) => item.qualification === "robust").length,
    },
    costModel: {
      roundTripCostPct: 0.1,
      slippagePctPerFill: 0.02,
      intrabarOrdering: "existing_stop_then_existing_tp_then_one_dca_add",
      pnlUnit: "sum of percentage outcomes relative to each initial position notional",
    },
    marketCoverage: coverage,
    selected,
    selectedVersusExistingDefault: baseline && selected ? {
      closedTradesDelta: selected.aggregate.closedTrades - baseline.aggregate.closedTrades,
      netPnlPctDelta: selected.aggregate.netPnlPct - baseline.aggregate.netPnlPct,
      profitFactorDelta: Number(selected.aggregate.profitFactor || 0) - Number(baseline.aggregate.profitFactor || 0),
      maxSymbolEquityDrawdownPctReduction:
        baseline.aggregate.maxSymbolEquityDrawdownPct - selected.aggregate.maxSymbolEquityDrawdownPct,
      worstTradePnlPctImprovement:
        selected.aggregate.worstTradePnlPct - baseline.aggregate.worstTradePnlPct,
    } : null,
    existingDefault: baseline,
    prior14DayRiskCandidate: priorRiskCandidate,
    symbolAdaptive,
    stopBufferAnalysis,
    paretoFrontier: pareto.sort((left, right) => right.aggregate.closedTrades - left.aggregate.closedTrades),
    highestActivity: [...fullEvaluations]
      .sort((left, right) => right.aggregate.closedTrades - left.aggregate.closedTrades || left.aggregate.maxSymbolEquityDrawdownPct - right.aggregate.maxSymbolEquityDrawdownPct)
      .slice(0, 20),
    lowestDrawdownPositive: [...positiveCandidates]
      .sort((left, right) => left.aggregate.maxSymbolEquityDrawdownPct - right.aggregate.maxSymbolEquityDrawdownPct || right.aggregate.closedTrades - left.aggregate.closedTrades)
      .slice(0, 20),
    top: fullEvaluations.slice(0, 40),
  }

  await mkdir(dirname(outputJson), { recursive: true })
  await mkdir(dirname(outputMarkdown), { recursive: true })
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(outputMarkdown, renderMarkdown(report), "utf8")
  process.stdout.write(`${JSON.stringify({
    success: true,
    outputJson,
    outputMarkdown,
    rangeStart: report.rangeStart,
    rangeEnd: report.rangeEnd,
    candidateCount: report.candidateCount,
    fullValidationCandidateCount: report.fullValidationCandidateCount,
    qualifiedCounts: report.qualifiedCounts,
    selected: report.selected ? {
      qualification: report.selected.qualification,
      config: report.selected.config,
      aggregate: {
        closedTrades: report.selected.aggregate.closedTrades,
        netPnlPct: report.selected.aggregate.netPnlPct,
        profitFactor: report.selected.aggregate.profitFactor,
        equalWeightPortfolioDrawdownPct: report.selected.aggregate.equalWeightPortfolioDrawdownPct,
      },
    } : null,
    symbolAdaptive: {
      qualification: report.symbolAdaptive.qualification,
      recommendation: report.symbolAdaptive.recommendation,
      activeSymbols: report.symbolAdaptive.activeSymbols,
      outOfSampleAggregate: report.symbolAdaptive.outOfSampleAggregate,
    },
  }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
