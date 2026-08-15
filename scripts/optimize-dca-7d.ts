#!/usr/bin/env tsx

import { writeFile } from "node:fs/promises"
import {
  runDcaBacktest,
  type DcaBacktestCandle,
  type DcaBacktestConfig,
  type DcaBacktestEntry,
} from "../lib/dca-backtest"
import { normalizeDcaProfile } from "../lib/dca-strategy"

const SYMBOLS = ["BTC-USDT", "SOL-USDT", "BCH-USDT", "XRP-USDT"] as const
const TIMEFRAMES = [5, 15, 30] as const
const ENTRY_MODES: DcaBacktestEntry[] = ["momentum", "mean_reversion", "breakout", "relative"]
const API_ORIGIN = "https://open-api.bingx.com"
const DAY_MS = 24 * 60 * 60 * 1_000

async function fetchHistoricDays(
  symbol: string,
  timeframe: 5 | 15 | 30,
  endTime: number,
  historyDays: number,
): Promise<DcaBacktestCandle[]> {
  const startTime = endTime - historyDays * DAY_MS
  const rows = new Map<number, DcaBacktestCandle>()
  let pageEnd = endTime
  // BingX caps a page below the requested 1,440 rows. Derive the page budget
  // from the exact horizon/timeframe and keep two overlap/error-margin pages.
  const maximumPages = Math.min(
    64,
    Math.ceil((historyDays * 24 * 60) / timeframe / 1_000) + 2,
  )
  for (let page = 0; page < maximumPages; page++) {
    const url = new URL("/openApi/swap/v3/quote/klines", API_ORIGIN)
    url.searchParams.set("symbol", symbol)
    url.searchParams.set("interval", `${timeframe}m`)
    url.searchParams.set("limit", "1440")
    url.searchParams.set("endTime", String(pageEnd))
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`${symbol} ${timeframe}m: HTTP ${response.status}`)
    const payload = await response.json() as { code?: number; msg?: string; data?: Array<Record<string, unknown>> }
    if (Number(payload.code) !== 0 || !Array.isArray(payload.data)) {
      throw new Error(`${symbol} ${timeframe}m: ${payload.msg || "invalid response"}`)
    }
    let earliest = Number.POSITIVE_INFINITY
    for (const raw of payload.data) {
      const time = Number(raw.time)
      earliest = Math.min(earliest, time)
      if (time < startTime || time > endTime) continue
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
    // BingX currently caps this endpoint at 1,000 rows even when a larger
    // limit is requested. Page until the exact historic boundary instead of
    // mistaking the venue cap for end-of-history.
    if (!Number.isFinite(earliest) || earliest <= startTime || payload.data.length === 0) break
    pageEnd = earliest - 1
  }
  return [...rows.values()].sort((left, right) => left.time - right.time)
}

const volumeLadders = [
  [0.25, 0.4, 0.55, 0.8],
  [0.35, 0.5, 0.65, 1],
  [0.4, 0.6, 0.8, 1.2],
  [0.5, 0.75, 1, 1.75],
  [0.75, 0.75, 1, 1.5],
  [0.4, 0.6, 1.2, 1.8],
  [1, 1, 1, 1],
]
const distanceLadders = [
  [0.2, 0.4, 0.7, 1.1],
  [0.3, 0.6, 1, 1.6],
  [0.4, 0.8, 1.3, 2],
  [0.55, 1.1, 1.8, 2.8],
]
const takeProfits = [0.4, 0.6, 0.8]
const stopBuffers = [0.35, 0.6]

function candidateKey(config: DcaBacktestConfig): string {
  return JSON.stringify({
    timeframeMinutes: config.timeframeMinutes,
    entry: config.entry,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    stepVolumeMultipliers: config.profile.stepVolumeMultipliers,
    stepDistancesPct: config.profile.stepDistancesPct,
    maxPositionVolumeRatio: config.profile.maxPositionVolumeRatio,
  })
}

