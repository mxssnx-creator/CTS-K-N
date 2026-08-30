import { type NextRequest, NextResponse } from "next/server"
import { v4 as uuidv4 } from "uuid"
import DatabaseManager from "@/lib/database"
import { EntityTypes, ConfigSubTypes } from "@/lib/core/entity-types"
import { getConnection, getSettings, setSettings, getMarketData } from "@/lib/redis-db"
import { aggregateCostNormalizedResults } from "@/lib/profit-factor"
import {
  effectivePositionCostPercent,
  normalizePositionCostPercent,
  POSITION_COST_PERCENT_DEFAULT,
} from "@/lib/position-cost"
import { fetchDirectTradeMinuteHistory } from "@/lib/direct-trade-market-history"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { isForcedSimulation } from "@/lib/real-trade-gates"
import { getDefaultSymbolsForMarket, normalizeMarketSymbol, normalizeMarketType } from "@/lib/market-types"
import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"

interface SimulationResult {
  takeprofit: number
  stoploss: number
  trailing_enabled: boolean
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalProfit: number
  totalLoss: number
  netProfit: number
  profitFactor: number
  maxDrawdown: number
  maxDrawdownDuration: number
  avgWin: number
  avgLoss: number
  sharpeRatio: number
  sortinoRatio: number
}

interface Trade {
  symbol: string
  side: "long" | "short"
  entry_price: number
  exit_price: number
  entry_time: Date
  exit_time: Date
  profit_loss: number
  gross_profit_loss: number
  position_cost_percent: number
}

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const config = await request.json()
    const connectionId = String(config.connection_id || config.connectionId || "").trim()
    const connection = connectionId ? await getConnection(connectionId).catch(() => null) : null
    const positionCostPercent = normalizePositionCostPercent(
      config.positionCostPercent ?? config.position_cost_pct ?? POSITION_COST_PERCENT_DEFAULT,
    )
    
    const dbManager = DatabaseManager.getInstance()

    const configId = uuidv4()
    
    await dbManager.insert(EntityTypes.CONFIG, ConfigSubTypes.AUTO_OPTIMAL, {
      id: configId,
      connection_id: connectionId || undefined,
      name: `Auto Config ${new Date().toISOString()}`,
      symbol_mode: config.symbol_mode,
      exchange_order_by: config.exchange_order_by,
      symbol_limit: config.symbol_limit,
      indication_type: config.indication_type,
      indication_params: JSON.stringify(config.indication_params || {}),
      takeprofit_min: config.takeprofit_min,
      takeprofit_max: config.takeprofit_max,
      stoploss_min: config.stoploss_min,
      stoploss_max: config.stoploss_max,
      trailing_enabled: config.trailing_enabled,
      trailing_only: config.trailing_only,
      min_profit_factor: config.min_profit_factor,
      min_profit_factor_positions: config.min_profit_factor_positions,
      max_drawdown_time_hours: config.max_drawdown_time_hours,
      use_block: config.use_block,
      use_dca: config.use_dca,
      additional_strategies_only: config.additional_strategies_only,
      calculation_days: config.calculation_days,
      max_positions_per_direction: config.max_positions_per_direction,
      max_positions_per_symbol: config.max_positions_per_symbol,
      position_cost_pct: positionCostPercent,
    })

    console.log(`[v0] Auto-optimal config created: ${configId}`)

    const symbols = await getSymbolsForCalculation(config, connection)
    const historicalData = await fetchHistoricalData(
      symbols,
      config.calculation_days || 30,
      connectionId,
      connection,
    )
    const positionCostBySymbol = await resolvePositionCostBySymbol(
      symbols,
      positionCostPercent,
      connectionId,
      connection,
    )
    
    const paramCombinations = generateParameterCombinations({ ...config, positionCostPercent })
    console.log(`[v0] Testing ${paramCombinations.length} parameter combinations`)
    
    const results: SimulationResult[] = []
    
    for (const params of paramCombinations) {
      const trades = simulateTrades(historicalData, { ...params, positionCostBySymbol })
      const metrics = calculateMetrics(trades)
      
      if (meetsCriteria(metrics, config)) {
        results.push({
          takeprofit: params.takeprofit,
          stoploss: params.stoploss,
          trailing_enabled: params.trailing_enabled,
          ...metrics,
        })
      }
    }
    
    results.sort((a, b) => b.profitFactor - a.profitFactor)
    const topResults = results.slice(0, 20)
    
    await saveResults(configId, topResults, connectionId)
    
    console.log(`[v0] Auto-optimal calculation complete: ${topResults.length} results found`)

    return NextResponse.json({ success: true, configId, results: topResults })
  } catch (error) {
    console.error("[v0] Auto optimal calculation error:", error)
    return NextResponse.json({ error: "Failed to calculate optimal configurations" }, { status: 500 })
  }
}

