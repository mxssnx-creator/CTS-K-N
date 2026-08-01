import { type NextRequest, NextResponse } from "next/server"
import { getMarketData } from "@/lib/redis-db"
import { fetchTopSymbols, type SortKey } from "@/lib/top-symbols"
import { fetchBingXPublic } from "@/lib/bingx-public-api"
import { aggregateCostNormalizedResults } from "@/lib/profit-factor"
import {
  STOP_LOSS_RATIO_MIN,
  STOP_LOSS_RATIO_MAX,
  STOP_LOSS_RATIO_STEP,
} from "@/lib/stoploss-ratio-range"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// ─── Types ────────────────────────────────────────────────────────────────────

interface DirectTradeConfig {
  symbol: string
  direction: "long" | "short"
  timeframe: "1m" | "5m" | "10m"
  takeprofit: number
  stoploss: number
  trailing: boolean
  trailStart?: number
  trailStop?: number
  blockCount: number
  volumeRatio: number
  profitFactor: number
  winRate: number
  totalTrades: number
  avgDrawdownTimeMin: number
  maxDrawdownTimeMin: number
  score: number
}

interface CalculationRequest {
  symbolCount?: number
  symbolOrder?: SortKey
  minVolFactor?: number
  maxSlRatio?: number
  slRatioStep?: number
  timeframes?: ("1m" | "5m" | "10m")[]
  blockRange?: [number, number]
  recalculate?: boolean
}

// ─── Kline Fetcher (8h data per symbol) ───────────────────────────────────────

async function fetchKlines8h(symbol: string, interval: "1m" | "5m" | "10m"): Promise<any[]> {
  const bingxSym = symbol.replace(/USDT$/, "-USDT")
  const limitMap = { "1m": 480, "5m": 96, "10m": 48 }
  const limit = limitMap[interval] || 480
  const intervalMap = { "1m": "1m", "5m": "5m", "10m": "15m" }
  const bingxInterval = intervalMap[interval] || "1m"

  try {
    const url = `/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(bingxSym)}&interval=${bingxInterval}&limit=${limit}`
    const res = await fetchBingXPublic(url, {}, { timeoutMs: 5000 })
    if (!res.ok) return []
    const data = await res.json()
    const klines = Array.isArray(data?.data) ? data.data : []
    return klines.map((c: any) => ({
      time: Number(c.time || c.timestamp || c.t || 0),
      open: Number(c.open || c.o || 0),
      high: Number(c.high || c.h || 0),
      low: Number(c.low || c.l || 0),
      close: Number(c.close || c.c || 0),
      volume: Number(c.volume || c.v || 0),
    })).filter((c: any) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
  } catch {
    return []
  }
}

// ─── Entry Signal Detection ───────────────────────────────────────────────────

function detectEntrySignal(candles: any[], index: number, direction: "long" | "short"): boolean {
  if (index < 14) return false
  const recent = candles.slice(index - 14, index)
  const closes = recent.map((c) => c.close)
  const highs = recent.map((c) => c.high)
  const lows = recent.map((c) => c.low)

  // RSI-based entry
  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    gains.push(diff > 0 ? diff : 0)
    losses.push(diff < 0 ? -diff : 0)
  }
  const avgGain = gains.reduce((s, v) => s + v, 0) / gains.length
  const avgLoss = losses.reduce((s, v) => s + v, 0) / losses.length
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100
  const rsi = 100 - 100 / (1 + rs)

  // EMA crossover
  const ema5 = closes.slice(-5).reduce((s, v) => s + v, 0) / 5
  const ema14 = closes.reduce((s, v) => s + v, 0) / closes.length

  // Momentum
  const momentum = (candles[index].close - closes[0]) / closes[0]

  if (direction === "long") {
    return (rsi < 35 && ema5 > ema14) || (momentum > 0.002 && rsi < 50)
  } else {
    return (rsi > 65 && ema5 < ema14) || (momentum < -0.002 && rsi > 50)
  }
}

// ─── Trade Simulation ─────────────────────────────────────────────────────────

interface SimTrade {
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  direction: "long" | "short"
  pnlPercent: number
  drawdownTimeMin: number
  exitReason: "tp" | "sl" | "trailing" | "timeout"
}

