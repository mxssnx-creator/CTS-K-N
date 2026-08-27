"use client"


export const dynamic = "force-dynamic"
import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AnalyticsFilters } from "@/components/statistics/analytics-filters"
import { StrategyPerformanceTable } from "@/components/statistics/strategy-performance-table"
import { AnalyticsEngine } from "@/lib/analytics"
import type { AnalyticsFilter, StrategyAnalytics, SymbolAnalytics, TimeSeriesData } from "@/lib/analytics"
import type { TradingPosition } from "@/lib/trading"
import type { PseudoPosition } from "@/lib/types"
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
  History,

} from "lucide-react"
import { AdjustStrategyStats } from "@/components/statistics/adjust-strategy-stats"
import { BlockStrategyStats } from "@/components/statistics/block-strategy-stats"
import { PresetTradeStats } from "@/components/statistics/preset-trade-stats"
import { StatisticsOverview } from "@/components/settings/statistics-overview"
import { useExchange } from "@/lib/exchange-context"
import { PageHeader } from "@/components/page-header"
import { TradeHistoryTable, type TradeHistoryRow } from "@/components/dashboard/trade-history-table"
import { StatisticsSectionNav } from "@/components/statistics/statistics-section-nav"
import {
  statisticsHistoryTupleToTradingPosition,
  toStatisticsHistoryTuple,
  type StatisticsHistoryTupleV1,
} from "@/lib/trade-history"
import {
  buildLiveTradingAnalytics,
  type DrawdownTimeMetric,
  type LiveTradingAnalytics,
  type ProfitFactorMetric,
} from "@/lib/live-trading-analytics"
import { signedResultRToMainTradePfRatio } from "@/lib/main-trade-profit-factor"

// Enhanced types for comprehensive analytics
interface OptimalStrategyMetrics {
  strategyName: string
  strategyType: string
  adjustmentType: string
  coordinationMethod: string
  optimalScore: number
  confidence: number
  totalTrades: number
  riskAdjustedReturn: number
  maxDrawdown: number
  winRate: number
  profitFactor: number
  sharpeRatio: number
  recommendations: string[]
}

function toStatisticsPseudoPosition(position: TradingPosition): PseudoPosition {
  const entryPrice = Number(position.entry_price) || 0
  const takeProfit = Number(position.takeprofit) || 0
  const stopLoss = Number(position.stoploss) || 0
  const tpDistance = entryPrice > 0 && takeProfit > 0
    ? Math.abs(takeProfit - entryPrice)
    : 0
  const slDistance = entryPrice > 0 && stopLoss > 0
    ? Math.abs(entryPrice - stopLoss)
    : 0
  const realizedPnl = Number(position.realized_pnl ?? position.profit_loss) || 0
  const notional = Math.abs(entryPrice * (Number(position.volume) || 0))
  // Keep the explicit signed Result-R and the operator PF coordinate separate.
  // The canonical coordinate is 1.00 neutral and advances by 0.10 per signed
  // PositionCost unit; +1R therefore maps to 1.10, never 2.00.
  const positionCost = Number(position.margin_used) > 0
    ? Number(position.margin_used)
    : notional > 0
      ? notional
      : Math.max(Math.abs(realizedPnl), Number.EPSILON)
  const rawStrategy = String(position.strategy_type || "").toLowerCase()
  const strategyType: PseudoPosition["strategy_type"] =
    rawStrategy.includes("block") ? "block"
      : rawStrategy.includes("dca") ? "dca"
        : rawStrategy.includes("real") ? "real"
          : rawStrategy.includes("main") ? "main"
            : "base"
  const enriched = position as TradingPosition & {
    trailing_enabled?: boolean
    trail_start?: number
    trail_stop?: number
  }

  return {
    id: position.id,
    connection_id: position.connection_id,
    symbol: position.symbol,
    direction: position.position_side,
    indication_type: position.indication_type || "direction",
    takeprofit_factor: entryPrice > 0 ? (tpDistance / entryPrice) * 100 : 0,
    stoploss_ratio: tpDistance > 0 ? slDistance / tpDistance : 0,
    trailing_enabled:
      enriched.trailing_enabled === true ||
      rawStrategy.includes("trail"),
    ...(Number.isFinite(Number(enriched.trail_start)) && { trail_start: Number(enriched.trail_start) }),
    ...(Number.isFinite(Number(enriched.trail_stop)) && { trail_stop: Number(enriched.trail_stop) }),
    entry_price: entryPrice,
    current_price: Number(position.current_price) || 0,
    profit_factor: signedResultRToMainTradePfRatio(realizedPnl / positionCost),
    profit_factor_kind: "main_trade_pf_ratio",
    signedResultR: realizedPnl / positionCost,
    costNormalizedReturn: realizedPnl / positionCost,
    position_cost: positionCost,
    status: "closed",
    created_at: position.opened_at,
    updated_at: position.closed_at || position.opened_at,
    strategy_type: strategyType,
  }
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
  pnlRegimeInsights: Array<{
    condition: string
    periodCount: number
    averagePnlUsd: number
    totalPnlUsd: number
  }>
  riskMetrics: {
    sampleCount: number
    historicalLossQuantile95Usd: number | null
    expectedShortfallUsd: number | null
  }
}

interface CurrentStrategyRows {
  base: { total: number; valid: number; totalOpen: number; validOpen: number; validRatio: number }
  main: { valid: number; overall: number; validOpen: number; overallOpen: number; overallToValidRatio: number }
  real: { valid: number; active: number; activeExactRows: number; activeRatio: number }
  live: { total: number; mirrored: number; active: number; mirroredRatio: number }
}

interface MainIndicationSnapshot {
  types: Record<string, {
    label: string
    trackings: number
    evaluated: number
    active: number
    progressingSets: number
  }>
  totals: {
    trackings: number
    evaluated: number
    active: number
    progressingSets: number
  }
}

interface RuntimeTelemetry {
  capturedAt?: string
  concurrency?: {
    cpuCount?: number
    cpuSource?: string
    symbolConcurrency?: number
    historicSymbolConcurrency?: number
    calculationConcurrency?: number
    indicationTypeConcurrency?: number
    ioConcurrency?: number
    load1m?: number
  }
  memory?: {
    rssMB?: number
    heapUsedMB?: number
    heapTotalMB?: number
  }
  eventLoop?: {
    utilizationPct?: number
    delayP95Ms?: number
    delayMaxMs?: number
  }
}

interface StatisticsArchiveCoverage {
  indexed: number
  uniqueIds: number
  resolvedSnapshots: number
  eligibleSnapshots: number
  normalizedSnapshots: number
  excludedNonTradeSnapshots: number
  unresolvedTradeSnapshots: number
  normalizedLocalRows: number
  exchangeOverlays: number
  returned: number
  complete: boolean
  capturedAt: number
}

