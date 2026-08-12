#!/usr/bin/env tsx

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

async function fetchSevenDays(symbol: string, timeframe: 5 | 15 | 30, endTime: number): Promise<DcaBacktestCandle[]> {
  const startTime = endTime - 7 * DAY_MS
  const rows = new Map<number, DcaBacktestCandle>()
  let pageEnd = endTime
  for (let page = 0; page < 8; page++) {
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
    // limit is requested. Page until the exact seven-day boundary instead of
    // mistaking the venue cap for end-of-history.
    if (!Number.isFinite(earliest) || earliest <= startTime || payload.data.length === 0) break
    pageEnd = earliest - 1
  }
  return [...rows.values()].sort((left, right) => left.time - right.time)
}

const volumeLadders = [
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
  const market = new Map<string, DcaBacktestCandle[]>()
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      market.set(`${symbol}:${timeframe}`, await fetchSevenDays(symbol, timeframe, endTime))
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
                maxPositionVolumeRatio: 5,
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
    const score = closedTrades < 24 || results.some((item) => item.result.closedTrades < 3)
      ? Number.NEGATIVE_INFINITY
      : Math.log1p(Math.min(10, profitFactor)) * 3
        + netPnlPct / 20
        + worstSymbolPnlPct / 25
        + (closedTrades > 0 ? wins / closedTrades : 0)
        - maxEquityDrawdownPct / 12
        - averageDrawdownTimeMin / 720
    return {
      key: candidateKey(config),
      score,
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
      },
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
    .sort((left, right) => right.score - left.score)

  const requestedTop = Number(process.env.DCA_BACKTEST_TOP)
  const topCount = Number.isFinite(requestedTop)
    ? Math.max(1, Math.min(100, Math.floor(requestedTop)))
    : 20

  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    rangeStart: new Date(endTime - 7 * DAY_MS).toISOString(),
    rangeEnd: new Date(endTime).toISOString(),
    symbols: SYMBOLS.map((symbol) => symbol.replace("-", "")),
    timeframesMinutes: TIMEFRAMES,
    candidateCount: candidates.length,
    costModel: { roundTripCostPct: 0.1, slippagePctPerFill: 0.02, intrabarOrdering: "stop_then_existing_tp_then_dca" },
    marketCandleCounts: Object.fromEntries(market),
    top: ranked.slice(0, topCount),
  }, (_key, value) => Array.isArray(value) && value.length > 50 ? value.length : value, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