async function getSymbolsForCalculation(config: any, connection: any): Promise<string[]> {
  const marketType = normalizeMarketType(
    config.market_type || config.asset_class || connection?.market_type || connection?.asset_class,
    config.exchange || connection?.exchange,
  )
  const sources = [
    config.symbols,
    config.active_symbols,
    connection?.active_symbols,
    connection?.activeSymbols,
  ]
  const symbols = Array.from(new Set(sources.flatMap((source) => {
    const values = Array.isArray(source)
      ? source
      : typeof source === "string"
        ? source.split(/[\s,|;]+/)
        : []
    return values.map((value: unknown) => marketType === "forex"
      ? normalizeForexSymbol(value)
      : normalizeMarketSymbol(value, "crypto"))
      .filter((symbol: string) => marketType === "forex" ? isForexSymbol(symbol) : /^[A-Z0-9]{2,30}$/.test(symbol))
  })))
  if (symbols.length > 0) return symbols.slice(0, Math.max(1, Number(config.symbol_limit) || 10))
  return marketType === "forex"
    ? getDefaultSymbolsForMarket("forex").slice(0, Math.max(1, Number(config.symbol_limit) || 10))
    : ["BTCUSDT", "ETHUSDT", "SOLUSDT"].slice(0, Math.max(1, Number(config.symbol_limit) || 3))
}

async function fetchHistoricalData(
  symbols: string[],
  days: number,
  connectionId: string,
  connection: any,
): Promise<Map<string, any[]>> {
  const dataBySymbol = new Map<string, any[]>()
  const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000
  const marketType = normalizeMarketType(
    connection?.market_type || connection?.asset_class,
    connection?.exchange,
  )
  const exchange = String(connection?.exchange || "").trim().toLowerCase().replace(/[^a-z]/g, "")

  for (const symbol of symbols) {
    const canonical = marketType === "forex" ? normalizeForexSymbol(symbol) : normalizeMarketSymbol(symbol, "crypto")
    const scopedData = connectionId ? await getMarketData(canonical, "1s", connectionId).catch(() => null) : null
    const cached = Array.isArray(scopedData?.candles) ? scopedData.candles : []
    let filteredCandles = cached.filter((c: any) => {
      const timestamp = new Date(c.timestamp ?? c.time).getTime()
      return Number.isFinite(timestamp) && timestamp >= cutoffTime
    })

    if (filteredCandles.length < 40 && !isForcedSimulation()) {
      const venue = exchange.includes("instaforex") || exchange.includes("instafx")
        ? "instaforex"
        : exchange.includes("bingx")
          ? "bingx"
          : exchange.includes("bybit")
            ? "bybit"
            : ""
      if (venue) {
        const history = await fetchDirectTradeMinuteHistory(venue, canonical, Math.max(1 / 60, days * 24)).catch(() => [])
        filteredCandles = history
          .map((c) => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
          .filter((c) => c.timestamp >= cutoffTime)
      } else if (connectionId) {
        const connector = await exchangeConnectorFactory.getOrCreateConnector(connectionId)
        const history = connector ? await connector.getOHLCV(canonical, "1m", Math.min(5_000, Math.max(100, days * 24 * 60))).catch(() => null) : null
        filteredCandles = (history || [])
          .map((c: any) => ({
            timestamp: Number(c.timestamp),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume || 0),
          }))
          .filter((c: any) => c.timestamp >= cutoffTime)
      }
    }
    if (filteredCandles.length === 0 && isForcedSimulation()) {
      filteredCandles = generateMockHistoricalData(days, canonical, marketType)
    }
    dataBySymbol.set(canonical, filteredCandles)
  }

  return dataBySymbol
}

