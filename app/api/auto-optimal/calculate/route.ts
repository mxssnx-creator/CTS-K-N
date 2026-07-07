import { type NextRequest, NextResponse } from "next/server"
import { v4 as uuidv4 } from "uuid"
import DatabaseManager from "@/lib/database"
import { EntityTypes, ConfigSubTypes } from "@/lib/core/entity-types"
import { getSettings, setSettings, getMarketData } from "@/lib/redis-db"
import { aggregateCostNormalizedResults } from "@/lib/profit-factor"

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
}

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const config = await request.json()
    
    const dbManager = DatabaseManager.getInstance()

    const configId = uuidv4()
    
    await dbManager.insert(EntityTypes.CONFIG, ConfigSubTypes.AUTO_OPTIMAL, {
      id: configId,
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
    })

    console.log(`[v0] Auto-optimal config created: ${configId}`)

    const symbols = await getSymbolsForCalculation(config)
    const historicalData = await fetchHistoricalData(symbols, config.calculation_days || 30)
    
    const paramCombinations = generateParameterCombinations(config)
    console.log(`[v0] Testing ${paramCombinations.length} parameter combinations`)
    
    const results: SimulationResult[] = []
    
    for (const params of paramCombinations) {
      const trades = simulateTrades(historicalData, params)
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
    
    await saveResults(configId, topResults)
    
    console.log(`[v0] Auto-optimal calculation complete: ${topResults.length} results found`)

    return NextResponse.json({ success: true, configId, results: topResults })
  } catch (error) {
    console.error("[v0] Auto optimal calculation error:", error)
    return NextResponse.json({ error: "Failed to calculate optimal configurations" }, { status: 500 })
  }
}

async function getSymbolsForCalculation(config: any): Promise<string[]> {
  const symbols = await getSettings("active_symbols")
  if (symbols && Array.isArray(symbols)) {
    return symbols.slice(0, config.symbol_limit || 10)
  }
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
}

async function fetchHistoricalData(symbols: string[], days: number): Promise<Map<string, any[]>> {
  const dataBySymbol = new Map<string, any[]>()
  const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000
  
  for (const symbol of symbols) {
    const marketData = await getMarketData(symbol, "1m")
    if (marketData && marketData.candles && Array.isArray(marketData.candles)) {
      const filteredCandles = marketData.candles.filter((c: any) => 
        new Date(c.timestamp).getTime() >= cutoffTime
      )
      dataBySymbol.set(symbol, filteredCandles)
    } else {
      dataBySymbol.set(symbol, generateMockHistoricalData(days))
    }
  }
  
  return dataBySymbol
}

function generateMockHistoricalData(days: number): any[] {
  const data = []
  const now = Date.now()
  const basePrice = 50000
  
  for (let i = 0; i < days * 24 * 60; i++) {
    const timestamp = new Date(now - (days * 24 * 60 - i) * 60 * 1000)
    const noise = (Math.random() - 0.5) * 0.02
    const trend = Math.sin(i / 1000) * 0.1
    const price = basePrice * (1 + trend + noise)
    
    data.push({
      timestamp,
      open: price * (1 + (Math.random() - 0.5) * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: Math.random() * 1000000,
    })
  }
  
  return data
}

function generateParameterCombinations(config: any): any[] {
  const combinations = []
  
  const tpMin = config.takeprofit_min || 0.5
  const tpMax = config.takeprofit_max || 3.0
  const slMin = config.stoploss_min || 0.5
  const slMax = config.stoploss_max || 2.0
  
  const tpSteps = [tpMin, (tpMin + tpMax) / 2, tpMax]
  const slSteps = [slMin, (slMin + slMax) / 2, slMax]
  
  for (const tp of tpSteps) {
    for (const sl of slSteps) {
      combinations.push({
        takeprofit: tp,
        stoploss: sl,
        trailing_enabled: false,
      })
      
      if (config.trailing_enabled && !config.trailing_only) {
        combinations.push({
          takeprofit: tp,
          stoploss: sl,
          trailing_enabled: true,
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
      const trade = simulateTrade(symbol, candles, i, params)
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

function checkEntrySignal(candles: any[], index: number): boolean {
  if (index < 20) return false
  
  const recentCloses = candles.slice(index - 20, index).map((c: any) => c.close || c.price)
  const currentClose = candles[index].close || candles[index].price
  
  const sma = recentCloses.reduce((sum: number, p: number) => sum + p, 0) / recentCloses.length
  const priceChange = (currentClose - sma) / sma
  
  return Math.abs(priceChange) > 0.005
}

function simulateTrade(symbol: string, candles: any[], entryIndex: number, params: any): Trade | null {
  const entryPrice = candles[entryIndex].close || candles[entryIndex].price
  const entryTime = new Date(candles[entryIndex].timestamp)
  
  const side: "long" | "short" = Math.random() > 0.5 ? "long" : "short"
  
  const tpPercent = params.takeprofit / 100
  const slPercent = params.stoploss / 100
  
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
  
  const maxDuration = 120
  
  for (let i = entryIndex + 1; i < candles.length && i - entryIndex < maxDuration; i++) {
    const currentPrice = candles[i].close || candles[i].price
    
    if (side === "long") {
      if (currentPrice >= tpPrice) {
        exitPrice = tpPrice
        exitTime = new Date(candles[i].timestamp)
        break
      }
      if (currentPrice <= slPrice) {
        exitPrice = slPrice
        exitTime = new Date(candles[i].timestamp)
        break
      }
      
      if (params.trailing_enabled && currentPrice > highestPrice) {
        highestPrice = currentPrice
        const newSl = highestPrice * (1 - slPercent * 0.5)
        if (newSl > slPrice) {
          slPrice = newSl
        }
      }
    } else {
      if (currentPrice <= tpPrice) {
        exitPrice = tpPrice
        exitTime = new Date(candles[i].timestamp)
        break
      }
      if (currentPrice >= slPrice) {
        exitPrice = slPrice
        exitTime = new Date(candles[i].timestamp)
        break
      }
      
      if (params.trailing_enabled && currentPrice < lowestPrice) {
        lowestPrice = currentPrice
        const newSl = lowestPrice * (1 + slPercent * 0.5)
        if (newSl < slPrice) {
          slPrice = newSl
        }
      }
    }
    
    if (i === candles.length - 1 || i - entryIndex >= maxDuration - 1) {
      exitPrice = currentPrice
      exitTime = new Date(candles[i].timestamp)
    }
  }
  
  const profitLoss = side === "long"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100
  
  return {
    symbol,
    side,
    entry_price: entryPrice,
    exit_price: exitPrice,
    entry_time: entryTime,
    exit_time: exitTime,
    profit_loss: profitLoss,
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
    
    if (cumulativePnL > peak) {
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
      const drawdown = ((peak - cumulativePnL) / peak) * 100
      maxDrawdown = Math.max(maxDrawdown, drawdown)
    }
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

async function saveResults(configId: string, results: SimulationResult[]): Promise<void> {
  const existingResults = (await getSettings("auto_optimal_results")) || {}
  existingResults[configId] = {
    configId,
    results,
    calculatedAt: new Date().toISOString(),
  }
  await setSettings("auto_optimal_results", existingResults)
}
