/**
 * Metrics Aggregator
 * Aggregates all engine metrics for UI display with symbol-specific and overall views
 */

import { getProgressManager, EngineProgressState } from "./engine-progress-manager"
import { IndicationEvaluator, IndicationTypeStats } from "./indication-evaluator"
import { StrategyEvaluator, StrategyStageStats } from "./strategy-evaluator"
import { EngineLogger, EngineLogEntry } from "./engine-logger"

export interface SymbolMetrics {
  symbol: string
  // Prehistoric
  prehistoricCandles: number
  prehistoricDuration: number
  prehistoricErrors: number
  prehistoricLoaded: boolean
  // WebSocket
  wsConnected: boolean
  wsMessagesReceived: number
  wsErrors: number
  wsLastUpdate: string | null
  // Processing cycles
  indicationCycles: number
  strategyCycles: number
  realtimeCycles: number
  lastIndicationTime: string | null
  lastStrategyTime: string | null
  lastRealtimeTime: string | null
  // Errors
  totalErrors: number
  lastError: string | null
  // Indication metrics by type
  indicationTypes: Record<string, {
    evaluations: number
    passed: number
    passRate: number
    avgConfidence: number
  }>
  // Strategy metrics by stage
  strategyStages: {
    base: { setsCount: number; evaluated: number; passed: number; passRate: number; avgProfitFactor: number; avgDrawdownTime: number }
    main: { setsCount: number; evaluated: number; passed: number; passRate: number; avgProfitFactor: number; avgDrawdownTime: number }
    real: { setsCount: number; evaluated: number; passed: number; passRate: number; avgProfitFactor: number; avgDrawdownTime: number }
  }
}

export interface OverallMetrics {
  connectionId: string
  status: string
  startedAt: string | null
  // Symbol overview
  symbolCount: number
  symbols: string[]
  // Prehistoric overview
  prehistoricTotalSymbols: number
  prehistoricLoadedSymbols: number
  prehistoricTotalCandles: number
  prehistoricCompleted: boolean
  prehistoricErrors: number
  prehistoricDuration: number
  // WebSocket overview
  wsSymbolsConnected: number
  wsTotalSymbols: number
  wsMessagesTotal: number
  wsErrorsTotal: number
  wsLastUpdate: string | null
  // Processing overview
  totalIndicationCycles: number
  totalStrategyCycles: number
  totalRealtimeCycles: number
  totalCycles: number
  lastCycleTime: string | null
  // Indication summary
  indicationSummary: {
    totalEvaluations: number
    typesTracked: number
    overallPassRate: number
    avgConfidence: number
    avgStrength: number
    typeBreakdown: Array<{
      type: string
      evaluations: number
      passed: number
      passRate: number
      avgConfidence: number
      avgStrength: number
    }>
  }
  // Strategy summary
  strategySummary: {
    totalEvaluated: number
    overallPassRate: number
    avgProfitFactor: number
    avgDrawdownTime: number
    stages: Array<{
      stage: string
      setsCount: number
      evaluated: number
      passed: number
      failed: number
      passRate: number
      avgProfitFactor: number
      avgDrawdownTime: number
    }>
  }
  // Error summary
  errorCount: number
  recentErrors: Array<{
    timestamp: string
    symbol: string | null
    type: string
    message: string
  }>
  // Log summary
  logCount: number
  recentLogs: Array<{
    timestamp: string
    level: string
    category: string
    symbol: string | null
    message: string
  }>
}

export class MetricsAggregator {
  private connectionId: string
  private indicationEvaluator: IndicationEvaluator
  private strategyEvaluator: StrategyEvaluator
  private logger: EngineLogger

  constructor(connectionId: string, indicationEvaluator: IndicationEvaluator, strategyEvaluator: StrategyEvaluator, logger: EngineLogger) {
    this.connectionId = connectionId
    this.indicationEvaluator = indicationEvaluator
    this.strategyEvaluator = strategyEvaluator
    this.logger = logger
  }