function generateMockHistoricalData(days: number, symbol: string, marketType: "crypto" | "forex"): any[] {
  const data = []
  const now = Date.now()
  const forexBase: Record<string, number> = {
    EURUSD: 1.08,
    GBPUSD: 1.27,
    USDJPY: 150,
    USDCHF: 0.9,
    AUDUSD: 0.66,
    USDCAD: 1.36,
    NZDUSD: 0.61,
    EURGBP: 0.85,
  }
  const cryptoBase: Record<string, number> = { BTCUSDT: 65_000, ETHUSDT: 3_200, SOLUSDT: 145 }
  const basePrice = marketType === "forex" ? forexBase[symbol] || 1 : cryptoBase[symbol] || 100
  const amplitude = marketType === "forex" ? 0.0015 : 0.01

  for (let i = 0; i < days * 24 * 60; i++) {
    const timestamp = new Date(now - (days * 24 * 60 - i) * 60 * 1000)
    const trend = Math.sin(i / 97) * amplitude + Math.cos(i / 251) * amplitude * 0.6
    const price = basePrice * (1 + trend + i * amplitude / Math.max(1, days * 24 * 60) / 10)
    const barRange = basePrice * amplitude * 0.8
    data.push({
      timestamp,
      open: price,
      high: price + barRange,
      low: Math.max(0.000001, price - barRange),
      close: price,
      volume: marketType === "forex" ? 1_000 : 1_000_000,
    })
  }

  return data
}

async function resolvePositionCostBySymbol(
  symbols: string[],
  configuredPercent: number,
  connectionId: string,
  connection: any,
): Promise<Record<string, number>> {
  const result: Record<string, number> = Object.fromEntries(symbols.map((symbol) => [symbol, configuredPercent]))
  const marketType = normalizeMarketType(
    connection?.market_type || connection?.asset_class,
    connection?.exchange,
  )
  if (!connectionId || marketType !== "forex") return result
  const connector = await exchangeConnectorFactory.getOrCreateConnector(connectionId).catch(() => null)
  if (!connector) return result
  for (const symbol of symbols) {
    const canonical = normalizeForexSymbol(symbol)
    const ticker = await connector.getTicker(canonical).catch(() => null)
    result[symbol] = effectivePositionCostPercent(
      configuredPercent,
      ticker,
      canonical,
      {
        marketType: "forex",
        spreadBufferPips: Number(connection?.spread_buffer_pips),
        spreadMultiplier: Number(connection?.spread_multiplier),
      },
    )
  }
  return result
}

function generateParameterCombinations(config: any): any[] {
  const combinations = []
  
  const tpMin = config.takeprofit_min || 0.5
  const tpMax = config.takeprofit_max || 3.0
  const slMin = config.stoploss_min || 0.5
  const slMax = config.stoploss_max || 2.0
  const positionCostPercent = normalizePositionCostPercent(
    config.positionCostPercent ?? config.position_cost_pct ?? POSITION_COST_PERCENT_DEFAULT,
  )
  
  const tpSteps = [tpMin, (tpMin + tpMax) / 2, tpMax]
  const slSteps = [slMin, (slMin + slMax) / 2, slMax]
  
  for (const tp of tpSteps) {
    for (const sl of slSteps) {
      combinations.push({
        takeprofit: tp,
        stoploss: sl,
        trailing_enabled: false,
        positionCostPercent,
      })
      
      if (config.trailing_enabled && !config.trailing_only) {
        combinations.push({
          takeprofit: tp,
          stoploss: sl,
          trailing_enabled: true,
          positionCostPercent,
        })
      }
    }
  }
  
  if (config.trailing_only) {
    return combinations.filter(c => c.trailing_enabled)
  }
  
  return combinations
}

function simulateTrades(historicalData: Map<string, any[]>, params: any): Trade[] {
  const trades: Trade[] = []
  
  for (const [symbol, candles] of historicalData) {
    let i = 20
    while (i < candles.length - 1) {
      const entrySignal = checkEntrySignal(candles, i)
      
      if (entrySignal) {
        const trade = simulateTrade(symbol, candles, i, entrySignal, params)
        if (trade) {
          trades.push(trade)
          i += Math.min(120, candles.length - i - 1)
        }
      }
      i++
    }
  }
  
  return trades
}