async function main() {
  const requestedEnd = Number(process.env.DCA_BACKTEST_END_MS)
  const endTime = Number.isFinite(requestedEnd) && requestedEnd > 0
    ? requestedEnd
    : Date.now()
  const requestedDays = Number(process.env.DCA_BACKTEST_DAYS)
  const historyDays = Number.isFinite(requestedDays)
    ? Math.max(1, Math.min(30, Math.floor(requestedDays)))
    : 14
  const requestedFolds = Number(process.env.DCA_BACKTEST_FOLDS)
  const foldCount = Number.isFinite(requestedFolds)
    ? Math.max(2, Math.min(4, Math.floor(requestedFolds)))
    : 2
  const requestedMaximumDrawdown = Number(process.env.DCA_MAX_EQUITY_DRAWDOWN_PCT)
  const maximumEquityDrawdownPct = Number.isFinite(requestedMaximumDrawdown)
    ? Math.max(0.1, Math.min(100, requestedMaximumDrawdown))
    : 10
  const requestedMaximumSingleLoss = Number(process.env.DCA_MAX_SINGLE_LOSS_PCT)
  const maximumSingleLossPct = Number.isFinite(requestedMaximumSingleLoss)
    ? Math.max(0.1, Math.min(100, requestedMaximumSingleLoss))
    : 6
  const requestedMinimumTrades = Number(process.env.DCA_MIN_CLOSED_TRADES)
  const minimumClosedTrades = Number.isFinite(requestedMinimumTrades)
    ? Math.max(1, Math.floor(requestedMinimumTrades))
    : Math.max(40, historyDays * 3)
  const market = new Map<string, DcaBacktestCandle[]>()
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      market.set(
        `${symbol}:${timeframe}`,
        await fetchHistoricDays(symbol, timeframe, endTime, historyDays),
      )
    }
  }

  const candidates: DcaBacktestConfig[] = []
  for (const timeframeMinutes of TIMEFRAMES) {
    for (const entry of ENTRY_MODES) {
      for (const volumes of volumeLadders) {
        for (const distances of distanceLadders) {
          for (const takeProfitPct of takeProfits) {
            for (const stopBuffer of stopBuffers) {
              const profile = normalizeDcaProfile({
                maxSteps: 4,
                stepVolumeMultipliers: volumes,
                stepDistancesPct: distances,
                takeProfitMode: "average",
                breakevenProfitPct: 0.2,
                cooldownSeconds: 30,
                maxPositionVolumeRatio: Math.min(
                  5,
                  1 + volumes.reduce((sum, value) => sum + value, 0),
                ),
              })
              candidates.push({
                profile,
                timeframeMinutes,
                entry,
                takeProfitPct,
                stopLossPct: distances[3] + stopBuffer,
                maxHoldMinutes: 12 * 60,
                roundTripCostPct: 0.1,
                slippagePct: 0.02,
              })
            }
          }
        }
      }
    }
  }

  const ranked = candidates.map((config) => {
    const results = SYMBOLS.map((symbol) => ({
      symbol,
      result: runDcaBacktest(market.get(`${symbol}:${config.timeframeMinutes}`) || [], config),
    }))
    const closedTrades = results.reduce((sum, item) => sum + item.result.closedTrades, 0)
    const grossProfit = results.reduce((sum, item) => sum + item.result.grossProfitPct, 0)
    const grossLoss = results.reduce((sum, item) => sum + item.result.grossLossPct, 0)
    const netPnlPct = grossProfit - grossLoss
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0
    const maxEquityDrawdownPct = Math.max(...results.map((item) => item.result.maxEquityDrawdownPct))
    const averageDrawdownTimeMin = closedTrades > 0
      ? results.reduce((sum, item) => sum + item.result.averageDrawdownTimeMin * item.result.closedTrades, 0) / closedTrades
      : 0
    const worstSymbolPnlPct = Math.min(...results.map((item) => item.result.netPnlPct))
    const wins = results.reduce((sum, item) => sum + item.result.wins, 0)
    const trades = results.flatMap((item) => item.result.trades)
    const directionMetrics = Object.fromEntries((["long", "short"] as const).map((direction) => {
      const selected = trades.filter((trade) => trade.direction === direction)
      const directionGrossProfit = selected.reduce(
        (sum, trade) => sum + Math.max(0, trade.pnlPctOfInitialNotional),
        0,
      )
      const directionGrossLoss = selected.reduce(
        (sum, trade) => sum + Math.max(0, -trade.pnlPctOfInitialNotional),
        0,
      )
      return [direction, {
        positions: selected.length,
        wins: selected.filter((trade) => trade.pnlPctOfInitialNotional > 0).length,
        netPnlPct: directionGrossProfit - directionGrossLoss,
        profitFactor: directionGrossLoss > 0 ? directionGrossProfit / directionGrossLoss : null,
        profitFactorInfinite: directionGrossLoss === 0 && directionGrossProfit > 0,
      }]
    })) as Record<"long" | "short", {
      positions: number
      wins: number
      netPnlPct: number
      profitFactor: number | null
      profitFactorInfinite: boolean
    }>
    const worstTradePnlPct = Math.min(0, ...trades.map((trade) => trade.pnlPctOfInitialNotional))
    const worstAdversePnlPct = Math.min(0, ...trades.map((trade) => trade.maxAdversePnlPct))
    const totalLossEvents = trades.filter((trade) => trade.pnlPctOfInitialNotional <= -100).length
    const stopLosses = trades.filter((trade) => trade.exitReason === "sl").length
    const timeouts = trades.filter((trade) => trade.exitReason === "timeout").length
    const dcaPositions = trades.filter((trade) => trade.dcaSteps > 0).length
    const dcaStepCounts = Object.fromEntries([0, 1, 2, 3, 4].map((step) => [
      step,
      trades.filter((trade) => trade.dcaSteps === step).length,
    ]))

    const rangeStart = endTime - historyDays * DAY_MS
    const foldDuration = (historyDays * DAY_MS) / foldCount
    const folds = Array.from({ length: foldCount }, (_, foldIndex) => {
      const foldStart = rangeStart + foldIndex * foldDuration
      const foldEnd = foldIndex === foldCount - 1 ? endTime : foldStart + foldDuration
      const foldResults = SYMBOLS.map((symbol) => ({
        symbol,
        result: runDcaBacktest(
          (market.get(`${symbol}:${config.timeframeMinutes}`) || [])
            .filter((candle) => candle.time >= foldStart && candle.time <= foldEnd),
          config,
        ),
      }))
      const foldTrades = foldResults.flatMap((item) => item.result.trades)
      const foldGrossProfit = foldResults.reduce((sum, item) => sum + item.result.grossProfitPct, 0)
      const foldGrossLoss = foldResults.reduce((sum, item) => sum + item.result.grossLossPct, 0)
      return {
        index: foldIndex + 1,
        rangeStart: new Date(foldStart).toISOString(),
        rangeEnd: new Date(foldEnd).toISOString(),
        closedTrades: foldTrades.length,
        longPositions: foldTrades.filter((trade) => trade.direction === "long").length,
        shortPositions: foldTrades.filter((trade) => trade.direction === "short").length,
        netPnlPct: foldGrossProfit - foldGrossLoss,
        profitFactor: foldGrossLoss > 0 ? foldGrossProfit / foldGrossLoss : null,
        profitFactorInfinite: foldGrossLoss === 0 && foldGrossProfit > 0,
        maxEquityDrawdownPct: Math.max(...foldResults.map((item) => item.result.maxEquityDrawdownPct)),
        worstSymbolPnlPct: Math.min(...foldResults.map((item) => item.result.netPnlPct)),
      }
    })
    const qualified = closedTrades >= minimumClosedTrades
      && results.every((item) => item.result.closedTrades >= 4)
      && directionMetrics.long.positions >= 8
      && directionMetrics.short.positions >= 8
      && directionMetrics.long.netPnlPct > 0
      && directionMetrics.short.netPnlPct > 0
      && (directionMetrics.long.profitFactorInfinite || Number(directionMetrics.long.profitFactor || 0) >= 1.05)
      && (directionMetrics.short.profitFactorInfinite || Number(directionMetrics.short.profitFactor || 0) >= 1.05)
      && netPnlPct > 0
      && profitFactor >= 1.1
      && worstSymbolPnlPct >= 0
      && maxEquityDrawdownPct <= maximumEquityDrawdownPct
      && worstTradePnlPct >= -maximumSingleLossPct
      && totalLossEvents === 0
      && folds.every((fold) =>
        fold.closedTrades >= 8
        && fold.longPositions > 0
        && fold.shortPositions > 0
        && fold.netPnlPct > 0
        && (fold.profitFactorInfinite || Number(fold.profitFactor || 0) >= 1.05)
        && fold.maxEquityDrawdownPct <= maximumEquityDrawdownPct,
      )
    const score = closedTrades < minimumClosedTrades || results.some((item) => item.result.closedTrades < 3)
      ? Number.NEGATIVE_INFINITY
      : Math.log1p(Math.min(10, profitFactor)) * 3
        + netPnlPct / 20
        + worstSymbolPnlPct / 25
        + (closedTrades > 0 ? wins / closedTrades : 0)
        + Math.min(...folds.map((fold) => fold.netPnlPct)) / 30
        - maxEquityDrawdownPct / 8
        - Math.abs(Math.min(0, worstTradePnlPct)) / 20
        - averageDrawdownTimeMin / 720
    return {
      key: candidateKey(config),
      score,
      qualified,
      config: {
        timeframeMinutes: config.timeframeMinutes,
        entry: config.entry,
        takeProfitPct: config.takeProfitPct,
        stopLossPct: config.stopLossPct,
        profile: config.profile,
      },
      aggregate: {
        closedTrades,
        wins,
        winRatePct: closedTrades > 0 ? wins / closedTrades * 100 : 0,
        netPnlPct,
        grossProfitPct: grossProfit,
        grossLossPct: grossLoss,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
        profitFactorInfinite: profitFactor === Number.POSITIVE_INFINITY,
        maxEquityDrawdownPct,
        averageDrawdownTimeMin,
        worstSymbolPnlPct,
        worstTradePnlPct,
        worstAdversePnlPct,
        totalLossEvents,
        stopLosses,
        timeouts,
        dcaPositions,
        dcaStepCounts,
        directions: directionMetrics,
      },
      folds,
      symbols: results.map(({ symbol, result }) => ({
        symbol,
        closedTrades: result.closedTrades,
        winRatePct: result.winRatePct,
        netPnlPct: result.netPnlPct,
        profitFactor: result.profitFactor,
        profitFactorInfinite: result.profitFactorInfinite,
        maxEquityDrawdownPct: result.maxEquityDrawdownPct,
        averageDrawdownTimeMin: result.averageDrawdownTimeMin,
        maxPositionVolumeRatio: result.maxPositionVolumeRatio,
      })),
    }
  }).filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => Number(right.qualified) - Number(left.qualified) || right.score - left.score)

  const requestedTop = Number(process.env.DCA_BACKTEST_TOP)
  const topCount = Number.isFinite(requestedTop)
    ? Math.max(1, Math.min(100, Math.floor(requestedTop)))
    : 20

  const selected = ranked.find((candidate) => candidate.qualified) || null
  const baseline = ranked.find((candidate) =>
    candidate.config.timeframeMinutes === 15
    && candidate.config.entry === "relative"
    && candidate.config.takeProfitPct === 0.6
    && Math.abs(candidate.config.stopLossPct - 1.95) < 1e-9
    && JSON.stringify(candidate.config.profile.stepVolumeMultipliers) === JSON.stringify([1, 1, 1, 1])
    && JSON.stringify(candidate.config.profile.stepDistancesPct) === JSON.stringify([0.3, 0.6, 1, 1.6]),
  ) || null

  const report = {
    generatedAt: new Date().toISOString(),
    historyDays,
    rangeStart: new Date(endTime - historyDays * DAY_MS).toISOString(),
    rangeEnd: new Date(endTime).toISOString(),
    symbols: SYMBOLS.map((symbol) => symbol.replace("-", "")),
    timeframesMinutes: TIMEFRAMES,
    candidateCount: candidates.length,
    foldCount,
    qualification: {
      minimumClosedTrades,
      minimumPositionsPerDirection: 8,
      minimumTradesPerSymbol: 4,
      minimumProfitFactor: 1.1,
      minimumProfitFactorPerDirection: 1.05,
      minimumFoldProfitFactor: 1.05,
      maximumEquityDrawdownPct,
      maximumSingleLossPct,
      requireEverySymbolNonNegative: true,
      requireEveryFoldPositive: true,
      forbidTotalLossEvents: true,
    },
    qualifiedCandidateCount: ranked.filter((candidate) => candidate.qualified).length,
    costModel: { roundTripCostPct: 0.1, slippagePctPerFill: 0.02, intrabarOrdering: "stop_then_existing_tp_then_dca" },
    marketCandleCounts: Object.fromEntries(market),
    baseline,
    selected,
    baselineComparison: baseline && selected ? {
      closedTradesDelta: selected.aggregate.closedTrades - baseline.aggregate.closedTrades,
      netPnlPctDelta: selected.aggregate.netPnlPct - baseline.aggregate.netPnlPct,
      profitFactorDelta: Number(selected.aggregate.profitFactor || 0) - Number(baseline.aggregate.profitFactor || 0),
      maxEquityDrawdownPctReduction:
        baseline.aggregate.maxEquityDrawdownPct - selected.aggregate.maxEquityDrawdownPct,
      worstTradePnlPctImprovement:
        selected.aggregate.worstTradePnlPct - baseline.aggregate.worstTradePnlPct,
      totalLossEventsDelta:
        selected.aggregate.totalLossEvents - baseline.aggregate.totalLossEvents,
    } : null,
    top: ranked.slice(0, topCount),
  }
  const serialized = JSON.stringify(
    report,
    (_key, value) => Array.isArray(value) && value.length > 50 ? value.length : value,
    2,
  )
  const outputPath = String(process.env.DCA_BACKTEST_OUTPUT || "").trim()
  if (outputPath) {
    await writeFile(outputPath, `${serialized}\n`, "utf8")
    process.stdout.write(JSON.stringify({
      success: true,
      outputPath,
      historyDays,
      candidateCount: candidates.length,
      qualifiedCandidateCount: report.qualifiedCandidateCount,
      selected: report.selected,
    }, null, 2))
  } else {
    process.stdout.write(serialized)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