function simulateTrades(
  candles: any[],
  direction: "long" | "short",
  tpPercent: number,
  slPercent: number,
  trailing: boolean,
  trailStart: number,
  trailStop: number,
  timeframeMinutes: number,
): SimTrade[] {
  const trades: SimTrade[] = []
  const maxHoldCandles = Math.ceil(120 / timeframeMinutes)
  let i = 14

  while (i < candles.length - 1) {
    if (!detectEntrySignal(candles, i, direction)) {
      i++
      continue
    }

    const entryPrice = candles[i].close
    const entryTime = candles[i].time
    let exitPrice = entryPrice
    let exitTime = entryTime
    let exitReason: SimTrade["exitReason"] = "timeout"
    let highWatermark = entryPrice
    let lowWatermark = entryPrice
    let maxDrawdownMs = 0
    let drawdownStart = entryTime
    let inDrawdown = false

    const tpPrice = direction === "long"
      ? entryPrice * (1 + tpPercent / 100)
      : entryPrice * (1 - tpPercent / 100)
    let slPrice = direction === "long"
      ? entryPrice * (1 - slPercent / 100)
      : entryPrice * (1 + slPercent / 100)

    for (let j = i + 1; j < candles.length && j - i < maxHoldCandles; j++) {
      const c = candles[j]
      const price = c.close
      const high = c.high
      const low = c.low

      if (direction === "long") {
        // Check SL hit
        if (low <= slPrice) {
          exitPrice = slPrice
          exitTime = c.time
          exitReason = trailing && highWatermark > entryPrice * (1 + trailStart / 100) ? "trailing" : "sl"
          break
        }
        // Check TP hit
        if (high >= tpPrice) {
          exitPrice = tpPrice
          exitTime = c.time
          exitReason = "tp"
          break
        }
        // Trailing stop
        if (trailing && high > highWatermark) {
          highWatermark = high
          if (highWatermark > entryPrice * (1 + trailStart / 100)) {
            const newSl = highWatermark * (1 - trailStop / 100)
            if (newSl > slPrice) slPrice = newSl
          }
        }
        // Drawdown tracking
        if (price < entryPrice) {
          if (!inDrawdown) { drawdownStart = c.time; inDrawdown = true }
          maxDrawdownMs = Math.max(maxDrawdownMs, c.time - drawdownStart)
        } else {
          inDrawdown = false
        }
      } else {
        // Short direction
        if (high >= slPrice) {
          exitPrice = slPrice
          exitTime = c.time
          exitReason = trailing && lowWatermark < entryPrice * (1 - trailStart / 100) ? "trailing" : "sl"
          break
        }
        if (low <= tpPrice) {
          exitPrice = tpPrice
          exitTime = c.time
          exitReason = "tp"
          break
        }
        if (trailing && low < lowWatermark) {
          lowWatermark = low
          if (lowWatermark < entryPrice * (1 - trailStart / 100)) {
            const newSl = lowWatermark * (1 + trailStop / 100)
            if (newSl < slPrice) slPrice = newSl
          }
        }
        if (price > entryPrice) {
          if (!inDrawdown) { drawdownStart = c.time; inDrawdown = true }
          maxDrawdownMs = Math.max(maxDrawdownMs, c.time - drawdownStart)
        } else {
          inDrawdown = false
        }
      }

      if (j === Math.min(candles.length - 1, i + maxHoldCandles - 1)) {
        exitPrice = price
        exitTime = c.time
        exitReason = "timeout"
      }
    }

    const pnlPercent = direction === "long"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100

    trades.push({
      entryPrice,
      exitPrice,
      entryTime,
      exitTime,
      direction,
      pnlPercent,
      drawdownTimeMin: maxDrawdownMs / 60000,
      exitReason,
    })

    // Skip forward after trade
    const skipCandles = Math.max(3, Math.ceil((exitTime - entryTime) / (timeframeMinutes * 60000)))
    i += skipCandles
  }

  return trades
}

// ─── Config Scoring ───────────────────────────────────────────────────────────

function scoreConfig(trades: SimTrade[], tpPercent: number, slPercent: number): number {
  if (trades.length < 3) return 0
  const wins = trades.filter((t) => t.pnlPercent > 0)
  const losses = trades.filter((t) => t.pnlPercent <= 0)
  const totalProfit = wins.reduce((s, t) => s + t.pnlPercent, 0)
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0))
  const pf = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 10 : 0
  const winRate = wins.length / trades.length
  const avgDdt = trades.reduce((s, t) => s + t.drawdownTimeMin, 0) / trades.length
  const maxDdt = Math.max(...trades.map((t) => t.drawdownTimeMin))

  // Score: PF weighted + win rate bonus + low DDT bonus + SL<TP bonus
  const slTpRatio = slPercent < tpPercent ? 1.2 : slPercent === tpPercent ? 1.0 : 0.8
  const ddtPenalty = maxDdt > 10 ? 0.7 : maxDdt > 5 ? 0.9 : 1.0
  const tradeCountBonus = Math.min(1.5, trades.length / 10)

  return pf * winRate * slTpRatio * ddtPenalty * tradeCountBonus
}