function checkEntrySignal(candles: any[], index: number): "long" | "short" | null {
  if (index < 20) return null
  
  const recentCloses = candles.slice(index - 20, index).map((c: any) => c.close || c.price)
  const currentClose = candles[index].close || candles[index].price
  
  const sma = recentCloses.reduce((sum: number, p: number) => sum + p, 0) / recentCloses.length
  const priceChange = (currentClose - sma) / sma
  
  if (!(sma > 0) || !Number.isFinite(priceChange)) return null
  if (priceChange > 0.005) return "long"
  if (priceChange < -0.005) return "short"
  return null
}

function simulateTrade(
  symbol: string,
  candles: any[],
  signalIndex: number,
  side: "long" | "short",
  params: any,
): Trade | null {
  // A signal observed on a closed candle enters at the next candle's open.
  // This prevents the optimizer from using the signal candle's close as both
  // evidence and an executable fill.
  const entryIndex = signalIndex + 1
  if (entryIndex >= candles.length) return null
  const entryCandle = candles[entryIndex]
  const entryPrice = Number(entryCandle.open || entryCandle.close || entryCandle.price || 0)
  if (!(entryPrice > 0)) return null
  const entryTime = new Date(entryCandle.timestamp)
  
  const tpPercent = Number(params.takeprofit) / 100
  const slPercent = Number(params.stoploss) / 100
  if (!(tpPercent > 0) || !(slPercent > 0)) return null
  
  const tpPrice = side === "long" 
    ? entryPrice * (1 + tpPercent) 
    : entryPrice * (1 - tpPercent)
  let slPrice = side === "long" 
    ? entryPrice * (1 - slPercent) 
    : entryPrice * (1 + slPercent)
  
  let exitPrice = entryPrice
  let exitTime = entryTime
  let highestPrice = entryPrice
  let lowestPrice = entryPrice
  let exitReason = "timeout"
  
  const maxDuration = 120
  
  for (let i = entryIndex; i < candles.length && i - entryIndex < maxDuration; i++) {
    const candle = candles[i]
    const currentPrice = Number(candle.close || candle.price || 0)
    const high = Number(candle.high || currentPrice)
    const low = Number(candle.low || currentPrice)
    if (!(currentPrice > 0) || !(high >= low) || !(low > 0)) continue
    
    if (side === "long") {
      // OHLC does not reveal intra-bar ordering. Use stop-first to avoid
      // turning a candle that touched both controls into a false winner.
      if (low <= slPrice) {
        exitPrice = slPrice
        exitTime = new Date(candle.timestamp)
        exitReason = "stoploss"
        break
      }
      if (high >= tpPrice) {
        exitPrice = tpPrice
        exitTime = new Date(candle.timestamp)
        exitReason = "takeprofit"
        break
      }
      
      if (params.trailing_enabled && high > highestPrice) {
        highestPrice = high
        const newSl = highestPrice * (1 - slPercent * 0.5)
        if (newSl > slPrice) {
          slPrice = newSl
        }
      }
    } else {
      if (high >= slPrice) {
        exitPrice = slPrice
        exitTime = new Date(candle.timestamp)
        exitReason = "stoploss"
        break
      }
      if (low <= tpPrice) {
        exitPrice = tpPrice
        exitTime = new Date(candle.timestamp)
        exitReason = "takeprofit"
        break
      }
      
      if (params.trailing_enabled && low < lowestPrice) {
        lowestPrice = low
        const newSl = lowestPrice * (1 + slPercent * 0.5)
        if (newSl < slPrice) {
          slPrice = newSl
        }
      }
    }
    
    if (i === candles.length - 1 || i - entryIndex >= maxDuration - 1) {
      exitPrice = currentPrice
      exitTime = new Date(candle.timestamp)
    }
  }
  
  const grossProfitLoss = side === "long"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100
  const positionCostPercent = normalizePositionCostPercent(
    params.positionCostBySymbol?.[symbol] ?? params.positionCostPercent ?? POSITION_COST_PERCENT_DEFAULT,
  )
  // Auto-Optimal ranks only closed simulated trades. Deduct the configured
  // position cost once, so zero-gross moves cannot look profitable in PF.
  const profitLoss = grossProfitLoss - positionCostPercent
  
  return {
    symbol,
    side,
    entry_price: entryPrice,
    exit_price: exitPrice,
    entry_time: entryTime,
    exit_time: exitTime,
    profit_loss: profitLoss,
    gross_profit_loss: grossProfitLoss,
    position_cost_percent: positionCostPercent,
  }
}