const TOP_TIME_RANGES = [
  { value: "24h", label: "Last 24 hours", durationMs: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", durationMs: 30 * 24 * 60 * 60 * 1000 },
  { value: "90d", label: "Last 90 days", durationMs: 90 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All executed history", durationMs: null },
] as const

function aggregateProfitFactorMetrics(metrics: ProfitFactorMetric[]): ProfitFactorMetric {
  const totals = metrics.reduce((result, metric) => ({
    trades: result.trades + metric.trades,
    wins: result.wins + metric.wins,
    losses: result.losses + metric.losses,
    flat: result.flat + metric.flat,
    grossProfit: result.grossProfit + metric.grossProfit,
    grossLoss: result.grossLoss + metric.grossLoss,
    volumeUsd: result.volumeUsd + metric.volumeUsd,
  }), {
    trades: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    grossProfit: 0,
    grossLoss: 0,
    volumeUsd: 0,
  })
  const decided = totals.wins + totals.losses
  return {
    ...totals,
    netPnl: totals.grossProfit - totals.grossLoss,
    winRate: decided > 0 ? (totals.wins / decided) * 100 : 0,
    profitFactor: totals.grossLoss > 0
      ? totals.grossProfit / totals.grossLoss
      : null,
    infinite: totals.grossProfit > 0 && totals.grossLoss === 0,
  }
}

function aggregateDrawdownMetrics(
  metrics: DrawdownTimeMetric[],
  lookbackDays: number,
): DrawdownTimeMetric {
  const episodes = metrics.reduce((sum, metric) => sum + metric.episodes, 0)
  const totalDurationMs = metrics.reduce((sum, metric) => sum + metric.totalDurationMs, 0)
  return {
    lookbackDays,
    samples: metrics.reduce((sum, metric) => sum + metric.samples, 0),
    episodes,
    maxDurationMs: Math.max(0, ...metrics.map((metric) => metric.maxDurationMs)),
    averageDurationMs: episodes > 0 ? Math.round(totalDurationMs / episodes) : 0,
    currentDurationMs: Math.max(0, ...metrics.map((metric) => metric.currentDurationMs)),
    totalDurationMs,
    maxDepth: Math.max(0, ...metrics.map((metric) => metric.maxDepth)),
    currentDepth: Math.max(0, ...metrics.map((metric) => metric.currentDepth)),
    inDrawdown: metrics.some((metric) => metric.inDrawdown),
  }
}

function formatPerformancePf(metric: ProfitFactorMetric | undefined): string {
  if (!metric || metric.trades === 0) return "—"
  if (metric.infinite) return "∞"
  return metric.profitFactor == null ? "—" : metric.profitFactor.toFixed(2)
}

function formatDurationMs(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const remainder = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${remainder}m`
  return `${remainder}m`
}

function formatRecoveryFactor(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "∞"
  if (value === Number.NEGATIVE_INFINITY) return "−∞"
  return Number.isFinite(value) ? value.toFixed(2) : "—"
}

function formatAverageRecoveryFactor(rows: readonly OptimalStrategyMetrics[]): string {
  const values = rows.map((row) => row.riskAdjustedReturn)
  if (values.includes(Number.POSITIVE_INFINITY)) return "∞"
  const finiteValues = values.filter(Number.isFinite)
  return finiteValues.length > 0
    ? formatRecoveryFactor(finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length)
    : "—"
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
  const [positions, setPositions] = useState<TradingPosition[]>([])
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryRow[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [currentStrategyRows, setCurrentStrategyRows] = useState<CurrentStrategyRows | null>(null)
  const [mainIndications, setMainIndications] = useState<MainIndicationSnapshot | null>(null)
  const [runtimeTelemetry, setRuntimeTelemetry] = useState<RuntimeTelemetry | null>(null)
  const [performanceAnalytics, setPerformanceAnalytics] = useState<LiveTradingAnalytics | null>(null)
  const [performanceConnectionCount, setPerformanceConnectionCount] = useState(0)
  const [archiveCoverage, setArchiveCoverage] = useState<StatisticsArchiveCoverage | null>(null)
  const [reloadGeneration, setReloadGeneration] = useState(0)

  // Enhanced analytics state
  const [optimalStrategies, setOptimalStrategies] = useState<OptimalStrategyMetrics[]>([])
  const [coordinationAnalysis, setCoordinationAnalysis] = useState<CoordinationAnalysis[]>([])
  const [comprehensiveAnalytics, setComprehensiveAnalytics] = useState<ComprehensiveAnalytics | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    async function initialize() {
      setIsLoading(true)

      try {
        const url = selectedExchange 
          ? `/api/settings/connections?exchange=${selectedExchange}`
          : "/api/settings/connections"
        
        const response = await fetch(url, { signal: controller.signal })
        const data = await response.json()
        if (cancelled) return
        const inventory = Array.isArray(data?.connections) ? data.connections : []
        const realConnections = inventory.filter((c: any) =>
          c?.id && !String(c.id).startsWith("demo") && c.id !== "demo-mode",
        )
        setHasRealConnections(realConnections.length > 0)

        const settingsResponse = await fetch("/api/settings", { signal: controller.signal })
        if (settingsResponse.ok) {
          const settingsData = await settingsResponse.json()
          if (cancelled) return
          setSettings(settingsData.settings || {})
        }

        if (realConnections.length === 0 || !selectedConnectionId) {
          // Statistics must never invent profitable/loss-making rows on an
          // unconfigured production install. Render an honest zero dataset.
          const engine = new AnalyticsEngine([])
          setPositions([])
          setTradeHistory([])
          setCurrentStrategyRows(null)
          setMainIndications(null)
          setRuntimeTelemetry(null)
          setPerformanceAnalytics(null)
          setPerformanceConnectionCount(0)
          setArchiveCoverage(null)
          setAnalyticsEngine(engine)
          updateAnalytics(engine, filter)
        } else {
          // Merge the live/open position view with the dedicated, exchange-
          // backed closed-trade history. The old page read only active pseudo
          // positions and hard-coded realized_pnl=0, making PnL, PF, win rate,
          // history and time-series wrong even while the dashboard was correct.
          try {
            // Every statistics panel is an active-connection projection. A
            // missing selection must render no data rather than aggregate
            // account ledgers and make a later switch appear contaminated.
            const scopeIds = [selectedConnectionId]

            const responses = await Promise.all(
              scopeIds.map(async (id: string) => {
                const [open, history, archive, progression] = await Promise.all([
                  fetch(`/api/data/positions?connectionId=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
                  fetch(`/api/trading/trade-history?connection_id=${encodeURIComponent(id)}&limit=500`, { cache: "no-store", signal: controller.signal })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
                  fetch(`/api/trading/trade-history?connection_id=${encodeURIComponent(id)}&view=statistics`, { cache: "no-store", signal: controller.signal })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
                  fetch(`/api/connections/progression/${encodeURIComponent(id)}/stats?view=overview`, { cache: "no-store", signal: controller.signal })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
                ])
                return { id, open, history, archive, progression }
              }),
            )
            if (cancelled) return

            const rowSnapshots = responses
              .map((payload) => payload.progression?.strategyRows)
              .filter(Boolean)
            const mainIndicationSnapshots = responses
              .map((payload) => payload.progression?.mainIndications)
              .filter(Boolean) as MainIndicationSnapshot[]
            const runtimeSnapshot = responses
              .map((payload) => payload.progression?.runtime)
              .find(Boolean) as RuntimeTelemetry | undefined
            setRuntimeTelemetry(runtimeSnapshot || null)
            if (rowSnapshots.length > 0) {
              const sum = (path: [string, string]) => rowSnapshots.reduce(
                (total, snapshot) => total + (Number(snapshot?.[path[0]]?.[path[1]]) || 0),
                0,
              )
              const percent = (numerator: number, denominator: number, cap = true) => {
                if (denominator <= 0) return 0
                const value = Math.round((numerator / denominator) * 1000) / 10
                return cap ? Math.min(100, value) : value
              }
              const baseTotal = sum(["base", "total"])
              const baseValid = sum(["base", "valid"])
              const mainValid = sum(["main", "valid"])
              const mainOverall = sum(["main", "overall"])
              const realValid = sum(["real", "valid"])
              const realActive = sum(["real", "active"])
              const liveTotal = sum(["live", "total"])
              const liveMirrored = sum(["live", "mirrored"])
              setCurrentStrategyRows({
                base: {
                  total: baseTotal,
                  valid: baseValid,
                  totalOpen: sum(["base", "totalOpen"]),
                  validOpen: sum(["base", "validOpen"]),
                  validRatio: percent(baseValid, baseTotal),
                },
                main: {
                  valid: mainValid,
                  overall: mainOverall,
                  validOpen: sum(["main", "validOpen"]),
                  overallOpen: sum(["main", "overallOpen"]),
                  overallToValidRatio: percent(mainOverall, mainValid, false),
                },
                real: {
                  valid: realValid,
                  active: realActive,
                  activeExactRows: sum(["real", "activeExactRows"]),
                  activeRatio: percent(realActive, realValid),
                },
                live: {
                  total: liveTotal,
                  mirrored: liveMirrored,
                  active: sum(["live", "active"]),
                  mirroredRatio: percent(liveMirrored, liveTotal),
                },
              })
            } else {
              setCurrentStrategyRows(null)
            }
            if (mainIndicationSnapshots.length > 0) {
              const typeKeys = Array.from(new Set(
                mainIndicationSnapshots.flatMap((snapshot) => Object.keys(snapshot.types || {})),
              ))
              const types = Object.fromEntries(typeKeys.map((key) => {
                const rows = mainIndicationSnapshots
                  .map((snapshot) => snapshot.types?.[key])
                  .filter(Boolean)
                return [key, {
                  label: rows[0]?.label || key,
                  trackings: rows.reduce((sum, row) => sum + (Number(row.trackings) || 0), 0),
                  evaluated: rows.reduce((sum, row) => sum + (Number(row.evaluated) || 0), 0),
                  active: rows.reduce((sum, row) => sum + (Number(row.active) || 0), 0),
                  progressingSets: rows.reduce((sum, row) => sum + (Number(row.progressingSets) || 0), 0),
                }]
              }))
              setMainIndications({
                types,
                totals: Object.values(types).reduce((sum, row) => ({
                  trackings: sum.trackings + row.trackings,
                  evaluated: sum.evaluated + row.evaluated,
                  active: sum.active + row.active,
                  progressingSets: sum.progressingSets + row.progressingSets,
                }), { trackings: 0, evaluated: 0, active: 0, progressingSets: 0 }),
              })
            } else {
              setMainIndications(null)
            }

            const merged: TradingPosition[] = []
            const historyRows: TradeHistoryRow[] = []
            const seen = new Set<string>()

            // Closed rows are authoritative over a stale open-position read.
            // Load the compact full archive first, then add genuinely open IDs.
            for (const payload of responses) {
              if (payload.history?.success && Array.isArray(payload.history.rows)) {
                for (const row of payload.history.rows) {
                  if (row && row.id && row.symbol && (row.direction === "long" || row.direction === "short")) {
                    historyRows.push(row as TradeHistoryRow)
                  }
                }
              }

              const tuples: StatisticsHistoryTupleV1[] =
                payload.archive?.success &&
                payload.archive?.tupleVersion === 1 &&
                Array.isArray(payload.archive.rows)
                  ? payload.archive.rows
                  : Array.isArray(payload.history?.rows)
                    ? payload.history.rows.map((row: TradeHistoryRow) => toStatisticsHistoryTuple(row))
                    : []
              for (const tuple of tuples) {
                if (!Array.isArray(tuple) || tuple.length !== 18 || !tuple[0] || !tuple[1]) continue
                const position = statisticsHistoryTupleToTradingPosition(tuple, payload.id)
                if (seen.has(position.id)) continue
                seen.add(position.id)
                merged.push(position)
              }
            }

            for (const payload of responses) {
              if (!payload.open?.success || !Array.isArray(payload.open.data)) continue
              for (const p of payload.open.data) {
                // Shape payload from /api/data/positions (camelCase) into the
                // snake_case TradingPosition the AnalyticsEngine consumes.
                const id = String(p.id || `${payload.id}:open:${p.symbol || "unknown"}`)
                if (seen.has(id) || p.status === "closed") continue
                seen.add(id)
                const entryPrice = Number(p.entryPrice) || 0
                const currentPrice = Number(p.currentPrice) || 0
                const quantity = Math.abs(Number(p.quantity) || 0)
                const leverage = Number(p.leverage) || 1
                const unrealized = Number(p.unrealizedPnl) || 0
                merged.push({
                  id,
                  connection_id: payload.id,
                  symbol: p.symbol,
                  strategy_type: "real",
                  volume: quantity,
                  entry_price: entryPrice,
                  current_price: currentPrice,
                  takeprofit: p.takeProfitPrice ? Number(p.takeProfitPrice) : undefined,
                  stoploss: p.stopLossPrice ? Number(p.stopLossPrice) : undefined,
                  profit_loss: unrealized,
                  status: "open",
                  opened_at: p.createdAt || new Date().toISOString(),
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

            setPositions(merged)
            setTradeHistory(historyRows)
            const coverages = responses
              .map((payload) => payload.archive?.archive)
              .filter((value): value is StatisticsArchiveCoverage =>
                Boolean(
                  value &&
                  Number.isFinite(Number(value.indexed)) &&
                  Number.isFinite(Number(value.eligibleSnapshots)) &&
                  Number.isFinite(Number(value.normalizedSnapshots)) &&
                  Number.isFinite(Number(value.excludedNonTradeSnapshots)) &&
                  Number.isFinite(Number(value.unresolvedTradeSnapshots)),
                ),
              )
            if (coverages.length === responses.length && coverages.length > 0) {
              setArchiveCoverage({
                indexed: coverages.reduce((sum, value) => sum + value.indexed, 0),
                uniqueIds: coverages.reduce((sum, value) => sum + value.uniqueIds, 0),
                resolvedSnapshots: coverages.reduce((sum, value) => sum + value.resolvedSnapshots, 0),
                eligibleSnapshots: coverages.reduce((sum, value) => sum + value.eligibleSnapshots, 0),
                normalizedSnapshots: coverages.reduce((sum, value) => sum + value.normalizedSnapshots, 0),
                excludedNonTradeSnapshots: coverages.reduce((sum, value) => sum + value.excludedNonTradeSnapshots, 0),
                unresolvedTradeSnapshots: coverages.reduce((sum, value) => sum + value.unresolvedTradeSnapshots, 0),
                normalizedLocalRows: coverages.reduce((sum, value) => sum + value.normalizedLocalRows, 0),
                exchangeOverlays: coverages.reduce((sum, value) => sum + value.exchangeOverlays, 0),
                returned: coverages.reduce((sum, value) => sum + value.returned, 0),
                complete: coverages.every((value) => value.complete),
                capturedAt: Math.max(...coverages.map((value) => value.capturedAt)),
              })
            } else {
              const totalIndexed = responses.reduce(
                (sum, payload) => sum + (Number(payload.history?.paging?.totalIndexed) || 0),
                0,
              )
              setArchiveCoverage({
                indexed: totalIndexed,
                uniqueIds: totalIndexed,
                resolvedSnapshots: historyRows.length,
                eligibleSnapshots: totalIndexed,
                normalizedSnapshots: historyRows.length,
                excludedNonTradeSnapshots: 0,
                unresolvedTradeSnapshots: Math.max(0, totalIndexed - historyRows.length),
                normalizedLocalRows: historyRows.length,
                exchangeOverlays: 0,
                returned: historyRows.length,
                complete: false,
                capturedAt: Date.now(),
              })
            }
            const connectionAnalytics = responses
              .map((payload) => payload.history?.analytics)
              .filter((value): value is LiveTradingAnalytics =>
                Boolean(
                  value?.timeWindows?.["4h"] &&
                  value?.positionWindows?.["12"] &&
                  value?.drawdown3d,
                ),
              )
            if (connectionAnalytics.length === 1) {
              setPerformanceAnalytics(connectionAnalytics[0])
              setPerformanceConnectionCount(1)
            } else if (connectionAnalytics.length > 1) {
              // Position-count windows are selected from the merged newest
              // 500 rows per connection. That is sufficient for an exact
              // portfolio newest-75 selection. Time windows use additive
              // per-connection archive metrics so high turnover is never
              // truncated by the table ring.
              const visibleAggregate = buildLiveTradingAnalytics(historyRows)
              setPerformanceAnalytics({
                ...visibleAggregate,
                generatedAt: Math.max(...connectionAnalytics.map((item) => item.generatedAt)),
                timeWindows: {
                  "4h": aggregateProfitFactorMetrics(
                    connectionAnalytics.map((item) => item.timeWindows["4h"]),
                  ),
                  "12h": aggregateProfitFactorMetrics(
                    connectionAnalytics.map((item) => item.timeWindows["12h"]),
                  ),
                  "48h": aggregateProfitFactorMetrics(
                    connectionAnalytics.map((item) => item.timeWindows["48h"]),
                  ),
                },
                orderWindows: {
                  "4h": connectionAnalytics.reduce((sum, item) => sum + item.orderWindows["4h"], 0),
                  "24h": connectionAnalytics.reduce((sum, item) => sum + item.orderWindows["24h"], 0),
                  "48h": connectionAnalytics.reduce((sum, item) => sum + item.orderWindows["48h"], 0),
                },
                drawdown3d: aggregateDrawdownMetrics(
                  connectionAnalytics.map((item) => item.drawdown3d),
                  3,
                ),
              })
              setPerformanceConnectionCount(connectionAnalytics.length)
            } else {
              setPerformanceAnalytics(historyRows.length > 0
                ? buildLiveTradingAnalytics(historyRows)
                : null)
              setPerformanceConnectionCount(historyRows.length > 0 ? scopeIds.length : 0)
            }
            const engine = new AnalyticsEngine(merged)
            setAnalyticsEngine(engine)
            updateAnalytics(engine, filter)
          } catch (err) {
            if (cancelled) return
            console.error("[v0] [Statistics] Failed to load real positions:", err)
            const engine = new AnalyticsEngine([])
            setPositions([])
            setTradeHistory([])
            setCurrentStrategyRows(null)
            setMainIndications(null)
            setPerformanceAnalytics(null)
            setPerformanceConnectionCount(0)
            setRuntimeTelemetry(null)
            setArchiveCoverage(null)
            setAnalyticsEngine(engine)
            updateAnalytics(engine, filter)
          }
        }
      } catch (error) {
        if (cancelled) return
        console.error("Failed to check connections:", error)
        const engine = new AnalyticsEngine([])
        setHasRealConnections(false)
        setPositions([])
        setTradeHistory([])
        setCurrentStrategyRows(null)
        setMainIndications(null)
        setPerformanceAnalytics(null)
        setPerformanceConnectionCount(0)
        setRuntimeTelemetry(null)
        setArchiveCoverage(null)
        setAnalyticsEngine(engine)
        updateAnalytics(engine, filter)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void initialize()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedExchange, selectedConnectionId, reloadGeneration])

  // Runtime resource/latency values are intentionally independent from the
  // heavier statistics rebuild. Keep the visible Overview card fresh every
  // three seconds without replacing positions, history or PF rows mid-render.
  useEffect(() => {
    if (!selectedConnectionId) return
    let cancelled = false
    let inFlight = false
    const controller = new AbortController()
    const refreshRuntime = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const response = await fetch(
          `/api/connections/progression/${encodeURIComponent(selectedConnectionId)}/stats?view=runtime`,
          { cache: "no-store", signal: controller.signal },
        )
        if (!response.ok) return
        const payload = await response.json().catch(() => null)
        if (!cancelled) setRuntimeTelemetry((payload?.runtime as RuntimeTelemetry | undefined) || null)
      } catch {
        // A telemetry miss must not clear the last good Overview sample.
      } finally {
        inFlight = false
      }
    }
    void refreshRuntime()
    const interval = window.setInterval(() => void refreshRuntime(), 3_000)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
    }
  }, [selectedConnectionId])

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
    const optimalStrategies = calculateOptimalStrategies(strategies)

    // Analyze coordination between different strategy types and methods
    const coordinationAnalysis = calculateCoordinationAnalysis(strategies, symbols, timeSeries)

    // Market condition insights
    const pnlRegimeInsights = calculatePnlRegimeInsights(timeSeries)

    // Risk metrics
    const riskMetrics = calculateRiskMetrics(strategies, symbols, timeSeries)

    return {
      optimalStrategies,
      coordinationAnalysis,
      pnlRegimeInsights,
      riskMetrics,
    }
  }

  const calculateOptimalStrategies = (strategies: StrategyAnalytics[]): OptimalStrategyMetrics[] => {
    const bounded01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
    const adjustmentOf = (name: string) => {
      const normalized = name.toLowerCase()
      const adjustments = ["block", "dca", "trailing"].filter((value) => normalized.includes(value))
      return adjustments.length > 0 ? adjustments.join("+") : "none"
    }

    // Rank only observed strategy rows. The previous implementation expanded
    // every row into hypothetical direct/preset/coordinated combinations and
    // displayed those duplicates as measured results. No such coordination
    // series exists in this data source, so it must never be invented.
    return strategies.map((strategy) => {
      const realizedPf = Number(strategy.profit_factor) || 0
      const drawdownHours = Math.max(0, Number(strategy.drawdown_time) || 0)
      const totalTrades = Math.max(0, Math.floor(Number(strategy.total_trades) || 0))
      const confidence = bounded01(totalTrades / 100)
      const pfScore = bounded01(realizedPf - 1)
      const winRateScore = bounded01(Number(strategy.win_rate) || 0)
      const drawdownDurationScore = 1 / (1 + drawdownHours / 24)
      const measuredQualityScore =
        pfScore * 0.4 +
        winRateScore * 0.25 +
        drawdownDurationScore * 0.2 +
        confidence * 0.15

      return {
        strategyName: strategy.strategy_name,
        strategyType: strategy.strategy_type,
        adjustmentType: adjustmentOf(strategy.strategy_name),
        coordinationMethod: "measured",
        optimalScore: measuredQualityScore,
        confidence,
        totalTrades,
        // AnalyticsEngine's recovery_factor is realised net P&L divided by
        // maximum USD drawdown. It is dimensionless, but it is not a percent.
        riskAdjustedReturn: Number(strategy.recovery_factor) || 0,
        maxDrawdown: drawdownHours,
        winRate: Number(strategy.win_rate) || 0,
        profitFactor: realizedPf,
        sharpeRatio: Number(strategy.sharpe_ratio) || 0,
        recommendations: generateRecommendations(realizedPf, strategy.win_rate, drawdownHours, totalTrades),
      }
    }).sort((left, right) =>
      right.optimalScore - left.optimalScore ||
      right.totalTrades - left.totalTrades ||
      left.strategyName.localeCompare(right.strategyName),
    )
  }

  const calculateCoordinationAnalysis = (
    strategies: StrategyAnalytics[],
    symbols: SymbolAnalytics[],
    timeSeries: TimeSeriesData[]
  ): CoordinationAnalysis[] => {
    // Aggregate strategy rows do not contain aligned per-period outcome pairs.
    // Correlation, synergy and risk reduction cannot be reconstructed from two
    // unrelated arrays of average PF values. Keep this surface explicitly
    // unavailable until a paired coordination ledger is supplied.
    void strategies
    void symbols
    void timeSeries
    return []
  }

  const calculatePnlRegimeInsights = (timeSeries: TimeSeriesData[]) => {
    const regimes = [
      { condition: "Positive P&L days", rows: timeSeries.filter((row) => row.daily_pnl > 0) },
      { condition: "Negative P&L days", rows: timeSeries.filter((row) => row.daily_pnl < 0) },
      { condition: "Flat P&L days", rows: timeSeries.filter((row) => row.daily_pnl === 0) },
    ]
    return regimes.map(({ condition, rows }) => {
      const totalPnlUsd = rows.reduce((sum, row) => sum + row.daily_pnl, 0)
      return {
        condition,
        periodCount: rows.length,
        averagePnlUsd: safeAvg(totalPnlUsd, rows.length),
        totalPnlUsd,
      }
    })
  }

  const calculateRiskMetrics = (strategies: StrategyAnalytics[], symbols: SymbolAnalytics[], timeSeries: TimeSeriesData[]) => {
    void strategies
    void symbols
    const dailyPnl = timeSeries
      .map((row) => Number(row.daily_pnl))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)
    if (dailyPnl.length === 0) {
      return {
        sampleCount: 0,
        historicalLossQuantile95Usd: null,
        expectedShortfallUsd: null,
      }
    }
    const quantileIndex = Math.max(0, Math.ceil(dailyPnl.length * 0.05) - 1)
    const tail = dailyPnl.slice(0, quantileIndex + 1)
    const quantilePnl = dailyPnl[quantileIndex]
    return {
      sampleCount: dailyPnl.length,
      historicalLossQuantile95Usd: Math.max(0, -quantilePnl),
      expectedShortfallUsd: Math.max(0, -safeAvg(tail.reduce((sum, value) => sum + value, 0), tail.length)),
    }
  }

  const generateRecommendations = (profitFactor: number, winRate: number, maxDrawdown: number, totalTrades: number): string[] => {
    const recommendations: string[] = []

    if (profitFactor > 1.5) {
      recommendations.push("Realised PF is above 1.50 in the selected sample")
    } else if (profitFactor < 1.1) {
      recommendations.push("Realised PF is below 1.10; inspect the closed-trade sample")
    }

    if (winRate > 0.7) {
      recommendations.push("Observed win rate is above 70%")
    } else if (winRate < 0.4) {
      recommendations.push("Observed win rate is below 40%")
    }

    if (maxDrawdown > 24) {
      recommendations.push("Measured drawdown duration exceeds 24 hours")
    } else if (maxDrawdown > 0 && maxDrawdown <= 4) {
      recommendations.push("Measured drawdown duration is at most 4 hours")
    }

    if (totalTrades < 100) {
      recommendations.push("Fewer than 100 closed trades; confidence remains limited")
    }

    return recommendations
  }

  const handleFilterChange = (newFilter: AnalyticsFilter) => {
    setFilter(newFilter)
    if (analyticsEngine) {
      updateAnalytics(analyticsEngine, newFilter)
    }
  }

  const selectedTopTimeRange = useMemo(() => {
    const startMs = filter.timeRange.start.getTime()
    const endMs = filter.timeRange.end.getTime()
    if (startMs <= 0) return "all"
    const durationMs = Math.max(0, endMs - startMs)
    return TOP_TIME_RANGES.find((option) =>
      option.durationMs !== null && Math.abs(option.durationMs - durationMs) < 60_000,
    )?.value || "custom"
  }, [filter.timeRange.end, filter.timeRange.start])

  const applyTopTimeRange = (value: string) => {
    if (value === "custom") return
    const now = new Date()
    const option = TOP_TIME_RANGES.find((candidate) => candidate.value === value)
    if (!option) return
    handleFilterChange({
      ...filter,
      timeRange: {
        start: new Date(option.durationMs === null ? 0 : now.getTime() - option.durationMs),
        end: now,
      },
    })
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  const COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4"]

  // Safe average — guards against divide-by-zero (NaN) when a dataset is empty.
  const safeAvg = (sum: number, count: number): number => (count > 0 ? sum / count : 0)

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
  const availableFilters = useMemo(() => {
    const uniqueSorted = (values: string[]) => [...new Set(values.filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
    return {
      symbols: uniqueSorted(positions.map((position) => String(position.symbol || "").toUpperCase())),
      indicationTypes: uniqueSorted(positions.map((position) => String(position.indication_type || "direction").toLowerCase())),
      strategyTypes: uniqueSorted(positions.map((position) => String(position.strategy_type || "live"))),
    }
  }, [positions])
  const positionsInSelectedTimeRange = useMemo(() => {
    const startMs = filter.timeRange.start.getTime()
    const endMs = filter.timeRange.end.getTime()
    return positions.filter((position) => {
      const timestamp = Date.parse(String(position.closed_at || position.opened_at || ""))
      return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs
    })
  }, [filter.timeRange.end, filter.timeRange.start, positions])
  const tradeHistoryInSelectedTimeRange = useMemo(() => {
    const startMs = filter.timeRange.start.getTime()
    const endMs = filter.timeRange.end.getTime()
    return tradeHistory.filter((trade) => {
      const timestamp = Number(trade.closedAt || 0)
      return timestamp >= startMs && timestamp <= endMs
    })
  }, [filter.timeRange.end, filter.timeRange.start, tradeHistory])

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <StatisticsSectionNav />
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="text-center space-y-3">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary mx-auto"></div>
            <div className="text-sm text-muted-foreground">Loading statistics&hellip;</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-4 p-3 sm:p-4">
      <StatisticsSectionNav />
      {!hasRealConnections && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs font-semibold text-foreground">No exchange data yet</div>
              <div className="text-xs text-muted-foreground">
                No exchange connection is configured. Statistics remain at honest zero values until a connection produces positions or trades.
              </div>
            </div>
          </div>
        </div>
      )}
      {hasRealConnections && !selectedConnectionId && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs font-semibold text-foreground">Select an active connection</div>
              <div className="text-xs text-muted-foreground">
                Statistics stay empty until a specific exchange connection is selected.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <PageHeader
          title="Advanced Statistics & Analytics"
          description="Measured exchange performance, classic realised PF, PositionCost coordinates and runtime diagnostics"
        />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select value={selectedTopTimeRange} onValueChange={applyTopTimeRange}>
            <SelectTrigger size="sm" className="h-8 min-w-44 bg-background" aria-label="Statistics time range">
              <SelectValue placeholder="Select time range" />
            </SelectTrigger>
            <SelectContent>
              {selectedTopTimeRange === "custom" && (
                <SelectItem value="custom">Custom range</SelectItem>
              )}
              {TOP_TIME_RANGES.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {archiveCoverage && (
            <Badge
              variant={archiveCoverage.complete ? "outline" : "destructive"}
              className="h-7 gap-1 tabular-nums"
              title={
                archiveCoverage.complete
                  ? `${archiveCoverage.resolvedSnapshots.toLocaleString()} of ${archiveCoverage.uniqueIds.toLocaleString()} indexed snapshot IDs resolved; all ${archiveCoverage.eligibleSnapshots.toLocaleString()} eligible executed trades normalized; ${archiveCoverage.excludedNonTradeSnapshots.toLocaleString()} non-trade lifecycle rows excluded; ${archiveCoverage.normalizedLocalRows.toLocaleString()} rows match the selected environment.`
                  : `${archiveCoverage.resolvedSnapshots.toLocaleString()} of ${archiveCoverage.uniqueIds.toLocaleString()} indexed snapshot IDs resolved; ${archiveCoverage.normalizedSnapshots.toLocaleString()} of ${archiveCoverage.eligibleSnapshots.toLocaleString()} eligible executed trades normalized; ${archiveCoverage.unresolvedTradeSnapshots.toLocaleString()} remain unresolved. Statistics are in bounded fallback mode.`
              }
            >
              <History className="h-3 w-3" />
              {archiveCoverage.complete ? "Full archive" : "Partial archive"}
              {" · "}{archiveCoverage.returned.toLocaleString()} rows
            </Badge>
          )}
          <Badge variant="secondary" className="h-7 gap-1">
            <Brain className="h-3 w-3" />
            Measured Analysis
          </Badge>
          <Button
            onClick={() => {
              if (analyticsEngine) updateAnalytics(analyticsEngine, filter)
              setReloadGeneration((generation) => generation + 1)
            }}
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
          { icon: Award,        label: "Highest PF",  value: overviewStats.bestStrategy, tint: "text-primary", isWide: true },
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Measured Profit Factor &amp; Drawdown Time</CardTitle>
          <CardDescription>
            Gross-profit ÷ gross-loss PF from closed positions. Time windows use
            the complete indexed archive; latest-position windows are globally
            ordered across the selected scope.
            {performanceConnectionCount > 1
              ? " DDT shows the longest connection-level drawdown in the selected portfolio."
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {performanceAnalytics ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["12", "25", "75"] as const).map((window) => {
                  const metric = performanceAnalytics.positionWindows[window]
                  return (
                    <div key={`positions-${window}`} className="rounded-lg border bg-muted/10 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Last {window} positions
                      </div>
                      <div className="mt-1 text-xl font-bold tabular-nums">
                        PF {formatPerformancePf(metric)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {metric.trades} closes · {metric.wins}W / {metric.losses}L
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {(["4h", "12h", "48h"] as const).map((window) => {
                  const metric = performanceAnalytics.timeWindows[window]
                  return (
                    <div key={`hours-${window}`} className="rounded-lg border bg-muted/10 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Last {window}
                      </div>
                      <div className="mt-1 text-xl font-bold tabular-nums">
                        PF {formatPerformancePf(metric)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {metric.trades} closes · {metric.wins}W / {metric.losses}L
                      </div>
                    </div>
                  )
                })}
                <div className="rounded-lg border bg-muted/10 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    DDT · last 3 days
                  </div>
                  <div className="mt-1 text-xl font-bold tabular-nums">
                    {formatDurationMs(
                      performanceAnalytics.drawdown3d.currentDurationMs ||
                      performanceAnalytics.drawdown3d.maxDurationMs,
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {performanceAnalytics.drawdown3d.inDrawdown ? "Active" : "Recovered"} ·{" "}
                    {performanceAnalytics.drawdown3d.episodes} episodes ·{" "}
                    max {formatDurationMs(performanceAnalytics.drawdown3d.maxDurationMs)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              No closed-position PF/DDT samples are available for the selected scope.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Main Trade Engine · Indications</CardTitle>
          <CardDescription>
            Complete per-type Main indication snapshot from the current engine cycle. Trackings are cumulative; evaluated, active and progressing Sets are current-cycle values.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mainIndications ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Trackings", mainIndications.totals.trackings],
                  ["Evaluated", mainIndications.totals.evaluated],
                  ["Active", mainIndications.totals.active],
                  ["Progressing Sets", mainIndications.totals.progressingSets],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border bg-muted/10 p-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
                    <div className="mt-1 text-lg font-bold tabular-nums">{Number(value).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Indication</th>
                      <th className="px-3 py-2 text-right font-medium">Trackings</th>
                      <th className="px-3 py-2 text-right font-medium">Evaluated</th>
                      <th className="px-3 py-2 text-right font-medium">Active</th>
                      <th className="px-3 py-2 text-right font-medium">Sets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(mainIndications.types).map(([key, row]) => (
                      <tr key={key} className="border-t">
                        <td className="px-3 py-2 font-medium">{row.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.trackings.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.evaluated.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.active.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.progressingSets.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No current Main indication snapshot is available for the selected connection.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Current Strategy Row Snapshot</CardTitle>
          <CardDescription>
            Fresh open-ledger semantics shared with ConnectionCard, Logistics and info dialogs.
            Main Overall includes valid Pos-Count, Block and DCA descendants and may exceed 100%.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {currentStrategyRows ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  stage: "Base",
                  primary: `${currentStrategyRows.base.total.toLocaleString()} Total`,
                  secondary: `${currentStrategyRows.base.valid.toLocaleString()} Valid`,
                  detail: `${currentStrategyRows.base.validRatio.toFixed(1)}% · ${currentStrategyRows.base.totalOpen.toLocaleString()} open`,
                },
                {
                  stage: "Main",
                  primary: `${currentStrategyRows.main.valid.toLocaleString()} Valid`,
                  secondary: `${currentStrategyRows.main.overall.toLocaleString()} Overall`,
                  detail: `${currentStrategyRows.main.overallToValidRatio.toFixed(1)}% · ${currentStrategyRows.main.overallOpen.toLocaleString()} open`,
                },
                {
                  stage: "Real",
                  primary: `${currentStrategyRows.real.valid.toLocaleString()} Valid`,
                  secondary: `${currentStrategyRows.real.active.toLocaleString()} Active`,
                  detail: `${currentStrategyRows.real.activeRatio.toFixed(1)}% · ${currentStrategyRows.real.activeExactRows.toLocaleString()} exact rows`,
                },
                {
                  stage: "Live",
                  primary: `${currentStrategyRows.live.total.toLocaleString()} Rows`,
                  secondary: `${currentStrategyRows.live.mirrored.toLocaleString()} Mirrored`,
                  detail: `${currentStrategyRows.live.mirroredRatio.toFixed(1)}% · ${currentStrategyRows.live.active.toLocaleString()} active`,
                },
              ].map((row) => (
                <div key={row.stage} className="rounded-lg border bg-muted/10 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{row.stage}</div>
                  <div className="mt-1 text-sm font-semibold">{row.primary}</div>
                  <div className="text-sm text-primary">{row.secondary}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{row.detail}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No fresh stage-row snapshot is available for the selected connection scope.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            Runtime &amp; Processing Coordination
          </CardTitle>
          <CardDescription>
            Measured from the authoritative engine owner. These diagnostics describe scheduling and responsiveness; they do not alter PF, stage eligibility or order decisions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runtimeTelemetry ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border bg-muted/10 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">CPU / lanes</div>
                <div className="mt-1 text-sm font-semibold tabular-nums">
                  {runtimeTelemetry.concurrency?.cpuCount || 0} CPUs · {runtimeTelemetry.concurrency?.symbolConcurrency || 0} symbols
                </div>
                <div className="text-[10px] text-muted-foreground">
                  calc {runtimeTelemetry.concurrency?.calculationConcurrency || 0} · types {runtimeTelemetry.concurrency?.indicationTypeConcurrency || 0} · I/O {runtimeTelemetry.concurrency?.ioConcurrency || 0}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/10 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Event loop</div>
                <div className="mt-1 text-sm font-semibold tabular-nums">
                  {Number(runtimeTelemetry.eventLoop?.utilizationPct || 0).toFixed(1)}% utilized
                </div>
                <div className="text-[10px] text-muted-foreground">
                  p95 delay {Number(runtimeTelemetry.eventLoop?.delayP95Ms || 0).toFixed(1)}ms · max {Number(runtimeTelemetry.eventLoop?.delayMaxMs || 0).toFixed(1)}ms
                </div>
              </div>
              <div className="rounded-lg border bg-muted/10 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Memory</div>
                <div className="mt-1 text-sm font-semibold tabular-nums">
                  {Number(runtimeTelemetry.memory?.rssMB || 0).toFixed(1)} MB RSS
                </div>
                <div className="text-[10px] text-muted-foreground">
                  heap {Number(runtimeTelemetry.memory?.heapUsedMB || 0).toFixed(1)} / {Number(runtimeTelemetry.memory?.heapTotalMB || 0).toFixed(1)} MB
                </div>
              </div>
              <div className="rounded-lg border bg-muted/10 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Load / source</div>
                <div className="mt-1 text-sm font-semibold tabular-nums">
                  load {Number(runtimeTelemetry.concurrency?.load1m || 0).toFixed(2)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {runtimeTelemetry.concurrency?.cpuSource || "unknown"} · captured {runtimeTelemetry.capturedAt ? new Date(runtimeTelemetry.capturedAt).toLocaleTimeString() : "—"}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No runtime telemetry is available for the selected connection scope.</div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1">
          <AnalyticsFilters
            filter={filter}
            onFilterChange={handleFilterChange}
            availableSymbols={availableFilters.symbols}
            availableIndicationTypes={availableFilters.indicationTypes}
            availableStrategyTypes={availableFilters.strategyTypes}
          />
        </div>

        <div className="lg:col-span-3">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
              <TabsTrigger value="overview" className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="optimal" className="flex items-center gap-2">
                <Target className="h-4 w-4" />
                Ranking
              </TabsTrigger>
              <TabsTrigger value="strategies" className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Strategies
              </TabsTrigger>
              <TabsTrigger value="symbols" className="flex items-center gap-2">
                <Star className="h-4 w-4" />
                Symbols
              </TabsTrigger>
              <TabsTrigger value="charts" className="flex items-center gap-2">
                <LineChartIcon className="h-4 w-4" />
                Charts
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
              <TabsTrigger value="history" className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                History
              </TabsTrigger>
            </TabsList>

            <TabsContent value="optimal" className="space-y-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold">Measured Strategy Ranking</h3>
                  <p className="text-sm text-muted-foreground">Observed closed-trade rows only; no hypothetical strategy or coordination combinations</p>
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
                        <div className="text-sm text-muted-foreground">Quality score ≥ 80%</div>
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
                          {formatAverageRecoveryFactor(optimalStrategies)}
                        </div>
                        <div className="text-sm text-muted-foreground">Avg Recovery Factor</div>
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
                          {optimalStrategies[0]?.strategyName || 'N/A'}
                        </div>
                        <div className="text-sm text-muted-foreground">Top Measured Strategy</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Optimal Strategies Table */}
              <Card>
                <CardHeader>
                  <CardTitle>Measured strategy quality rows</CardTitle>
                  <CardDescription>
                    Deterministic score: 40% clipped(PF−1), 25% win rate, 20% 1/(1+DDT/24h), and 15% sample confidence capped at 100 closes.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {optimalStrategies.slice(0, 10).map((strategy, index) => (
                      <div key={strategy.strategyName}
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
                                {strategy.strategyName}
                              </h4>
                              <p className="text-sm text-muted-foreground">
                                {strategy.strategyType} · {strategy.adjustmentType} · {strategy.totalTrades} closed trades
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-lg font-bold text-green-600">
                              {(strategy.optimalScore * 100).toFixed(1)}%
                            </div>
                            <div className="text-sm text-muted-foreground">Measured quality</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                          <div>
                            <div className="text-sm text-muted-foreground">Realised PF (classic)</div>
                            <div className="font-semibold">{strategy.profitFactor >= 999 ? "∞" : strategy.profitFactor.toFixed(2)}</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Win Rate</div>
                            <div className="font-semibold">{(strategy.winRate * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Drawdown duration</div>
                            <div className="font-semibold">{strategy.maxDrawdown.toFixed(1)}h</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Recovery factor</div>
                            <div className="font-semibold">{formatRecoveryFactor(strategy.riskAdjustedReturn)}</div>
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
                            <div className="text-sm font-medium mb-2">Measured observations:</div>
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
                  <CardTitle>Realised PF vs. drawdown duration</CardTitle>
                  <CardDescription>
                    Each finite point is one observed strategy row; x is DDT in hours and y is classic realised PF. Loss-free infinite PF rows are listed above and omitted from this finite axis.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={400}>
                    <ScatterChart data={optimalStrategies.filter((strategy) => strategy.profitFactor < 999)}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        dataKey="maxDrawdown"
                        domain={[0, 'dataMax']}
                        tickFormatter={(value) => `${Number(value).toFixed(0)}h`}
                        label={{ value: 'Drawdown duration (h)', position: 'insideBottom', offset: -5 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="profitFactor"
                        tickFormatter={(value) => Number(value).toFixed(2)}
                        label={{ value: 'Realised PF (classic)', angle: -90, position: 'insideLeft' }}
                      />
                      <Tooltip
                        formatter={(value: number, name: string) => [
                          name === 'maxDrawdown' ? `${value.toFixed(1)}h` : value.toFixed(2),
                          name === 'maxDrawdown' ? 'Drawdown duration' : 'Realised PF (classic)'
                        ]}
                      />
                      <Scatter
                        name="Strategies"
                        dataKey="profitFactor"
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
                  <h3 className="text-lg font-semibold">Paired Strategy Coordination</h3>
                  <p className="text-sm text-muted-foreground">Requires time-aligned outcome pairs; aggregate PF rows are not treated as correlation data</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="flex items-center gap-1">
                    <Network className="h-3 w-3" />
                    {coordinationAnalysis.length} measured pairs
                  </Badge>
                </div>
              </div>

              {coordinationAnalysis.length === 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>No paired coordination ledger is available</CardTitle>
                    <CardDescription>
                      Correlation, synergy and risk reduction remain intentionally unavailable
                      instead of being inferred from unrelated average PF rows.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}

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
                        <div className="text-sm text-muted-foreground">Highest classic PF</div>
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
                    Realised and unrealised P&amp;L plus realised USD drawdown relative to a zero baseline; no account-balance estimate
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={350}>
                    <ComposedChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleDateString()} />
                      <YAxis yAxisId="price" orientation="left" tickFormatter={(value) => formatCurrency(value)} />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: number, name: string) => {
                          if (name === 'Realised drawdown') return [formatCurrency(value), name]
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
                        name="Realized P&L"
                      />
                      <Area
                        yAxisId="price"
                        type="monotone"
                        dataKey="equity"
                        stackId="2"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.3}
                        name="P&L + Unrealized"
                      />
                      <Line
                        yAxisId="price"
                        type="monotone"
                        dataKey="drawdown"
                        stroke="#ef4444"
                        strokeWidth={2}
                        name="Realised drawdown"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Exact P&L sign regimes; no market regime is inferred from P&L. */}
              {comprehensiveAnalytics?.pnlRegimeInsights && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Brain className="h-5 w-5" />
                      Measured daily P&amp;L regimes
                    </CardTitle>
                    <CardDescription>
                      Exact positive, negative and flat daily aggregates. These rows do not claim to identify volatility, trend or range conditions.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {comprehensiveAnalytics.pnlRegimeInsights.map((condition, index) => (
                        <div key={condition.condition} className="border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold">{condition.condition}</h4>
                            <Badge variant={index === 0 ? "default" : "secondary"}>
                              {condition.periodCount} periods
                            </Badge>
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Average P&amp;L:</span>
                              <span className={`font-medium ${condition.averagePnlUsd >= 0 ? "text-green-600" : "text-red-600"}`}>
                                {formatCurrency(condition.averagePnlUsd)}
                              </span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Total P&amp;L:</span>
                              <span className={`font-medium ${condition.totalPnlUsd >= 0 ? "text-green-600" : "text-red-600"}`}>
                                {formatCurrency(condition.totalPnlUsd)}
                              </span>
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
                      Observed classic realised PF and win rate by strategy type. Loss-free infinite PF rows are omitted from the finite PF bars.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={strategyAnalytics.slice(0, 8).map((strategy) => ({
                        ...strategy,
                        finite_profit_factor: strategy.profit_factor >= 999 ? null : strategy.profit_factor,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="strategy_type" />
                        <YAxis yAxisId="pf" />
                        <YAxis
                          yAxisId="win-rate"
                          orientation="right"
                          domain={[0, 1]}
                          tickFormatter={(value) => `${(Number(value) * 100).toFixed(0)}%`}
                        />
                        <Tooltip
                          formatter={(value: number, name: string) => {
                            if (name === 'finite_profit_factor') return [value.toFixed(2), 'Realised PF (classic)']
                            if (name === 'win_rate') return [`${(value * 100).toFixed(1)}%`, 'Win Rate']
                            return [value, name]
                          }}
                        />
                        <Bar yAxisId="pf" dataKey="finite_profit_factor" fill="#3b82f6" name="Realised PF (classic)" />
                        <Bar yAxisId="win-rate" dataKey="win_rate" fill="#10b981" name="Win Rate" />
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
                      Closed-trade count share across the highest-P&amp;L symbols
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
                      Measured risk statistics
                    </CardTitle>
                    <CardDescription>
                      Historical daily P&amp;L loss distribution, drawdown duration and observed strategy metrics; no forecast, beta or stress test is inferred.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-red-600">
                          {comprehensiveAnalytics.riskMetrics.historicalLossQuantile95Usd === null
                            ? "—"
                            : formatCurrency(comprehensiveAnalytics.riskMetrics.historicalLossQuantile95Usd)}
                        </div>
                        <div className="text-sm text-muted-foreground">Historical loss q95</div>
                        <div className="text-xs text-muted-foreground mt-1">{comprehensiveAnalytics.riskMetrics.sampleCount} daily samples · USD</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-yellow-600">
                          {comprehensiveAnalytics.riskMetrics.expectedShortfallUsd === null
                            ? "—"
                            : formatCurrency(comprehensiveAnalytics.riskMetrics.expectedShortfallUsd)}
                        </div>
                        <div className="text-sm text-muted-foreground">Historical tail mean</div>
                        <div className="text-xs text-muted-foreground mt-1">Worst 5% daily P&amp;L · USD</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-orange-600">
                          {safeAvg(strategyAnalytics.reduce((sum, s) => sum + (s.drawdown_time || 0), 0), strategyAnalytics.length).toFixed(1)}h
                        </div>
                        <div className="text-sm text-muted-foreground">Avg DDT</div>
                        <div className="text-xs text-muted-foreground mt-1">Measured duration, not percent</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-blue-600">
                          {strategyAnalytics.filter(s => s.profit_factor > 1).length}
                        </div>
                        <div className="text-sm text-muted-foreground">Classic-PF winners</div>
                        <div className="text-xs text-muted-foreground mt-1">Realised PF &gt; 1.00</div>
                      </div>

                      <div className="text-center p-4 border rounded-lg">
                        <div className="text-2xl font-bold text-green-600">
                           {(safeAvg(optimalStrategies.reduce((sum, s) => sum + s.sharpeRatio, 0), optimalStrategies.length)).toFixed(2)}
                        </div>
                        <div className="text-sm text-muted-foreground">Avg observed Sharpe</div>
                        <div className="text-xs text-muted-foreground mt-1">Closed-trade samples</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="strategies" className="space-y-6">
              <StrategyPerformanceTable strategies={strategyAnalytics} />
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
                    <CardDescription>End-of-day lifecycle count from observed open/close timestamps in the selected filter window.</CardDescription>
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
              <PresetTradeStats
                filter={filter}
                positions={positionsInSelectedTimeRange}
                connectionId={selectedConnectionId}
              />
            </TabsContent>

            <TabsContent value="adjust" className="space-y-6">
              <AdjustStrategyStats
                positions={positionsInSelectedTimeRange
                  .filter((p) => p.status === "closed")
                  .map(toStatisticsPseudoPosition)}
                timeIntervals={[4, 12, 24, 48]}
                drawdownPositionCount={80}
              />
            </TabsContent>

            <TabsContent value="block" className="space-y-6">
              <BlockStrategyStats
                positions={positionsInSelectedTimeRange
                  .filter((p) => p.status === "closed")
                  .map(toStatisticsPseudoPosition)}
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

            <TabsContent value="history" className="space-y-4">
              <TradeHistoryTable
                trades={tradeHistoryInSelectedTimeRange}
                visibleWindow={50}
                onRefresh={() => setReloadGeneration((generation) => generation + 1)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
