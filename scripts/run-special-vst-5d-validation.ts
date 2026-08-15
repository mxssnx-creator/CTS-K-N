#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fetchBingXPublic } from "@/lib/bingx-public-api"
import {
  DEFAULT_SPECIAL_STRATEGY_SETTINGS,
  calculateSpecial24HourTwoHourStats,
  walkForwardOptimizeSpecialStrategy,
  type SpecialBacktestResult,
  type SpecialBacktestSeries,
  type SpecialStrategySettings,
  type SpecialWalkForwardResult,
} from "@/lib/special-strategy"

const VST_ORIGIN = process.env.BINGX_PUBLIC_ORIGIN || "https://open-api-vst.bingx.com"
const VST_FALLBACK_ORIGIN = process.env.BINGX_PUBLIC_FALLBACK_ORIGIN || "https://open-api-vst.bingx.pro"
const VST_ORIGINS = [VST_ORIGIN, VST_FALLBACK_ORIGIN]
const DEFAULT_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"] as const
const TARGET_SYMBOL_COUNT = 4
const VOLATILITY_POOL_SIZE = 32
const SOURCE_INTERVAL_MS = 60_000
const DAYS = 5
const REQUIRED_ROWS = DAYS * 24 * 60
const PAGE_LIMIT = 1_000
const MAX_PAGES = 12
const MINIMUM_COVERAGE_RATIO = 0.95

type Kline = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type VolatilitySelection = {
  symbol: string
  rank: number
  score: number
  realizedVolatilityPct: number
  rangePct: number
  absoluteMovePct: number
  quoteVolume: number
  spreadBps: number
  rows: number
}

type VolatilityTickerCandidate = {
  symbol: string
  last: number
  quoteVolume: number
  spreadBps: number
}