// ─── Main Calculation ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body: CalculationRequest = await request.json().catch(() => ({}))
    const symbolCount = Math.min(20, Math.max(1, body.symbolCount || 8))
    const symbolOrder: SortKey = body.symbolOrder || "volatility_1h"
    const minVolFactor = Math.max(0.1, body.minVolFactor || 1)
    const maxSlRatio = Math.min(STOP_LOSS_RATIO_MAX, Math.max(STOP_LOSS_RATIO_MIN, body.maxSlRatio || 1))
    const slStep = body.slRatioStep || STOP_LOSS_RATIO_STEP
    const timeframes: ("1m" | "5m" | "10m")[] = body.timeframes || ["1m", "5m", "10m"]
    const blockRange: [number, number] = body.blockRange || [1, 12]

    // 1. Get most volatile symbols
    const topResult = await fetchTopSymbols("bingx", symbolCount, symbolOrder)
    const symbols = topResult.symbols.slice(0, symbolCount).map((t) => t.symbol)

    if (symbols.length === 0) {
      return NextResponse.json({ error: "No symbols available" }, { status: 400 })
    }

    // 2. Calculate best configs for each symbol/direction/timeframe
    const allConfigs: DirectTradeConfig[] = []
    const tpRange = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 2.5, 3.0]
    const slRange: number[] = []
    for (let sl = STOP_LOSS_RATIO_MIN; sl <= maxSlRatio + 0.001; sl += slStep) {
      slRange.push(Number(sl.toFixed(2)))
    }
    const trailOptions = [
      { trailing: false, trailStart: 0, trailStop: 0 },
      { trailing: true, trailStart: 0.3, trailStop: 0.2 },
      { trailing: true, trailStart: 0.5, trailStop: 0.3 },
      { trailing: true, trailStart: 1.0, trailStop: 0.5 },
    ]

    const timeframeMinutes = { "1m": 1, "5m": 5, "10m": 10 }

    // Process symbols in parallel batches of 4
    const batchSize = 4
    for (let batchStart = 0; batchStart < symbols.length; batchStart += batchSize) {
      const batch = symbols.slice(batchStart, batchStart + batchSize)
      await Promise.all(batch.map(async (symbol) => {
        for (const tf of timeframes) {
          const candles = await fetchKlines8h(symbol, tf)
          if (candles.length < 30) continue

          for (const direction of ["long", "short"] as const) {
            let bestScore = 0
            let bestConfig: DirectTradeConfig | null = null

            for (const tp of tpRange) {
              for (const sl of slRange) {
                // SL should be <= TP for favorable risk/reward
                const slPercent = tp * sl
                if (slPercent > tp * 1.2) continue

                for (const trail of trailOptions) {
                  const trades = simulateTrades(
                    candles, direction, tp, slPercent,
                    trail.trailing, trail.trailStart, trail.trailStop,
                    timeframeMinutes[tf],
                  )
                  if (trades.length < 3) continue

                  const score = scoreConfig(trades, tp, slPercent)
                  if (score <= bestScore) continue

                  const wins = trades.filter((t) => t.pnlPercent > 0)
                  const losses = trades.filter((t) => t.pnlPercent <= 0)
                  const totalProfit = wins.reduce((s, t) => s + t.pnlPercent, 0)
                  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0))
                  const pf = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 10 : 0
                  const winRate = wins.length / trades.length
                  const avgDdt = trades.reduce((s, t) => s + t.drawdownTimeMin, 0) / trades.length
                  const maxDdt = Math.max(...trades.map((t) => t.drawdownTimeMin))

                  if (pf < 1.1 || winRate < 0.4 || maxDdt > 15) continue

                  bestScore = score
                  bestConfig = {
                    symbol,
                    direction,
                    timeframe: tf,
                    takeprofit: tp,
                    stoploss: slPercent,
                    trailing: trail.trailing,
                    trailStart: trail.trailStart,
                    trailStop: trail.trailStop,
                    blockCount: Math.min(blockRange[1], Math.max(blockRange[0], Math.round(pf))),
                    volumeRatio: minVolFactor,
                    profitFactor: Number(pf.toFixed(3)),
                    winRate: Number((winRate * 100).toFixed(1)),
                    totalTrades: trades.length,
                    avgDrawdownTimeMin: Number(avgDdt.toFixed(1)),
                    maxDrawdownTimeMin: Number(maxDdt.toFixed(1)),
                    score: Number(score.toFixed(4)),
                  }
                }
              }
            }

            if (bestConfig) allConfigs.push(bestConfig)
          }
        }
      }))
    }

    // Sort by score descending
    allConfigs.sort((a, b) => b.score - a.score)

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      symbols,
      symbolCount: symbols.length,
      configs: allConfigs,
      summary: {
        totalConfigs: allConfigs.length,
        avgProfitFactor: allConfigs.length > 0
          ? Number((allConfigs.reduce((s, c) => s + c.profitFactor, 0) / allConfigs.length).toFixed(3))
          : 0,
        avgWinRate: allConfigs.length > 0
          ? Number((allConfigs.reduce((s, c) => s + c.winRate, 0) / allConfigs.length).toFixed(1))
          : 0,
        avgMaxDDT: allConfigs.length > 0
          ? Number((allConfigs.reduce((s, c) => s + c.maxDrawdownTimeMin, 0) / allConfigs.length).toFixed(1))
          : 0,
        timeframes,
        blockRange,
        maxSlRatio,
      },
    })
  } catch (error) {
    console.error("[Direct-Trade] Calculate error:", error)
    return NextResponse.json(
      { error: "Calculation failed", details: String(error) },
      { status: 500 },
    )
  }
}
