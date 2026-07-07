"use client"


export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { AnalyticsFilters } from "@/components/statistics/analytics-filters"
import { StrategyPerformanceTable } from "@/components/statistics/strategy-performance-table"
import { AnalyticsEngine } from "@/lib/analytics"
import { TradingEngine } from "@/lib/trading"
import type { AnalyticsFilter, StrategyAnalytics, SymbolAnalytics, TimeSeriesData } from "@/lib/analytics"
import type { TradingPosition } from "@/lib/trading"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ComposedChart,
} from "recharts"
import {
  TrendingUp,
  BarChart3,
  PieChartIcon,
  RefreshCw,
  Activity,
  AlertTriangle,
  Target,
  Zap,
  Layers,
  Settings,
  TrendingDown,
  Award,
  Star,
  Brain,
  Cpu,
  Network,
  BarChart as BarChartIcon,
  PieChart as PieChartIcon2,
  LineChart as LineChartIcon,
  ScatterChart as ScatterChartIcon,

} from "lucide-react"
import { AdjustStrategyStats } from "@/components/statistics/adjust-strategy-stats"
import { BlockStrategyStats } from "@/components/statistics/block-strategy-stats"
import { PresetTradeStats } from "@/components/statistics/preset-trade-stats"
import { StatisticsOverview } from "@/components/settings/statistics-overview"
import { useExchange } from "@/lib/exchange-context"
import { PageHeader } from "@/components/page-header"

// Enhanced types for comprehensive analytics
interface OptimalStrategyMetrics {
  strategyType: string
  adjustmentType: string
  coordinationMethod: string
  optimalScore: number
  confidence: number
  riskAdjustedReturn: number
  maxDrawdown: number
  winRate: number
  profitFactor: number
  sharpeRatio: number
  sortinoRatio: number
  calmarRatio: number
  recommendations: string[]
}

interface CoordinationAnalysis {
  type: 'strategy_adjustment' | 'method_coordination' | 'temporal_coordination'
  primaryType: string
  secondaryType: string
  correlation: number
  synergyScore: number
  riskReduction: number
  performanceBoost: number
  optimalCombination: boolean
}

interface ComprehensiveAnalytics {
  optimalStrategies: OptimalStrategyMetrics[]
  coordinationAnalysis: CoordinationAnalysis[]
  marketConditionInsights: any
  temporalPatterns: any
  riskMetrics: any
}