type DataCoverage = {
  symbol: string
  rows: number
  expectedRows: number
  coverageRatio: number
  firstTimestamp: number
  lastTimestamp: number
  missingIntervals: number
  duplicateRowsRemoved: number
  pages: number
  fetchMs: number
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function metricSummary(result: SpecialBacktestResult) {
  return {
    exitVariant: result.exitVariant,
    qualified: result.qualified,
    totalTrades: result.totalTrades,
    longTrades: result.longTrades,
    shortTrades: result.shortTrades,
    profitFactor: round(result.profitFactor),
    stableProfitFactor: round(result.stableProfitFactor),
    profitFactorStdDev: round(result.profitFactorStdDev),
    stableDirectionProfitFactor: round(result.stableDirectionProfitFactor),
    directionProfitFactorStdDev: round(result.directionProfitFactorStdDev),
    maxDrawdownPct: round(result.maxDrawdownPct),
    netPnlPct: round(result.netPnlPct),
    robustScore: round(result.robustScore),
    symbolCoverageQualified: result.symbolCoverageQualified,
    directionCoverageQualified: result.directionCoverageQualified,
    bySymbol: Object.fromEntries(Object.entries(result.bySymbol).map(([symbol, metrics]) => [
      symbol,
      {
        trades: metrics.trades,
        wins: metrics.wins,
        losses: metrics.losses,
        profitFactor: round(metrics.profitFactor),
        maxDrawdownPct: round(metrics.maxDrawdownPct),
        netPnlPct: round(metrics.netPnlPct),
      },
    ])),
    byDirection: Object.fromEntries(Object.entries(result.byDirection).map(([direction, metrics]) => [
      direction,
      {
        trades: metrics.trades,
        wins: metrics.wins,
        losses: metrics.losses,
        profitFactor: round(metrics.profitFactor),
        maxDrawdownPct: round(metrics.maxDrawdownPct),
        netPnlPct: round(metrics.netPnlPct),
      },
    ])),
  }
}

function settingsSummary(settings: SpecialStrategySettings) {
  return {
    minStep: settings.minStep,
    maxStep: settings.maxStep,
    stepSize: settings.stepSize,
    minimumAgreement: settings.minimumAgreement,
    minimumMarketChangePct: settings.minimumMarketChangePct,
    minimumScore: settings.minimumScore,
    minimumActivityRatio: settings.minimumActivityRatio,
    maximumVolatilityPct: settings.maximumVolatilityPct,
    targetHoldingSeconds: settings.targetHoldingSeconds,
    maximumHoldingSeconds: settings.maximumHoldingSeconds,
    timeframe15sEnabled: settings.timeframe15sEnabled,
    timeframe1mEnabled: settings.timeframe1mEnabled,
    timeframe15mEnabled: settings.timeframe15mEnabled,
    timeframe30mEnabled: settings.timeframe30mEnabled,
    individualTimeframesEnabled: settings.individualTimeframesEnabled,
    combinedTimeframesEnabled: settings.combinedTimeframesEnabled,
    maxPositionsPerDirection: settings.maxPositionsPerDirection,
    maxVolumeRatio: settings.maxVolumeRatio,
    additionalPositionStepPositionCostRatio: settings.additionalPositionStepPositionCostRatio,
    takeProfitMinPositionCostRatio: settings.takeProfitMinPositionCostRatio,
    stopLossMaxTakeProfitRatio: settings.stopLossMaxTakeProfitRatio,
    trailingEnabled: settings.trailingEnabled,
    trailingAdaptiveEnabled: settings.trailingAdaptiveEnabled,
    roundTripCostPct: settings.roundTripCostPct,
  }
}

function rankedSummary(item: SpecialWalkForwardResult, rank: number) {
  return {
    rank,
    exitVariant: item.result.exitVariant,
    walkForwardQualified: item.walkForwardQualified,
    catastrophicVeto: item.catastrophicVeto,
    walkForwardScore: round(item.walkForwardScore),
    worstFoldProfitFactor: round(item.worstFoldProfitFactor),
    foldProfitFactorStdDev: round(item.foldProfitFactorStdDev),
    settings: settingsSummary(item.settings),
    fullPeriod: metricSummary(item.result),
    folds: item.folds.map((fold, foldIndex) => ({
      fold: foldIndex + 1,
      ...metricSummary(fold),
    })),
  }
}

async function vstJson(path: string): Promise<any> {
  const response = await fetchBingXPublic(path, {}, {
    origins: VST_ORIGINS,
    timeoutMs: 20_000,
  })
  const payload = await response.json().catch(() => null) as any
  if (!response.ok) throw new Error(`VST HTTP ${response.status} for ${path}`)
  if (!payload || (payload.code !== 0 && payload.code !== "0")) {
    throw new Error(`VST code=${payload?.code ?? "invalid-json"}: ${payload?.msg || path}`)
  }
  return payload
}

async function fetchKlines(symbol: string): Promise<{
  rows: Kline[]
  pages: number
  duplicateRowsRemoved: number
  fetchMs: number
}> {
  const startedAt = Date.now()
  const byTimestamp = new Map<number, Kline>()
  let endTime: number | undefined
  let pages = 0
  let rawRows = 0
  let previousOldest = Number.POSITIVE_INFINITY

  while (pages < MAX_PAGES) {
    const query = new URLSearchParams({
      symbol,
      interval: "1m",
      limit: String(PAGE_LIMIT),
    })
    if (endTime !== undefined) query.set("endTime", String(endTime))
    const payload = await vstJson(`/openApi/swap/v3/quote/klines?${query}`)
    const page = Array.isArray(payload.data) ? payload.data : []
    if (page.length === 0) break
    rawRows += page.length
    for (const row of page) {
      const timestamp = finite(row?.time ?? row?.[0])
      const open = finite(row?.open ?? row?.[1])
      const high = finite(row?.high ?? row?.[2])
      const low = finite(row?.low ?? row?.[3])
      const close = finite(row?.close ?? row?.[4])
      const volume = finite(row?.volume ?? row?.[5])
      if (!(timestamp > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || volume < 0) continue
      byTimestamp.set(timestamp, { timestamp, open, high, low, close, volume })
    }
    pages++
    const oldest = Math.min(...page.map((row: any) => finite(row?.time ?? row?.[0])).filter((value: number) => value > 0))
    if (!Number.isFinite(oldest) || oldest >= previousOldest) break
    previousOldest = oldest
    endTime = oldest - SOURCE_INTERVAL_MS
    if (byTimestamp.size >= REQUIRED_ROWS + 180) break
  }

  return {
    rows: [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp),
    pages,
    duplicateRowsRemoved: Math.max(0, rawRows - byTimestamp.size),
    fetchMs: Date.now() - startedAt,
  }
}

async function selectMostVolatileSymbols(): Promise<{
  symbols: string[]
  selection: VolatilitySelection[]
  poolSize: number
}> {
  const configured = String(process.env.SPECIAL_VST_SYMBOLS || "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
  if (configured.length > 0) {
    if (configured.length !== TARGET_SYMBOL_COUNT) {
      throw new Error(`SPECIAL_VST_SYMBOLS must contain exactly ${TARGET_SYMBOL_COUNT} symbols`)
    }
    return {
      symbols: configured,
      selection: configured.map((symbol, index) => ({
        symbol,
        rank: index + 1,
        score: 0,
        realizedVolatilityPct: 0,
        rangePct: 0,
        absoluteMovePct: 0,
        quoteVolume: 0,
        spreadBps: 0,
        rows: 0,
      })),
      poolSize: configured.length,
    }
  }

  const tickerPayload = await vstJson("/openApi/swap/v2/quote/ticker")
  const liquidPool: VolatilityTickerCandidate[] = (Array.isArray(tickerPayload.data) ? tickerPayload.data : [])
    .map((row: any) => {
      const symbol = String(row?.symbol || "").trim().toUpperCase()
      const last = finite(row?.lastPrice ?? row?.price)
      const bid = finite(row?.bidPrice ?? row?.bid)
      const ask = finite(row?.askPrice ?? row?.ask)
      return {
        symbol,
        last,
        quoteVolume: finite(row?.quoteVolume ?? row?.turnover),
        spreadBps: bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : Number.POSITIVE_INFINITY,
      }
    })
    .filter((row: any) => row.symbol.endsWith("-USDT") && row.last > 0 && row.quoteVolume > 0 && row.spreadBps <= 50)
    .sort((left: any, right: any) => right.quoteVolume - left.quoteVolume)
    .slice(0, VOLATILITY_POOL_SIZE)
  if (liquidPool.length < TARGET_SYMBOL_COUNT) {
    throw new Error(`Only ${liquidPool.length} liquid VST USDT symbols were available`)
  }

  const measuredRows = await mapWithConcurrency<VolatilityTickerCandidate, VolatilitySelection | null>(liquidPool, 4, async (ticker) => {
    try {
      const query = new URLSearchParams({ symbol: ticker.symbol, interval: "1m", limit: "60" })
      const payload = await vstJson(`/openApi/swap/v3/quote/klines?${query}`)
      const rows = (Array.isArray(payload.data) ? payload.data : [])
        .map((row: any) => ({
          timestamp: finite(row?.time ?? row?.[0]),
          high: finite(row?.high ?? row?.[2]),
          low: finite(row?.low ?? row?.[3]),
          close: finite(row?.close ?? row?.[4]),
        }))
        .filter((row: any) => row.timestamp > 0 && row.high > 0 && row.low > 0 && row.close > 0)
        .sort((left: any, right: any) => left.timestamp - right.timestamp)
      if (rows.length < 55) return null
      const returns = rows.slice(1).map((row: any, index: number) => Math.log(row.close / rows[index].close))
      const realizedVolatilityPct = Math.sqrt(returns.reduce((sum: number, value: number) => sum + value * value, 0)) * 100
      const first = rows[0].close
      const last = rows.at(-1)!.close
      const rangePct = ((Math.max(...rows.map((row: any) => row.high)) - Math.min(...rows.map((row: any) => row.low))) / first) * 100
      const absoluteMovePct = Math.abs((last - first) / first) * 100
      // Realized return volatility is primary. Range and displacement break
      // ties without allowing one isolated wick to dominate the selection.
      const score = realizedVolatilityPct + rangePct * 0.2 + absoluteMovePct * 0.1
      return {
        symbol: ticker.symbol,
        rank: 0,
        score: round(score),
        realizedVolatilityPct: round(realizedVolatilityPct),
        rangePct: round(rangePct),
        absoluteMovePct: round(absoluteMovePct),
        quoteVolume: ticker.quoteVolume,
        spreadBps: round(ticker.spreadBps),
        rows: rows.length,
      }
    } catch {
      return null
    }
  })
  const measured = measuredRows.filter((row): row is VolatilitySelection => row !== null)
    .sort((left, right) => right.score - left.score || right.quoteVolume - left.quoteVolume)
  if (measured.length < TARGET_SYMBOL_COUNT) {
    throw new Error(`Only ${measured.length} symbols had complete one-hour VST volatility data`)
  }
  // Return the complete measured ranking. The caller verifies five-day
  // history in rank order and promotes the next candidate when a newly listed
  // high-volatility contract cannot cover the requested validation window.
  const selection = measured.map((row, index) => ({ ...row, rank: index + 1 }))
  return { symbols: selection.map((row) => row.symbol), selection, poolSize: measured.length }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      output[index] = await worker(values[index])
    }
  })
  await Promise.all(workers)
  return output
}