  /**
   * Get metrics for a specific symbol
   */
  async getSymbolMetrics(symbol: string): Promise<SymbolMetrics | null> {
    const progressManager = getProgressManager(this.connectionId)
    const state = progressManager.getState()
    
    const symbolProgress = state.symbols[symbol]
    if (!symbolProgress) return null

    const indicationStats = this.indicationEvaluator.getAllTypeStats()
    const strategyStats = this.strategyEvaluator.getAllStageStats()

    // Calculate symbol-specific indication metrics
    const indicationTypes: Record<string, any> = {}
    for (const [type, stats] of indicationStats) {
      if (stats.symbols[symbol]) {
        indicationTypes[type] = {
          evaluations: stats.symbols[symbol],
          passed: Math.round(stats.passRate * stats.symbols[symbol] / 100),
          passRate: stats.passRate,
          avgConfidence: stats.avgConfidence,
        }
      }
    }

    // Calculate symbol-specific strategy metrics
    const strategyStages = {
      base: { setsCount: 0, evaluated: 0, passed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0 },
      main: { setsCount: 0, evaluated: 0, passed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0 },
      real: { setsCount: 0, evaluated: 0, passed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0 },
    }
    
    for (const [stage, stats] of strategyStats) {
      if (stats.symbols[symbol]) {
        strategyStages[stage as keyof typeof strategyStages] = {
          setsCount: stats.setsCount,
          evaluated: stats.symbols[symbol],
          passed: Math.round(stats.passRate * stats.symbols[symbol] / 100),
          passRate: stats.passRate,
          avgProfitFactor: stats.avgProfitFactor,
          avgDrawdownTime: stats.avgDrawdownTime,
        }
      }
    }

    return {
      symbol,
      prehistoricCandles: symbolProgress.prehistoricCandles,
      prehistoricDuration: symbolProgress.prehistoricDuration,
      prehistoricErrors: symbolProgress.prehistoricErrors,
      prehistoricLoaded: symbolProgress.prehistoricLoaded,
      wsConnected: symbolProgress.wsConnected,
      wsMessagesReceived: symbolProgress.wsMessagesReceived,
      wsErrors: symbolProgress.wsErrors,
      wsLastUpdate: symbolProgress.wsLastUpdate,
      indicationCycles: symbolProgress.indicationCycles,
      strategyCycles: symbolProgress.strategyCycles,
      realtimeCycles: symbolProgress.realtimeCycles,
      lastIndicationTime: symbolProgress.lastIndicationTime,
      lastStrategyTime: symbolProgress.lastStrategyTime,
      lastRealtimeTime: symbolProgress.lastRealtimeTime,
      totalErrors: symbolProgress.totalErrors,
      lastError: symbolProgress.lastError,
      indicationTypes,
      strategyStages,
    }
  }

  /**
   * Get overall metrics for all symbols
   */
  async getOverallMetrics(): Promise<OverallMetrics> {
    const progressManager = getProgressManager(this.connectionId)
    const state = progressManager.getState()
    
    const indicationSummary = this.indicationEvaluator.getSummary()
    const strategySummary = this.strategyEvaluator.getSummary()
    const logSummary = this.logger.getSummary()

    return {
      connectionId: this.connectionId,
      status: state.status,
      startedAt: state.startedAt,
      symbolCount: Object.keys(state.symbols).length,
      symbols: Object.keys(state.symbols),
      prehistoricTotalSymbols: state.prehistoricTotalSymbols,
      prehistoricLoadedSymbols: state.prehistoricLoadedSymbols,
      prehistoricTotalCandles: state.prehistoricTotalCandles,
      prehistoricCompleted: state.prehistoricCompleted,
      prehistoricErrors: state.prehistoricErrors,
      prehistoricDuration: state.prehistoricDuration,
      wsSymbolsConnected: state.wsSymbolsConnected,
      wsTotalSymbols: state.wsTotalSymbols,
      wsMessagesTotal: state.wsMessagesTotal,
      wsErrorsTotal: state.wsErrorsTotal,
      wsLastUpdate: state.wsLastUpdate,
      totalIndicationCycles: state.totalIndicationCycles,
      totalStrategyCycles: state.totalStrategyCycles,
      totalRealtimeCycles: state.totalRealtimeCycles,
      totalCycles: state.totalIndicationCycles + state.totalStrategyCycles + state.totalRealtimeCycles,
      lastCycleTime: state.lastCycleTime,
      indicationSummary,
      strategySummary,
      errorCount: state.errors.length,
      recentErrors: state.errors.slice(-10),
      logCount: state.logs.length,
      recentLogs: state.logs.slice(-20).map(l => ({
        timestamp: l.timestamp,
        level: l.level,
        category: l.level === 'error' ? 'error' : 'info',
        symbol: null,
        message: l.message,
      })),
    }
  }

  /**
   * Get all symbol metrics
   */
  async getAllSymbolMetrics(): Promise<SymbolMetrics[]> {
    const progressManager = getProgressManager(this.connectionId)
    const state = progressManager.getState()
    
    const metrics: SymbolMetrics[] = []
    for (const symbol of Object.keys(state.symbols)) {
      const symbolMetrics = await this.getSymbolMetrics(symbol)
      if (symbolMetrics) {
        metrics.push(symbolMetrics)
      }
    }
    
    return metrics
  }

  /**
   * Get metrics for UI display
   */
  async getUIMetrics(): Promise<{
    overall: OverallMetrics
    symbols: SymbolMetrics[]
    logs: EngineLogEntry[]
  }> {
    const [overall, symbols] = await Promise.all([
      this.getOverallMetrics(),
      this.getAllSymbolMetrics(),
    ])
    
    const logs = this.logger.getLogs({
      connectionId: this.connectionId,
      limit: 100,
    })

    return { overall, symbols, logs }
  }
}