export default function StatisticsPage() {
  const { selectedExchange, selectedConnectionId } = useExchange()
  const [activeTab, setActiveTab] = useState("overview")
  const [analyticsEngine, setAnalyticsEngine] = useState<AnalyticsEngine | null>(null)
  const [hasRealConnections, setHasRealConnections] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState<AnalyticsFilter>({
    symbols: [],
    timeRange: {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      end: new Date(),
    },
    indicationTypes: [],
    strategyTypes: [],
    trailingEnabled: undefined,
    minProfitFactor: undefined,
    maxDrawdown: undefined,
  })

  const [strategyAnalytics, setStrategyAnalytics] = useState<StrategyAnalytics[]>([])
  const [symbolAnalytics, setSymbolAnalytics] = useState<SymbolAnalytics[]>([])
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesData[]>([])
  const [mockPositions, setMockPositions] = useState<TradingPosition[]>([])
  const [settings, setSettings] = useState<any>(null)

  // Enhanced analytics state
  const [optimalStrategies, setOptimalStrategies] = useState<OptimalStrategyMetrics[]>([])
  const [coordinationAnalysis, setCoordinationAnalysis] = useState<CoordinationAnalysis[]>([])
  const [comprehensiveAnalytics, setComprehensiveAnalytics] = useState<ComprehensiveAnalytics | null>(null)
  const [analysisMode, setAnalysisMode] = useState<'overview' | 'optimal' | 'coordination' | 'temporal'>('overview')

  useEffect(() => {
    async function initialize() {
      setIsLoading(true)

      try {
        const url = selectedExchange 
          ? `/api/settings/connections?exchange=${selectedExchange}`
          : "/api/settings/connections"
        
        console.log("[v0] [Statistics] Loading connections for exchange:", selectedExchange || "all")
        const response = await fetch(url)
        const data = await response.json()
        const activeConnections = data.connections?.filter((c: any) => c.is_enabled) || []
        setHasRealConnections(activeConnections.length > 0)

        const settingsResponse = await fetch("/api/settings")
        if (settingsResponse.ok) {
          const settingsData = await settingsResponse.json()
          setSettings(settingsData.settings || {})
        }

        if (activeConnections.length === 0) {
          // No real connections configured — fall back to demo positions so
          // the analytics views remain explorable on a fresh install.
          const tradingEngine = new TradingEngine()
          const connections = ["bingx-x01", "pionex-x01"]
          const positions: TradingPosition[] = []

          connections.forEach((connectionId) => {
            tradingEngine.generateMockPositions(connectionId, 50)
            positions.push(...tradingEngine.getOpenPositions(connectionId))
            positions.push(...tradingEngine.getClosedPositions(connectionId, 100))
          })

          setMockPositions(positions)
          const engine = new AnalyticsEngine(positions)
          setAnalyticsEngine(engine)
          updateAnalytics(engine, filter)
        } else {
          // Real connections exist — pull the actual positions for the
          // currently-selected exchange connection (or merge all active ones
          // if the user hasn't picked one yet) and feed them into the
          // analytics engine. This was the last page still running on
          // fabricated mock data even when the user had live connections.
          try {
            const scopeIds: string[] = selectedConnectionId
              ? [selectedConnectionId]
              : activeConnections.map((c: any) => c.id).filter(Boolean)

            const responses = await Promise.all(
              scopeIds.map((id: string) =>
                fetch(`/api/data/positions?connectionId=${encodeURIComponent(id)}`, { cache: "no-store" })
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null),
              ),
            )

            const merged: TradingPosition[] = []
            for (const payload of responses) {
              if (payload && payload.success && Array.isArray(payload.data)) {
                for (const p of payload.data) {
                  // Shape payload from /api/data/positions (camelCase) into the
                  // snake_case TradingPosition the AnalyticsEngine consumes.
                  const entryPrice = Number(p.entryPrice) || 0
                  const currentPrice = Number(p.currentPrice) || 0
                  const quantity = Number(p.quantity) || 0
                  const leverage = Number(p.leverage) || 1
                  const unrealized = Number(p.unrealizedPnl) || 0
                  merged.push({
                    id: p.id,
                    connection_id: payload.connectionId || "",
                    symbol: p.symbol,
                    strategy_type: "real",
                    volume: quantity,
                    entry_price: entryPrice,
                    current_price: currentPrice,
                    takeprofit: p.takeProfitPrice ? Number(p.takeProfitPrice) : undefined,
                    stoploss: p.stopLossPrice ? Number(p.stopLossPrice) : undefined,
                    profit_loss: unrealized,
                    status: p.status === "closed" ? "closed" : "open",
                    opened_at: p.createdAt || new Date().toISOString(),
                    closed_at: p.status === "closed" ? p.createdAt : undefined,
                    position_side: String(p.side || "LONG").toLowerCase() as "long" | "short",
                    leverage,
                    indication_type: "direction",
                    unrealized_pnl: unrealized,
                    realized_pnl: 0,
                    margin_used: entryPrice * quantity / Math.max(leverage, 1),
                    fees_paid: 0,
                    hold_time: 0,
                    max_profit: Math.max(0, unrealized),
                    max_loss: Math.min(0, unrealized),
                  } as TradingPosition)
                }
              }
            }

            setMockPositions(merged)
            const engine = new AnalyticsEngine(merged)
            setAnalyticsEngine(engine)
            updateAnalytics(engine, filter)
          } catch (err) {
            console.error("[v0] [Statistics] Failed to load real positions:", err)
          }
        }
      } catch (error) {
        console.error("Failed to check connections:", error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [selectedExchange, selectedConnectionId])

  const updateAnalytics = (engine: AnalyticsEngine, currentFilter: AnalyticsFilter) => {
    const strategies = engine.generateStrategyAnalytics(currentFilter)
    const symbols = engine.generateSymbolAnalytics(currentFilter)
    const timeSeries = engine.generateTimeSeriesData(currentFilter)

    setStrategyAnalytics(strategies)
    setSymbolAnalytics(symbols)
    setTimeSeriesData(timeSeries)

    // Calculate comprehensive analytics
    const comprehensive = calculateComprehensiveAnalytics(strategies, symbols, timeSeries, currentFilter)
    setComprehensiveAnalytics(comprehensive)
    setOptimalStrategies(comprehensive.optimalStrategies)
    setCoordinationAnalysis(comprehensive.coordinationAnalysis)
  }

  const calculateComprehensiveAnalytics = (
    strategies: StrategyAnalytics[],
    symbols: SymbolAnalytics[],
    timeSeries: TimeSeriesData[],
    filter: AnalyticsFilter
  ): ComprehensiveAnalytics => {
    // Calculate optimal strategies across all types
    const optimalStrategies = calculateOptimalStrategies(strategies, symbols)

    // Analyze coordination between different strategy types and methods
    const coordinationAnalysis = calculateCoordinationAnalysis(strategies, symbols, timeSeries)

    // Market condition insights
    const marketConditionInsights = calculateMarketConditionInsights(timeSeries, symbols)

    // Temporal patterns
    const temporalPatterns = calculateTemporalPatterns(timeSeries, strategies)

    // Risk metrics
    const riskMetrics = calculateRiskMetrics(strategies, symbols, timeSeries)

    return {
      optimalStrategies,
      coordinationAnalysis,
      marketConditionInsights,
      temporalPatterns,
      riskMetrics,
    }
  }

  const calculateOptimalStrategies = (strategies: StrategyAnalytics[], symbols: SymbolAnalytics[]): OptimalStrategyMetrics[] => {
    const strategyTypes = ['base', 'main', 'real']
    const adjustmentTypes = ['none', 'block', 'dca', 'trailing', 'block+dca']
    const coordinationMethods = ['direct', 'preset', 'coordinated']

    const optimalStrategies: OptimalStrategyMetrics[] = []

    strategyTypes.forEach(strategyType => {
      adjustmentTypes.forEach(adjustmentType => {
        coordinationMethods.forEach(method => {
          const relevantStrategies = strategies.filter(s =>
            s.strategy_type?.toLowerCase().includes(strategyType) &&
            (adjustmentType === 'none' || s.strategy_name?.toLowerCase().includes(adjustmentType.toLowerCase()))
          )

          if (relevantStrategies.length > 0) {
            const avgProfitFactor = relevantStrategies.reduce((sum, s) => sum + s.profit_factor, 0) / relevantStrategies.length
            const avgWinRate = relevantStrategies.reduce((sum, s) => sum + s.win_rate, 0) / relevantStrategies.length
            const maxDrawdown = Math.max(...relevantStrategies.map(s => s.drawdown_time || 0))
            const totalTrades = relevantStrategies.reduce((sum, s) => sum + s.total_trades, 0)

            // Calculate optimal score based on multiple factors
            const optimalScore = (
              avgProfitFactor * 0.4 +
              avgWinRate * 0.3 +
              (1 - maxDrawdown) * 0.2 +
              Math.min(totalTrades / 1000, 1) * 0.1
            )

            // Calculate risk-adjusted metrics
            const riskAdjustedReturn = avgProfitFactor / (1 + maxDrawdown)
            const sharpeRatio = avgProfitFactor / (maxDrawdown || 0.1)
            const sortinoRatio = avgProfitFactor / (maxDrawdown * 0.5 || 0.1)
            const calmarRatio = avgProfitFactor / (maxDrawdown || 0.1)

            const recommendations = generateRecommendations(avgProfitFactor, avgWinRate, maxDrawdown, totalTrades)

            optimalStrategies.push({
              strategyType,
              adjustmentType,
              coordinationMethod: method,
              optimalScore,
              confidence: Math.min(totalTrades / 100, 1),
              riskAdjustedReturn,
              maxDrawdown,
              winRate: avgWinRate,
              profitFactor: avgProfitFactor,
              sharpeRatio,
              sortinoRatio,
              calmarRatio,
              recommendations,
            })
          }
        })
      })
    })

    return optimalStrategies.sort((a, b) => b.optimalScore - a.optimalScore)
  }

  const calculateCoordinationAnalysis = (
    strategies: StrategyAnalytics[],
    symbols: SymbolAnalytics[],
    timeSeries: TimeSeriesData[]
  ): CoordinationAnalysis[] => {
    const coordinationAnalysis: CoordinationAnalysis[] = []

    // Strategy-Adjustment coordination
    const strategyTypes = ['base', 'main', 'real']
    const adjustmentTypes = ['block', 'dca', 'trailing']

    strategyTypes.forEach(strategyType => {
      adjustmentTypes.forEach(adjustmentType => {
        const baseStrategies = strategies.filter(s =>
          s.strategy_type?.toLowerCase().includes(strategyType) &&
          !s.strategy_name?.toLowerCase().includes(adjustmentType.toLowerCase())
        )

        const adjustedStrategies = strategies.filter(s =>
          s.strategy_type?.toLowerCase().includes(strategyType) &&
          s.strategy_name?.toLowerCase().includes(adjustmentType.toLowerCase())
        )

        if (baseStrategies.length > 0 && adjustedStrategies.length > 0) {
          const baseAvgProfit = baseStrategies.reduce((sum, s) => sum + s.profit_factor, 0) / baseStrategies.length
          const adjustedAvgProfit = adjustedStrategies.reduce((sum, s) => sum + s.profit_factor, 0) / adjustedStrategies.length

          const synergyScore = adjustedAvgProfit / (baseAvgProfit || 1)
          const correlation = calculateCorrelation(baseStrategies, adjustedStrategies)
          const riskReduction = calculateRiskReduction(baseStrategies, adjustedStrategies)

          coordinationAnalysis.push({
            type: 'strategy_adjustment',
            primaryType: strategyType,
            secondaryType: adjustmentType,
            correlation,
            synergyScore,
            riskReduction,
            performanceBoost: synergyScore - 1,
            optimalCombination: synergyScore > 1.1 && riskReduction > 0.1,
          })
        }
      })
    })

    // Method coordination
    const methods = ['direct', 'preset', 'coordinated']
    methods.forEach(method1 => {
      methods.forEach(method2 => {
        if (method1 !== method2) {
          // Calculate coordination between methods
          const method1Strategies = strategies.filter(s => s.strategy_name?.toLowerCase().includes(method1))
          const method2Strategies = strategies.filter(s => s.strategy_name?.toLowerCase().includes(method2))

          if (method1Strategies.length > 0 && method2Strategies.length > 0) {
            const correlation = calculateCorrelation(method1Strategies, method2Strategies)
            const synergyScore = 1 + Math.abs(correlation) * 0.2

            coordinationAnalysis.push({
              type: 'method_coordination',
              primaryType: method1,
              secondaryType: method2,
              correlation,
              synergyScore,
              riskReduction: Math.abs(correlation) * 0.1,
              performanceBoost: synergyScore - 1,
              optimalCombination: Math.abs(correlation) > 0.5,
            })
          }
        }
      })
    })

    return coordinationAnalysis
  }

  const calculateCorrelation = (group1: StrategyAnalytics[], group2: StrategyAnalytics[]): number => {
    if (group1.length === 0 || group2.length === 0) return 0

    const profits1 = group1.map(s => s.profit_factor)
    const profits2 = group2.map(s => s.profit_factor)

    const mean1 = profits1.reduce((sum, p) => sum + p, 0) / profits1.length
    const mean2 = profits2.reduce((sum, p) => sum + p, 0) / profits2.length

    const covariance = profits1.reduce((sum, p1, i) => {
      const p2 = profits2[Math.min(i, profits2.length - 1)] || mean2
      return sum + (p1 - mean1) * (p2 - mean2)
    }, 0) / profits1.length

    const std1 = Math.sqrt(profits1.reduce((sum, p) => sum + Math.pow(p - mean1, 2), 0) / profits1.length)
    const std2 = Math.sqrt(profits2.reduce((sum, p) => sum + Math.pow(p - mean2, 2), 0) / profits2.length)

    return covariance / (std1 * std2 || 1)
  }

  const calculateRiskReduction = (baseStrategies: StrategyAnalytics[], adjustedStrategies: StrategyAnalytics[]): number => {
    const baseMaxDrawdown = Math.max(...baseStrategies.map(s => s.drawdown_time || 0))
    const adjustedMaxDrawdown = Math.max(...adjustedStrategies.map(s => s.drawdown_time || 0))

    return Math.max(0, (baseMaxDrawdown - adjustedMaxDrawdown) / (baseMaxDrawdown || 1))
  }

  const calculateMarketConditionInsights = (timeSeries: TimeSeriesData[], symbols: SymbolAnalytics[]) => {
    // Analyze market conditions and their impact on different strategies
    const volatilityPeriods = timeSeries.filter(t => Math.abs(t.daily_pnl) > 100) // High volatility based on daily P&L
    const trendingPeriods = timeSeries.filter(t => Math.abs(t.cumulative_pnl) > 1000)
    const rangingPeriods = timeSeries.filter(t => Math.abs(t.daily_pnl) <= 10) // Low volatility based on daily P&L

    return [
      {
        condition: 'High Volatility',
        periodCount: volatilityPeriods.length,
        avgPerformance: volatilityPeriods.reduce((sum, p) => sum + (p.daily_pnl || 0), 0) / volatilityPeriods.length,
        bestSymbols: symbols.filter(s => s.volatility > 0.03).sort((a, b) => b.total_pnl - a.total_pnl).slice(0, 3),
      },
      {
        condition: 'Strong Trend',
        periodCount: trendingPeriods.length,
        avgPerformance: trendingPeriods.reduce((sum, p) => sum + (p.daily_pnl || 0), 0) / trendingPeriods.length,
        bestSymbols: symbols.sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl)).slice(0, 3),
      },
      {
        condition: 'Range Bound',
        periodCount: rangingPeriods.length,
        avgPerformance: rangingPeriods.reduce((sum, p) => sum + (p.daily_pnl || 0), 0) / rangingPeriods.length,
        bestSymbols: symbols.filter(s => s.volatility <= 0.02).sort((a, b) => b.total_pnl - a.total_pnl).slice(0, 3),
      },
    ]
  }

  const calculateTemporalPatterns = (timeSeries: TimeSeriesData[], strategies: StrategyAnalytics[]): { hourly: any[], daily: any[], weekly: any[] } => {
    // Analyze performance patterns across different time periods
    const hourlyPatterns: any[] = []
    const dailyPatterns: any[] = []
    const weeklyPatterns: any[] = []

    // Group by hour of day
    const hourlyGroups: Record<number, TimeSeriesData[]> = {}
    timeSeries.forEach(data => {
      const hour = new Date(data.timestamp).getHours()
      if (!hourlyGroups[hour]) hourlyGroups[hour] = []
      hourlyGroups[hour].push(data)
    })

    Object.entries(hourlyGroups).forEach(([hour, data]) => {
      const avgPnl = data.reduce((sum, d) => sum + (d.daily_pnl || 0), 0) / data.length
      hourlyPatterns.push({ hour: parseInt(hour), avgPnl, tradeCount: data.length })
    })

    return {
      hourly: hourlyPatterns.sort((a, b) => b.avgPnl - a.avgPnl),
      daily: dailyPatterns,
      weekly: weeklyPatterns,
    }
  }

  const calculateRiskMetrics = (strategies: StrategyAnalytics[], symbols: SymbolAnalytics[], timeSeries: TimeSeriesData[]) => {
    const portfolioMetrics = {
      totalValueAtRisk: 0,
      expectedShortfall: 0,
      beta: 0,
      correlationMatrix: {},
      stressTestResults: [],
    }

    // Calculate Value at Risk (VaR)
    const dailyReturns = timeSeries.map((t, i) => {
      if (i === 0) return 0
      const prev = timeSeries[i - 1]
      return ((t.cumulative_pnl || 0) - (prev.cumulative_pnl || 0)) / (prev.cumulative_pnl || 1)
    }).filter(r => r !== 0)

    if (dailyReturns.length > 0) {
      const sortedReturns = dailyReturns.sort((a, b) => a - b)
      const varIndex = Math.floor(sortedReturns.length * 0.05) // 95% VaR
      portfolioMetrics.totalValueAtRisk = Math.abs(sortedReturns[varIndex] || 0)
    }

    return portfolioMetrics
  }

  const generateRecommendations = (profitFactor: number, winRate: number, maxDrawdown: number, totalTrades: number): string[] => {
    const recommendations: string[] = []

    if (profitFactor > 1.5) {
      recommendations.push("Excellent profit factor - consider increasing position size")
    } else if (profitFactor < 1.1) {
      recommendations.push("Low profit factor - review entry/exit criteria")
    }

    if (winRate > 0.7) {
      recommendations.push("High win rate - strategy shows strong directional accuracy")
    } else if (winRate < 0.4) {
      recommendations.push("Low win rate - consider adjusting stop loss placement")
    }

    if (maxDrawdown > 0.3) {
      recommendations.push("High drawdown - implement stricter risk management")
    } else if (maxDrawdown < 0.1) {
      recommendations.push("Low drawdown - excellent risk control")
    }

    if (totalTrades < 100) {
      recommendations.push("Limited sample size - continue testing for more confidence")
    }

    return recommendations
  }

  const handleFilterChange = (newFilter: AnalyticsFilter) => {
    setFilter(newFilter)
    if (analyticsEngine) {
      updateAnalytics(analyticsEngine, newFilter)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  const COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4"]

  const overviewStats = {
    totalStrategies: strategyAnalytics.length,
    profitableStrategies: strategyAnalytics.filter((s) => s.profit_factor > 1).length,
    totalTrades: strategyAnalytics.reduce((sum, s) => sum + s.total_trades, 0),
    totalPnL: strategyAnalytics.reduce((sum, s) => sum + s.total_pnl, 0),
    avgWinRate:
      strategyAnalytics.length > 0
        ? strategyAnalytics.reduce((sum, s) => sum + s.win_rate, 0) / strategyAnalytics.length
        : 0,
    bestStrategy: strategyAnalytics[0]?.strategy_name || "N/A",
  }

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="text-center space-y-3">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary mx-auto"></div>
            <div className="text-sm text-muted-foreground">Loading statistics&hellip;</div>
          </div>
        </div>
      </div>
    )
  }

  if (hasRealConnections) {
    return (
      <div className="p-4">
        <PageHeader title="Advanced Statistics" description="Analytics are populating with real trading data from your active connections." />
        <Card className="mt-4">
          <CardContent className="py-12 text-center space-y-2">
            <BarChart3 className="h-12 w-12 text-muted-foreground/50 mx-auto" />
            <div className="text-sm text-muted-foreground">
              Real-data view is active. Statistics will appear here as your engine generates trades.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  /*
   * Modernized the mock-data view:
   *   - Shared PageHeader replaces the bespoke `<h1>` + big icon.
   *   - Full-width demo-data banner moved above the header for visibility.
   *   - The 6-card big stats row swapped for the compact icon-pill pattern
   *     used across the rest of the sidebar so vertical space is reclaimed
   *     for the charts below.
   */
  return (
    <div className="p-4 space-y-4">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-xs font-semibold text-foreground">Using Mock Data</div>
            <div className="text-xs text-muted-foreground">
              No active exchange connections found. Enable a connection in Settings to see real statistics.
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader
          title="Advanced Statistics & Analytics"
          description="AI-powered trading performance analysis with optimal strategy recommendations"
        />
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="h-7 gap-1">
            <Brain className="h-3 w-3" />
            AI Analysis
          </Badge>
          <Button
            onClick={() => analyticsEngine && updateAnalytics(analyticsEngine, filter)}
            size="sm"
            className="h-8 text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh Analysis
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        {[
          { icon: BarChart3,  label: "Total Strategies", value: overviewStats.totalStrategies, tint: "text-primary" },
          { icon: TrendingUp, label: "Profitable",       value: overviewStats.profitableStrategies, tint: "text-green-500" },
          { icon: Activity,   label: "Total Trades",     value: overviewStats.totalTrades, tint: "text-indigo-500" },
          {
            icon: TrendingDown, // reused lucide icon, avoiding an extra DollarSign import; the stat card label explains the metric
            label: "Total P&L",
            value: formatCurrency(overviewStats.totalPnL),
            tint: overviewStats.totalPnL >= 0 ? "text-green-500" : "text-red-500",
          },
          { icon: PieChartIcon, label: "Avg Win Rate",   value: `${(overviewStats.avgWinRate * 100).toFixed(1)}%`, tint: "text-amber-500" },
          { icon: Award,        label: "Best Strategy",  value: overviewStats.bestStrategy, tint: "text-primary", isWide: true },
        ].map((stat) => (
          <Card key={stat.label} className="border-border bg-card">
            <CardContent className="p-2 flex items-center gap-2">
              <div className={`rounded bg-muted/60 p-1.5 ${stat.tint}`}>
                <stat.icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <div className={`${stat.isWide ? "text-sm" : "text-base"} font-bold tabular-nums truncate ${stat.tint}`}>
                  {stat.value}
                </div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">
                  {stat.label}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1">
          <AnalyticsFilters filter={filter} onFilterChange={handleFilterChange} />
        </div>

        <div className="lg:col-span-3">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-8">
              <TabsTrigger value="overview" className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="optimal" className="flex items-center gap-2">
                <Target className="h-4 w-4" />
                Optimal
              </TabsTrigger>
              <TabsTrigger value="strategies" className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Strategies
              </TabsTrigger>
              <TabsTrigger value="coordination" className="flex items-center gap-2">
                <Network className="h-4 w-4" />
                Coordination
              </TabsTrigger>
              <TabsTrigger value="adjust" className="flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Adjust
              </TabsTrigger>
              <TabsTrigger value="block" className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Block
              </TabsTrigger>
              <TabsTrigger value="preset" className="flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Preset
              </TabsTrigger>
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Cpu className="h-4 w-4" />
                Config
              </TabsTrigger>
            </TabsList>

            <TabsContent value="optimal" className="space-y-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold">Optimal Strategy Analysis</h3>
                  <p className="text-sm text-muted-foreground">AI-powered optimal strategy recommendations across all types</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="flex items-center gap-1">
                    <Star className="h-3 w-3" />
                    {optimalStrategies.length} Analyzed
                  </Badge>
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Award className="h-3 w-3" />
                    Top Performers
                  </Badge>
                </div>
              </div>

              {/* Optimal Strategies Overview */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-green-100 dark:bg-green-900 rounded-lg">
                        <Target className="h-5 w-5 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-green-600">
                          {optimalStrategies.filter(s => s.optimalScore > 0.8).length}
                        </div>
                        <div className="text-sm text-muted-foreground">High-Confidence</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                        <Zap className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-blue-600">
                          {(optimalStrategies.reduce((sum, s) => sum + s.riskAdjustedReturn, 0) / optimalStrategies.length * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Risk-Adjusted</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-100 dark:bg-purple-900 rounded-lg">
                        <TrendingUp className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-purple-600">
                          {optimalStrategies[0]?.strategyType || 'N/A'}
                        </div>
                        <div className="text-sm text-muted-foreground">Top Strategy Type</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Optimal Strategies Table */}
              <Card>
                <CardHeader>
                  <CardTitle>Strategy Optimization Matrix</CardTitle>
                  <CardDescription>
                    Comprehensive analysis of all strategy combinations with optimal scoring
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {optimalStrategies.slice(0, 10).map((strategy, index) => (
                      <div key={`${strategy.strategyType}-${strategy.adjustmentType}-${strategy.coordinationMethod}`}
                        className="border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <Badge variant={index === 0 ? "default" : "secondary"} className="flex items-center gap-1">
                              {index === 0 && <Star className="h-3 w-3" />}
                              #{index + 1}
                            </Badge>
                            <div>
                              <h4 className="font-semibold">
                                {strategy.strategyType} + {strategy.adjustmentType}
                              </h4>
                              <p className="text-sm text-muted-foreground">
                                via {strategy.coordinationMethod} coordination
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-lg font-bold text-green-600">
                              {(strategy.optimalScore * 100).toFixed(1)}%
                            </div>
                            <div className="text-sm text-muted-foreground">Optimal Score</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                          <div>
                            <div className="text-sm text-muted-foreground">Profit Factor</div>
                            <div className="font-semibold">{strategy.profitFactor.toFixed(2)}</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Win Rate</div>
                            <div className="font-semibold">{(strategy.winRate * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Max Drawdown</div>
                            <div className="font-semibold">{(strategy.maxDrawdown * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Risk-Adjusted</div>
                            <div className="font-semibold">{(strategy.riskAdjustedReturn * 100).toFixed(1)}%</div>
                          </div>
                        </div>

                        <div className="mb-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm text-muted-foreground">Confidence</span>
                            <span className="text-sm font-medium">{(strategy.confidence * 100).toFixed(0)}%</span>
                          </div>
                          <Progress value={strategy.confidence * 100} className="h-2" />
                        </div>

                        {strategy.recommendations.length > 0 && (
                          <div>
                            <div className="text-sm font-medium mb-2">Recommendations:</div>
                            <div className="flex flex-wrap gap-1">
                              {strategy.recommendations.map((rec, i) => (
                                <Badge key={i} variant="outline" className="text-xs">
                                  {rec}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Risk-Return Scatter Plot */}
              <Card>
                <CardHeader>
                  <CardTitle>Risk-Return Optimization</CardTitle>
                  <CardDescription>
                    Optimal strategies plotted by risk-adjusted returns vs. maximum drawdown
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={400}>
                    <ScatterChart data={optimalStrategies}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        dataKey="maxDrawdown"
                        domain={[0, 'dataMax']}
                        tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                        label={{ value: 'Max Drawdown', position: 'insideBottom', offset: -5 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="riskAdjustedReturn"
                        tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                        label={{ value: 'Risk-Adjusted Return', angle: -90, position: 'insideLeft' }}
                      />
                      <Tooltip
                        formatter={(value: number, name: string) => [
                          name === 'maxDrawdown' ? `${(value * 100).toFixed(1)}%` : `${(value * 100).toFixed(1)}%`,
                          name === 'maxDrawdown' ? 'Max Drawdown' : 'Risk-Adjusted Return'
                        ]}
                        labelFormatter={(label) => `Strategy: ${optimalStrategies[label]?.strategyType || 'Unknown'}`}
                      />
                      <Scatter
                        name="Strategies"
                        dataKey="riskAdjustedReturn"
                        fill="#3b82f6"
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="coordination" className="space-y-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold">Strategy Coordination Analysis</h3>
                  <p className="text-sm text-muted-foreground">Advanced coordination insights between strategy types and methods</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="flex items-center gap-1">
                    <Network className="h-3 w-3" />
                    {coordinationAnalysis.length} Connections
                  </Badge>
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    Optimal Pairs
                  </Badge>
                </div>
              </div>

              {/* Coordination Overview */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                        <Network className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {coordinationAnalysis.filter(c => c.optimalCombination).length}
                        </div>
                        <div className="text-sm text-muted-foreground">Optimal Pairs</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-green-100 dark:bg-green-900 rounded-lg">
                        <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {(coordinationAnalysis.reduce((sum, c) => sum + c.performanceBoost, 0) / coordinationAnalysis.length * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Performance Boost</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-orange-100 dark:bg-orange-900 rounded-lg">
                        <Activity className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {(coordinationAnalysis.reduce((sum, c) => sum + c.riskReduction, 0) / coordinationAnalysis.length * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Risk Reduction</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-100 dark:bg-purple-900 rounded-lg">
                        <BarChart3 className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {Math.abs(coordinationAnalysis.reduce((sum, c) => sum + c.correlation, 0) / coordinationAnalysis.length).toFixed(2)}
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Correlation</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Coordination Matrix */}
              <Card>
                <CardHeader>
                  <CardTitle>Strategy Coordination Matrix</CardTitle>
                  <CardDescription>
                    Synergy analysis between different strategy types and coordination methods
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {coordinationAnalysis.slice(0, 12).map((coord, index) => (
                      <div key={`${coord.type}-${coord.primaryType}-${coord.secondaryType}`}
                        className="border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <Badge variant={coord.optimalCombination ? "default" : "secondary"}>
                              {coord.optimalCombination ? "Optimal" : "Compatible"}
                            </Badge>
                            <div>
                              <h4 className="font-semibold">
                                {coord.primaryType} ↔ {coord.secondaryType}
                              </h4>
                              <p className="text-sm text-muted-foreground capitalize">
                                {coord.type.replace('_', ' ')} coordination
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`text-lg font-bold ${
                              coord.synergyScore > 1.1 ? "text-green-600" :
                              coord.synergyScore > 0.9 ? "text-yellow-600" : "text-red-600"
                            }`}>
                              {(coord.synergyScore * 100).toFixed(1)}%
                            </div>
                            <div className="text-sm text-muted-foreground">Synergy Score</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                          <div>
                            <div className="text-sm text-muted-foreground">Correlation</div>
                            <div className="font-semibold">
                              {coord.correlation >= 0 ? '+' : ''}{(coord.correlation * 100).toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Performance Boost</div>
                            <div className="font-semibold text-green-600">
                              +{(coord.performanceBoost * 100).toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Risk Reduction</div>
                            <div className="font-semibold text-blue-600">
                              {(coord.riskReduction * 100).toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Compatibility</div>
                            <div className="font-semibold">
                              {coord.optimalCombination ? "High" : "Medium"}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm text-muted-foreground">Synergy Level</span>
                              <span className="text-sm font-medium">
                                {coord.synergyScore > 1.2 ? "Excellent" :
                                 coord.synergyScore > 1.1 ? "Good" :
                                 coord.synergyScore > 0.9 ? "Fair" : "Poor"}
                              </span>
                            </div>
                            <Progress
                              value={Math.min((coord.synergyScore - 0.8) * 100, 100)}
                              className="h-2"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Coordination Network Visualization */}
              <Card>
                <CardHeader>
                  <CardTitle>Coordination Network</CardTitle>
                  <CardDescription>
                    Visual representation of strategy relationships and optimal combinations
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={400}>
                    <RadarChart data={coordinationAnalysis.slice(0, 8).map(coord => ({
                      coordination: `${coord.primaryType}-${coord.secondaryType}`,
                      synergy: coord.synergyScore * 100,
                      correlation: Math.abs(coord.correlation) * 100,
                      performance: coord.performanceBoost * 100,
                      risk: coord.riskReduction * 100,
                    }))}>
                      <PolarGrid />
                      <PolarAngleAxis dataKey="coordination" />
                      <PolarRadiusAxis angle={90} domain={[0, 150]} />
                      <Radar
                        name="Synergy"
                        dataKey="synergy"
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.1}
                        strokeWidth={2}
                      />
                      <Radar
                        name="Performance Boost"
                        dataKey="performance"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.1}
                        strokeWidth={2}
                      />
                      <Tooltip />
                    </RadarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="overview" className="space-y-6">
              {/* Enhanced Overview Stats */}
              <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-5 w-5 text-blue-500" />
                      <div>
                        <div className="text-2xl font-bold">{strategyAnalytics.length}</div>
                        <div className="text-sm text-muted-foreground">Total Strategies</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-5 w-5 text-green-500" />
                      <div>
                        <div className="text-2xl font-bold">{strategyAnalytics.filter((s) => s.profit_factor > 1).length}</div>
                        <div className="text-sm text-muted-foreground">Profitable</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <Activity className="h-5 w-5 text-purple-500" />
                      <div>
                        <div className="text-2xl font-bold">{strategyAnalytics.reduce((sum, s) => sum + s.total_trades, 0)}</div>
                        <div className="text-sm text-muted-foreground">Total Trades</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <div className={`h-5 w-5 rounded ${overviewStats.totalPnL >= 0 ? "bg-green-500" : "bg-red-500"}`} />
                      <div>
                        <div
                          className={`text-2xl font-bold ${overviewStats.totalPnL >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {formatCurrency(overviewStats.totalPnL)}
                        </div>
                        <div className="text-sm text-muted-foreground">Total P&L</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <PieChartIcon className="h-5 w-5 text-orange-500" />
                      <div>
                        <div className="text-2xl font-bold">{(overviewStats.avgWinRate * 100).toFixed(1)}%</div>
                        <div className="text-sm text-muted-foreground">Avg Win Rate</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <Target className="h-5 w-5 text-cyan-500" />
                      <div>
                        <div className="text-lg font-bold truncate">{overviewStats.bestStrategy}</div>
                        <div className="text-sm text-muted-foreground">Best Strategy</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Comprehensive Performance Chart */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <LineChartIcon className="h-5 w-5" />
                    Portfolio Performance Matrix
                  </CardTitle>
                  <CardDescription>
                    Multi-dimensional performance analysis with balance, equity, and drawdown tracking
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={350}>
                    <ComposedChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleDateString()} />
                      <YAxis yAxisId="price" orientation="left" tickFormatter={(value) => formatCurrency(value)} />
                      <YAxis yAxisId="percentage" orientation="right" tickFormatter={(value) => `${value.toFixed(1)}%`} />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: number, name: string) => {
                          if (name === 'drawdown') return [`${(value * 100).toFixed(1)}%`, 'Drawdown']
                          return [formatCurrency(value), name]
                        }}
                      />
                      <Area
                        yAxisId="price"
                        type="monotone"
                        dataKey="balance"
                        stackId="1"
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.3}
                        name="Balance"
                      />
                      <Area
                        yAxisId="price"
                        type="monotone"
                        dataKey="equity"
                        stackId="2"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.3}
                        name="Equity"
                      />
                      <Line
                        yAxisId="percentage"
                        type="monotone"
                        dataKey="drawdown"
                        stroke="#ef4444"
                        strokeWidth={2}
                        name="drawdown"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Market Condition Insights */}
              {comprehensiveAnalytics?.marketConditionInsights && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Brain className="h-5 w-5" />
                      Market Condition Intelligence
                    </CardTitle>
                    <CardDescription>
                      AI-powered analysis of how different market conditions affect strategy performance
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {comprehensiveAnalytics.marketConditionInsights.map((condition: any, index: number) => (
                        <div key={condition.condition} className="border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold">{condition.condition}</h4>
                            <Badge variant={index === 0 ? "default" : "secondary"}>
                              {condition.periodCount} periods
                            </Badge>
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Avg Performance:</span>
                              <span className={`font-medium ${condition.avgPerformance >= 0 ? "text-green-600" : "text-red-600"}`}>
                                {formatCurrency(condition.avgPerformance)}
                              </span>
                            </div>
                            <div className="text-sm">
                              <div className="text-muted-foreground mb-1">Top Performing Symbols:</div>
                              <div className="flex flex-wrap gap-1">
                                {condition.bestSymbols.map((symbol: any, i: number) => (
                                  <Badge key={i} variant="outline" className="text-xs">
                                    {symbol.symbol}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Enhanced Strategy Performance */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <BarChart className="h-5 w-5" />
                      Strategy Type Performance Matrix
                    </CardTitle>
                    <CardDescription>
                      Comparative analysis across all strategy types with optimal scoring
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={strategyAnalytics.slice(0, 8)}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="strategy_type" />
                        <YAxis />
                        <Tooltip
                          formatter={(value: number, name: string) => {
                            if (name === 'profit_factor') return [value.toFixed(2), 'Profit Factor']
                            if (name === 'win_rate') return [`${(value * 100).toFixed(1)}%`, 'Win Rate']
                            return [value, name]
                          }}
                        />
                        <Bar dataKey="profit_factor" fill="#3b82f6" name="Profit Factor" />
                        <Bar dataKey="win_rate" fill="#10b981" name="Win Rate" />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Symbol Performance Distribution */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <PieChartIcon2 className="h-5 w-5" />
                      Symbol Performance Distribution
                    </CardTitle>
                    <CardDescription>
                      Trade volume and profitability distribution across symbols
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={symbolAnalytics.slice(0, 8).map((s, index) => ({
                            symbol: s.symbol,
                            total_trades: s.total_trades,
                            total_pnl: s.total_pnl,
                            win_rate: s.win_rate,
                            fill: COLORS[index % COLORS.length],
                          }))}
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          dataKey="total_trades"
                          label={({ symbol, percent }) => `${symbol} ${(percent * 100).toFixed(0)}%`}
                        />
                        <Tooltip
                          formatter={(value: number, name: string) => {
                            if (name === 'total_trades') return [value, 'Total Trades']
                            if (name === 'total_pnl') return [formatCurrency(value), 'Total P&L']
                            if (name === 'win_rate') return [`${(value * 100).toFixed(1)}%`, 'Win Rate']
                            return [value, name]
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              {/* Risk Metrics Summary */}
              {comprehensiveAnalytics?.riskMetrics && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5" />
                      Risk Assessment Dashboard
                    </CardTitle>
                    <CardDescription>
                      Comprehensive risk metrics including VaR, stress testing, and correlation analysis
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-red-600">
                          {(comprehensiveAnalytics.riskMetrics.totalValueAtRisk * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Value at Risk (95%)</div>
                        <div className="text-xs text-muted-foreground mt-1">Daily loss threshold</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-yellow-600">
                          {(strategyAnalytics.reduce((sum, s) => sum + (s.drawdown_time || 0), 0) / strategyAnalytics.length * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Max Drawdown</div>
                        <div className="text-xs text-muted-foreground mt-1">Peak-to-trough decline</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-blue-600">
                          {strategyAnalytics.filter(s => s.profit_factor > 1).length}
                        </div>
                        <div className="text-sm text-muted-foreground">Risk-Adjusted Winners</div>
                        <div className="text-xs text-muted-foreground mt-1">Strategies beating benchmark</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-green-600">
                          {(optimalStrategies.reduce((sum, s) => sum + s.sharpeRatio, 0) / optimalStrategies.length).toFixed(2)}
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Sharpe Ratio</div>
                        <div className="text-xs text-muted-foreground mt-1">Risk-adjusted returns</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="strategies" className="space-y-6">
              <StrategyPerformanceTable
                strategies={strategyAnalytics}
                onStrategyClick={(strategy) => {
                  console.log("Strategy clicked:", strategy)
                }}
              />
            </TabsContent>

            <TabsContent value="symbols" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Symbol Performance Analysis</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {symbolAnalytics.map((symbol, index) => (
                      <Card key={symbol.symbol}>
                        <CardContent className="p-4">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <h3 className="font-semibold text-lg">{symbol.symbol}</h3>
                              <div
                                className={`text-sm font-medium ${symbol.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                              >
                                {formatCurrency(symbol.total_pnl)}
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              <div>
                                <div className="text-muted-foreground">Trades</div>
                                <div className="font-medium">{symbol.total_trades}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">Win Rate</div>
                                <div className="font-medium">{(symbol.win_rate * 100).toFixed(1)}%</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">Avg/Trade</div>
                                <div className="font-medium">{formatCurrency(symbol.avg_profit_per_trade)}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">Volatility</div>
                                <div className="font-medium">{(symbol.volatility * 100).toFixed(1)}%</div>
                              </div>
                            </div>
                            <div className="pt-2 border-t text-xs">
                              <div className="text-muted-foreground">Best: {symbol.best_strategy}</div>
                              <div className="text-muted-foreground">Worst: {symbol.worst_strategy}</div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="charts" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Cumulative P&L</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleDateString()} />
                      <YAxis tickFormatter={(value) => formatCurrency(value)} />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: number) => [formatCurrency(value), "Cumulative P&L"]}
                      />
                      <Line type="monotone" dataKey="cumulative_pnl" stroke="#10b981" strokeWidth={3} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Daily P&L</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={timeSeriesData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleDateString()} />
                        <YAxis tickFormatter={(value) => formatCurrency(value)} />
                        <Tooltip
                          labelFormatter={(value) => new Date(value).toLocaleDateString()}
                          formatter={(value: number) => [formatCurrency(value), "Daily P&L"]}
                        />
                        <Bar dataKey="daily_pnl">
                          {timeSeriesData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.daily_pnl >= 0 ? "#10b981" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Open Positions Over Time</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={timeSeriesData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleDateString()} />
                        <YAxis />
                        <Tooltip
                          labelFormatter={(value) => new Date(value).toLocaleDateString()}
                          formatter={(value: number) => [value, "Open Positions"]}
                        />
                        <Line type="monotone" dataKey="open_positions" stroke="#f59e0b" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="preset" className="space-y-6">
              <PresetTradeStats filter={filter} positions={mockPositions} />
            </TabsContent>

            <TabsContent value="adjust" className="space-y-6">
              <AdjustStrategyStats
                positions={mockPositions
                  .filter((p) => p.status === "closed")
                  .map((p) => ({
                    id: p.id,
                    connection_id: p.connection_id,
                    symbol: p.symbol,
                    indication_type: (p.indication_type || "direction") as "direction" | "move" | "active",
                    takeprofit_factor: 2.0, // Default value
                    stoploss_ratio: 0.5, // Default value
                    trailing_enabled: false,
                    entry_price: p.entry_price,
                    current_price: p.current_price,
                    profit_factor:
                      p.realized_pnl > 0
                        ? 1 + Math.abs(p.realized_pnl) / (p.margin_used || 100)
                        : 1 - Math.abs(p.realized_pnl) / (p.margin_used || 100),
                    position_cost: p.margin_used || 100,
                    status: "closed" as const,
                    created_at: p.opened_at,
                    updated_at: p.closed_at || p.opened_at,
                  }))}
                timeIntervals={[4, 12, 24, 48]}
                drawdownPositionCount={80}
              />
            </TabsContent>

            <TabsContent value="block" className="space-y-6">
              <BlockStrategyStats
                positions={mockPositions
                  .filter((p) => p.status === "closed")
                  .map((p) => ({
                    id: p.id,
                    connection_id: p.connection_id,
                    symbol: p.symbol,
                    indication_type: (p.indication_type || "direction") as "direction" | "move" | "active",
                    takeprofit_factor: 2.0, // Default value
                    stoploss_ratio: 0.5, // Default value
                    trailing_enabled: false,
                    entry_price: p.entry_price,
                    current_price: p.current_price,
                    profit_factor:
                      p.realized_pnl > 0
                        ? 1 + Math.abs(p.realized_pnl) / (p.margin_used || 100)
                        : 1 - Math.abs(p.realized_pnl) / (p.margin_used || 100),
                    position_cost: p.margin_used || 100,
                    status: "closed" as const,
                    created_at: p.opened_at,
                    updated_at: p.closed_at || p.opened_at,
                  }))}
                comparisonWindow={50}
              />
            </TabsContent>

            <TabsContent value="config" className="space-y-4">
              {settings ? (
                <StatisticsOverview settings={settings} />
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Loading Configuration...</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">Please wait while we load the system configuration.</p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