function candidateSettings(): Partial<SpecialStrategySettings>[] {
  const common: Partial<SpecialStrategySettings> = {
    timeframe15sEnabled: true,
    timeframe1mEnabled: true,
    timeframe15mEnabled: true,
    timeframe30mEnabled: true,
    individualTimeframesEnabled: true,
    combinedTimeframesEnabled: true,
    maxPositionsPerDirection: 5,
    maxVolumeRatio: 3,
    additionalPositionStepPositionCostRatio: 3,
    nonTrailingVariantEnabled: true,
    trailingEnabled: true,
    trailingAdaptiveEnabled: true,
    walkForwardFolds: 4,
    walkForwardPurgeSteps: 30,
    backtestMinimumStableProfitFactor: 1.15,
    backtestMaximumDrawdownPct: 12,
    roundTripCostPct: 0.12,
    marketActivityFadeRatio: 0.5,
  }
  return [
    {
      ...common,
      minStep: 3,
      maxStep: 12,
      stepSize: 3,
      individualTimeframesEnabled: false,
      combinedTimeframesEnabled: true,
      requireHigherTimeframeAlignment: true,
      minimumAgreement: 0.68,
      minimumMarketChangePct: 0.15,
      minimumScore: 1.25,
      minimumActivityRatio: 1.05,
      takeProfitMinPositionCostRatio: 4,
      targetHoldingSeconds: 180,
      maximumHoldingSteps: 15,
      maximumHoldingSeconds: 900,
    },
    {
      ...common,
      minStep: 6,
      maxStep: 24,
      stepSize: 3,
      individualTimeframesEnabled: false,
      combinedTimeframesEnabled: true,
      requireHigherTimeframeAlignment: true,
      minimumAgreement: 0.7,
      minimumMarketChangePct: 0.2,
      minimumScore: 1.4,
      minimumActivityRatio: 1.08,
      takeProfitMinPositionCostRatio: 4,
      targetHoldingSeconds: 300,
      maximumHoldingSteps: 30,
      maximumHoldingSeconds: 1_800,
    },
    {
      ...common,
      minStep: 9,
      maxStep: 30,
      stepSize: 3,
      individualTimeframesEnabled: false,
      combinedTimeframesEnabled: true,
      requireHigherTimeframeAlignment: true,
      minimumAgreement: 0.74,
      minimumMarketChangePct: 0.3,
      minimumScore: 1.6,
      minimumActivityRatio: 1.05,
      takeProfitMinPositionCostRatio: 5,
      targetHoldingSeconds: 600,
      maximumHoldingSteps: 60,
      maximumHoldingSeconds: 3_600,
    },
    {
      ...common,
      minStep: 3,
      maxStep: 12,
      stepSize: 3,
      timeframe15mEnabled: false,
      timeframe30mEnabled: false,
      individualTimeframesEnabled: true,
      combinedTimeframesEnabled: false,
      momentumWeight: 0.55,
      marketChangeSpeedWeight: 0.5,
      activityWeight: 0.25,
      volatilityWeight: 0.2,
      minimumAgreement: 0.75,
      minimumMarketChangePct: 0.25,
      minimumScore: 1.5,
      minimumActivityRatio: 1.12,
      takeProfitMinPositionCostRatio: 4,
      targetHoldingSeconds: 120,
      maximumHoldingSteps: 10,
      maximumHoldingSeconds: 600,
    },
    {
      ...common,
      minStep: 6,
      maxStep: 24,
      stepSize: 3,
      individualTimeframesEnabled: false,
      combinedTimeframesEnabled: true,
      requireHigherTimeframeAlignment: true,
      momentumWeight: 0.35,
      activityWeight: 0.5,
      activityBreakoutRatio: 1.25,
      minimumActivityRatio: 1.2,
      minimumMarketChangePct: 0.12,
      minimumScore: 1.5,
      takeProfitMinPositionCostRatio: 4,
      targetHoldingSeconds: 300,
      maximumHoldingSteps: 30,
      maximumHoldingSeconds: 1_800,
    },
    {
      ...common,
      minStep: 3,
      maxStep: 12,
      stepSize: 3,
      timeframe1mEnabled: false,
      timeframe15mEnabled: true,
      timeframe30mEnabled: true,
      individualTimeframesEnabled: true,
      combinedTimeframesEnabled: true,
      minimumTimeframeConfirmations: 2,
      requireHigherTimeframeAlignment: true,
      minimumAgreement: 0.72,
      minimumMarketChangePct: 0.25,
      minimumScore: 1.5,
      volatilityTargetPct: 0.18,
      minimumVolatilityVolumeScale: 0.2,
      takeProfitMinPositionCostRatio: 5,
      targetHoldingSeconds: 900,
      maximumHoldingSteps: 90,
      maximumHoldingSeconds: 5_400,
    },
  ]
}