function calculateMetrics(trades: Trade[]): any {
  const totalTrades = trades.length
  const winningTrades = trades.filter(t => t.profit_loss > 0).length
  const losingTrades = trades.filter(t => t.profit_loss <= 0).length
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0
  
  const totalProfit = trades.filter(t => t.profit_loss > 0).reduce((sum, t) => sum + t.profit_loss, 0)
  const totalLoss = Math.abs(trades.filter(t => t.profit_loss <= 0).reduce((sum, t) => sum + t.profit_loss, 0))
  const netProfit = totalProfit - totalLoss
  const profitFactor = aggregateCostNormalizedResults(trades.map((trade) => trade.profit_loss)).profitFactor
  
  const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0
  const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0
  
  const drawdownMetrics = calculateDrawdown(trades)
  
  const returns = trades.map(t => t.profit_loss)
  const avgReturn = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0
  const stdDev = returns.length > 0 
    ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length) 
    : 0
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0
  
  const negativeReturns = returns.filter(r => r < 0)
  const downStdDev = negativeReturns.length > 0
    ? Math.sqrt(negativeReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / negativeReturns.length)
    : 0
  const sortinoRatio = downStdDev > 0 ? avgReturn / downStdDev : 0
  
  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalProfit,
    totalLoss,
    netProfit,
    profitFactor,
    maxDrawdown: drawdownMetrics.maxDrawdown,
    maxDrawdownDuration: drawdownMetrics.maxDrawdownDuration,
    avgWin,
    avgLoss,
    sharpeRatio,
    sortinoRatio,
  }
}

function calculateDrawdown(trades: Trade[]): { maxDrawdown: number; maxDrawdownDuration: number } {
  const sortedTrades = [...trades].sort((a, b) => a.exit_time.getTime() - b.exit_time.getTime())
  
  let cumulativePnL = 0
  let peak = 0
  let maxDrawdown = 0
  let currentDrawdownStart: Date | null = null
  let maxDrawdownDuration = 0
  
  for (const trade of sortedTrades) {
    cumulativePnL += trade.profit_loss
    
    if (cumulativePnL >= peak) {
      if (currentDrawdownStart) {
        const duration = (trade.exit_time.getTime() - currentDrawdownStart.getTime()) / (1000 * 60 * 60)
        maxDrawdownDuration = Math.max(maxDrawdownDuration, duration)
        currentDrawdownStart = null
      }
      peak = cumulativePnL
    } else if (cumulativePnL < peak) {
      if (!currentDrawdownStart) {
        currentDrawdownStart = trade.exit_time
      }
      // cumulativePnL is already expressed in percentage points, so dividing
      // by a zero/negative peak creates NaN or an inverted drawdown. Keep the
      // metric finite and aligned with the PnL coordinate.
      const drawdown = Math.max(0, peak - cumulativePnL)
      maxDrawdown = Math.max(maxDrawdown, drawdown)
    }
  }

  if (currentDrawdownStart && sortedTrades.length > 0) {
    const lastExit = sortedTrades[sortedTrades.length - 1].exit_time.getTime()
    const duration = (lastExit - currentDrawdownStart.getTime()) / (1000 * 60 * 60)
    maxDrawdownDuration = Math.max(maxDrawdownDuration, Math.max(0, duration))
  }
  
  return { maxDrawdown, maxDrawdownDuration }
}

function meetsCriteria(metrics: any, config: any): boolean {
  if (config.min_profit_factor && metrics.profitFactor < config.min_profit_factor) {
    return false
  }
  if (config.min_profit_factor_positions && metrics.totalTrades < config.min_profit_factor_positions) {
    return false
  }
  if (config.max_drawdown_time_hours && metrics.maxDrawdownDuration > config.max_drawdown_time_hours) {
    return false
  }
  return metrics.totalTrades >= 5
}

async function saveResults(configId: string, results: SimulationResult[], connectionId = ""): Promise<void> {
  const resultKey = connectionId ? `auto_optimal_results:${connectionId}` : "auto_optimal_results:unscoped"
  const existingResults = (await getSettings(resultKey)) || {}
  existingResults[configId] = {
    configId,
    results,
    calculatedAt: new Date().toISOString(),
  }
  await setSettings(resultKey, existingResults)
}