function intervalMarkdown(stats: ReturnType<typeof calculateSpecial24HourTwoHourStats>): string[] {
  return [
    "| UTC interval | PIs | Long | Short | PF | DD max % | DDT max |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...stats.map((row) =>
      `| ${iso(row.intervalStart).slice(0, 16)}–${iso(row.intervalEnd).slice(11, 16)} | ${row.pisCount} | ${row.longCount} | ${row.shortCount} | ${round(row.profitFactor, 3)} | ${round(row.maxDrawdownPct, 3)} | ${Math.round(row.maxDrawdownDurationSeconds)}s |`,
    ),
  ]
}

function resultMarkdown(
  title: string,
  item: SpecialWalkForwardResult | undefined,
  sharedEndTimestamp: number,
): string[] {
  if (!item) return [`## ${title}`, "", "No result was produced."]
  const result = item.result
  return [
    `## ${title}`,
    "",
    `Walk-forward qualified: **${item.walkForwardQualified ? "yes" : "no"}**; full-period qualified: **${result.qualified ? "yes" : "no"}**.`,
    "",
    `PIs ${result.totalTrades} (Long ${result.longTrades}, Short ${result.shortTrades}); PF ${round(result.profitFactor, 3)}; stable PF ${round(result.stableProfitFactor, 3)}; worst-fold PF ${round(item.worstFoldProfitFactor, 3)}; max DD ${round(result.maxDrawdownPct, 3)}%; net ${round(result.netPnlPct, 3)}%.`,
    "",
    "### Last 24 hours, all symbols combined, two-hour intervals",
    "",
    ...intervalMarkdown(calculateSpecial24HourTwoHourStats(result.trades, sharedEndTimestamp)),
  ]
}

async function main(): Promise<void> {
  if (new URL(VST_ORIGIN).origin !== VST_ORIGIN.replace(/\/$/, "")) throw new Error("VST origin invariant failed")
  const startedAt = Date.now()
  const memoryBefore = process.memoryUsage()
  let peakRss = memoryBefore.rss
  let peakHeapUsed = memoryBefore.heapUsed
  const memorySampler = setInterval(() => {
    const usage = process.memoryUsage()
    peakRss = Math.max(peakRss, usage.rss)
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed)
  }, 50)

  try {
    let fifteenSecondProbe: Record<string, unknown>
    try {
      await vstJson("/openApi/swap/v3/quote/klines?symbol=BTC-USDT&interval=15s&limit=5")
      fifteenSecondProbe = { available: true, code: 0 }
    } catch (error) {
      fifteenSecondProbe = {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const volatilitySelection = await selectMostVolatileSymbols()
    const explicitSymbols = Boolean(process.env.SPECIAL_VST_SYMBOLS)
    const rejectedVolatilityCandidates: Array<{
      symbol: string
      volatilityRank: number
      coverageRatio: number
      reason: string
    }> = []
    const eligibleFetched: Array<{
      candidate: VolatilitySelection
      data: Awaited<ReturnType<typeof fetchKlines>>
    }> = []
    // Verify five-day history in volatility order. This is intentionally
    // sequential and stops as soon as four contracts qualify, avoiding a
    // 32-symbol five-day download while still handling fresh listings safely.
    for (const candidate of volatilitySelection.selection) {
      let data: Awaited<ReturnType<typeof fetchKlines>>
      try {
        data = await fetchKlines(candidate.symbol)
      } catch (error) {
        rejectedVolatilityCandidates.push({
          symbol: candidate.symbol,
          volatilityRank: candidate.rank,
          coverageRatio: 0,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const candidateEnd = data.rows.at(-1)?.timestamp || 0
      const candidateStart = candidateEnd - (REQUIRED_ROWS - 1) * SOURCE_INTERVAL_MS
      const candidateRows = data.rows.filter(
        (row) => row.timestamp >= candidateStart && row.timestamp <= candidateEnd,
      )
      const candidateCoverageRatio = candidateRows.length / REQUIRED_ROWS
      if (!(candidateEnd > 0) || candidateCoverageRatio < MINIMUM_COVERAGE_RATIO) {
        rejectedVolatilityCandidates.push({
          symbol: candidate.symbol,
          volatilityRank: candidate.rank,
          coverageRatio: round(candidateCoverageRatio),
          reason: `five-day coverage ${percent(candidateCoverageRatio)} is below ${percent(MINIMUM_COVERAGE_RATIO)}`,
        })
        continue
      }
      eligibleFetched.push({ candidate, data })
      if (eligibleFetched.length >= TARGET_SYMBOL_COUNT) break
    }
    if (eligibleFetched.length < TARGET_SYMBOL_COUNT) {
      throw new Error(
        `Only ${eligibleFetched.length} ${explicitSymbols ? "explicit" : "ranked"} symbols had ` +
        `${percent(MINIMUM_COVERAGE_RATIO)} five-day VST coverage`,
      )
    }
    const selectedVolatility = eligibleFetched.map(({ candidate }, index) => ({
      ...candidate,
      rank: index + 1,
    }))
    const symbols = selectedVolatility.map((item) => item.symbol)
    const fetched = eligibleFetched.map(({ candidate, data }) => ({
      symbol: candidate.symbol,
      ...data,
    }))
    const commonEnd = Math.min(...fetched.map((item) => item.rows.at(-1)?.timestamp || 0))
    if (!(commonEnd > 0)) throw new Error("No common VST data endpoint was available")
    const commonStart = commonEnd - (REQUIRED_ROWS - 1) * SOURCE_INTERVAL_MS
    const coverage: DataCoverage[] = []
    const series: SpecialBacktestSeries[] = fetched.map((item) => {
      const rows = item.rows.filter((row) => row.timestamp >= commonStart && row.timestamp <= commonEnd)
      let missingIntervals = 0
      for (let index = 1; index < rows.length; index++) {
        missingIntervals += Math.max(0, Math.round((rows[index].timestamp - rows[index - 1].timestamp) / SOURCE_INTERVAL_MS) - 1)
      }
      const coverageRatio = rows.length / REQUIRED_ROWS
      coverage.push({
        symbol: item.symbol,
        rows: rows.length,
        expectedRows: REQUIRED_ROWS,
        coverageRatio: round(coverageRatio),
        firstTimestamp: rows[0]?.timestamp || 0,
        lastTimestamp: rows.at(-1)?.timestamp || 0,
        missingIntervals,
        duplicateRowsRemoved: item.duplicateRowsRemoved,
        pages: item.pages,
        fetchMs: item.fetchMs,
      })
      if (coverageRatio < MINIMUM_COVERAGE_RATIO) {
        throw new Error(`${item.symbol} coverage ${percent(coverageRatio)} is below ${percent(MINIMUM_COVERAGE_RATIO)}`)
      }
      return {
        symbol: item.symbol,
        closes: rows.map((row) => row.close),
        volumes: rows.map((row) => row.volume),
        timestamps: rows.map((row) => row.timestamp),
      }
    })

    const optimizationStartedAt = Date.now()
    const ranked = walkForwardOptimizeSpecialStrategy({
      series,
      candidates: candidateSettings(),
      baseSettings: DEFAULT_SPECIAL_STRATEGY_SETTINGS,
      positionCostPct: 0.1,
    })
    const optimizationMs = Date.now() - optimizationStartedAt
    const bestFixed = ranked.find((item) => item.result.exitVariant === "fixed")
    const bestTrailing = ranked.find((item) => item.result.exitVariant === "trailing")
    const best = ranked[0]
    // Fixed and Trailing must be compared over the exact same market clock.
    // Using each ledger's last trade would shift sparse variants into different
    // 24-hour windows and make their two-hour rows look comparable when they
    // are not.
    const stats24hTwoHourByVariant = {
      fixed: bestFixed
        ? calculateSpecial24HourTwoHourStats(bestFixed.result.trades, commonEnd)
        : [],
      trailing: bestTrailing
        ? calculateSpecial24HourTwoHourStats(bestTrailing.result.trades, commonEnd)
        : [],
    }
    const fifteenSecondHistoricalCoverage = fifteenSecondProbe.available === true
    const automaticActivationEligible = Boolean(best?.walkForwardQualified) && fifteenSecondHistoricalCoverage
    const deploymentDecision = automaticActivationEligible
      ? "ELIGIBLE_FOR_OPERATOR_REVIEW"
      : best?.walkForwardQualified
        ? "REJECTED_INCOMPLETE_15S_HISTORICAL_COVERAGE"
        : "REJECTED_NO_WALK_FORWARD_QUALIFIED_CONFIGURATION"

    if (global.gc) global.gc()
    const memoryAfter = process.memoryUsage()
    const report = {
      schemaVersion: 1,
      runMode: "read-only-causal-bingx-prod-vst-validation",
      orderRequests: 0,
      authenticatedRequests: 0,
      baseUrl: VST_ORIGIN,
      endpoint: "/openApi/swap/v3/quote/klines",
      sourceInterval: "1m",
      requestedDays: DAYS,
      commonWindow: { start: iso(commonStart), end: iso(commonEnd) },
      symbols,
      symbolSelection: {
        mode: explicitSymbols ? "explicit-control" : "most-volatile-1h-with-five-day-coverage-among-top-liquid-vst-usdt",
        liquidityPoolLimit: VOLATILITY_POOL_SIZE,
        measuredPoolSize: volatilitySelection.poolSize,
        ranking: selectedVolatility,
        rejectedInsufficientCoverage: rejectedVolatilityCandidates,
      },
      coverage,
      featureCoverage: {
        timeframe15s: { historical: fifteenSecondHistoricalCoverage, probe: fifteenSecondProbe, fabricated: false },
        timeframe1m: { historical: true, native: true },
        timeframe15m: { historical: true, causallyAggregatedFrom: "1m" },
        timeframe30m: { historical: true, causallyAggregatedFrom: "1m" },
        marketChangeSpeedPerSecond: true,
        acceleration: true,
        volumeActivity: true,
        historicalOrderFlowImbalance: false,
        historicalSpread: false,
        oneHourVolatilitySelection: !explicitSymbols,
        fiveDayCoverageFallback: !explicitSymbols,
      },
      costModel: { positionCostPct: 0.1, roundTripCostPct: 0.12, assumption: "0.10% taker round trip + 0.02% slippage buffer" },
      candidateCountBeforeExitExpansion: candidateSettings().length,
      evaluatedConfigurationCount: ranked.length,
      deploymentDecision,
      automaticActivationEligible,
      reason: automaticActivationEligible
        ? "Every configured qualification and source-coverage gate passed."
        : "Fail-closed: no configuration is auto-applied when walk-forward or requested timeframe coverage is incomplete.",
      bestFirst: ranked.map((item, index) => rankedSummary(item, index + 1)),
      bestFixed: bestFixed ? rankedSummary(bestFixed, ranked.indexOf(bestFixed) + 1) : null,
      bestTrailing: bestTrailing ? rankedSummary(bestTrailing, ranked.indexOf(bestTrailing) + 1) : null,
      stats24hWindow: {
        commonMarketEnd: iso(commonEnd),
        alignedEnd: iso(stats24hTwoHourByVariant.fixed[11]?.intervalEnd
          || stats24hTwoHourByVariant.trailing[11]?.intervalEnd
          || commonEnd),
        intervals: 12,
        intervalHours: 2,
      },
      stats24hTwoHourByVariant,
      diagnostics: {
        naturallyAsymmetricBestCounts: best ? best.result.longTrades !== best.result.shortTrades : false,
        fixedTrailingIndependentLedgers: bestFixed && bestTrailing
          ? bestFixed.result.exitVariant !== bestTrailing.result.exitVariant
          : false,
        allSymbolsCombined: true,
        chronologicalPurgedWalkForward: true,
        lookAheadUsed: false,
      },
      performance: {
        totalMs: Date.now() - startedAt,
        optimizationMs,
        peakRssMb: round(peakRss / 1024 / 1024, 3),
        peakHeapUsedMb: round(peakHeapUsed / 1024 / 1024, 3),
        heapBeforeMb: round(memoryBefore.heapUsed / 1024 / 1024, 3),
        heapAfterGcMb: round(memoryAfter.heapUsed / 1024 / 1024, 3),
      },
      limitations: [
        "BingX Prod-VST historical klines reject 15s; the validator does not fabricate 15-second bars.",
        "Historical quote snapshots do not provide synchronized order-book OFI or spread for the full five-day window.",
        "A five-day demo sample is validation evidence, not a guarantee of future profit or highest achievable performance.",
      ],
      generatedAt: new Date().toISOString(),
    }

    const markdown = [
      "# Special — BingX Prod-VST five-day validation",
      "",
      `Decision: **${deploymentDecision}**. No configuration was auto-applied.`,
      "",
      `Source: \`${VST_ORIGIN}\`, read-only 1m swap klines, ${iso(commonStart)} to ${iso(commonEnd)}. The four most volatile symbols over the preceding hour were selected from the ${VOLATILITY_POOL_SIZE} most liquid eligible VST USDT contracts; ${ranked.length} independent Fixed/Trailing configurations used four purged chronological folds.`,
      "",
      "## Most volatile one-hour symbols (best first)",
      "",
      "| Rank | Symbol | 1h realised vol % | 1h range % | Abs move % | Spread bps | Quote volume |",
      "|---:|---|---:|---:|---:|---:|---:|",
      ...selectedVolatility.map((item) => `| ${item.rank} | ${item.symbol} | ${item.realizedVolatilityPct} | ${item.rangePct} | ${item.absoluteMovePct} | ${item.spreadBps} | ${Math.round(item.quoteVolume)} |`),
      "",
      rejectedVolatilityCandidates.length > 0
        ? `Skipped for incomplete five-day history: ${rejectedVolatilityCandidates.map((item) => `${item.symbol} (${percent(item.coverageRatio)})`).join(", ")}.`
        : "No higher-ranked volatility candidate was skipped for incomplete five-day history.",
      "",
      "The 15-second historical endpoint is unavailable and no synthetic 15-second bars were created. Therefore even a profitable candidate remains blocked from automatic activation until genuine 15-second VST history/live replay covers that lane.",
      "",
      "## Data coverage",
      "",
      "| Symbol | Rows | Coverage | Missing intervals | Pages | Fetch ms |",
      "|---|---:|---:|---:|---:|---:|",
      ...coverage.map((item) => `| ${item.symbol} | ${item.rows} | ${percent(item.coverageRatio)} | ${item.missingIntervals} | ${item.pages} | ${item.fetchMs} |`),
      "",
      ...resultMarkdown("Best Fixed variant", bestFixed, commonEnd),
      "",
      ...resultMarkdown("Best adaptive Trailing variant", bestTrailing, commonEnd),
      "",
      "## Performance and limitations",
      "",
      `Optimization ${optimizationMs}ms; peak RSS ${round(peakRss / 1024 / 1024, 2)}MB; peak heap ${round(peakHeapUsed / 1024 / 1024, 2)}MB.`,
      "",
      "- Counts are produced from separate Long and Short ledgers; equality is neither forced nor used as a success criterion.",
      "- PF includes the configured round-trip cost assumption; DD is an additive percentage-equity drawdown in this validation model.",
      "- OFI and historical spread are not claimed because synchronized VST history was unavailable from the tested public route.",
      "- Five days cannot prove future profitability; failed qualification or incomplete coverage blocks activation.",
      "",
    ].join("\n")

    const outputDir = join(process.cwd(), ".agent-logs")
    await mkdir(outputDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const jsonPath = join(outputDir, `special-vst-5d-${timestamp}.json`)
    const markdownPath = join(outputDir, `special-vst-5d-${timestamp}.md`)
    await Promise.all([
      writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(markdownPath, `${markdown}\n`, "utf8"),
    ])
    console.log(JSON.stringify({
      success: true,
      deploymentDecision,
      automaticActivationEligible,
      reportPath: jsonPath,
      markdownPath,
      best: best ? rankedSummary(best, 1) : null,
      performance: report.performance,
    }, null, 2))
  } finally {
    clearInterval(memorySampler)
  }
}

main().catch((error) => {
  console.error(`[special-vst-5d] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
