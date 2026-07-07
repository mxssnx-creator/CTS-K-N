"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FileText, ChevronDown, ChevronRight, Activity, TrendingUp, Database, Clock, RefreshCw, Layers, BarChart3, History, GitBranch } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

interface LogEntry {
  id: string
  timestamp: string
  type: "indication" | "strategy" | "position" | "live" | "engine" | "error"
  symbol?: string
  phase?: string
  message: string
  details?: {
    timeframe?: string
    timeRange?: string
    calculatedIndicators?: number
    evaluatedStrategies?: number
    pseudoPositions?: {
      base: number
      main: number
      real: number
    }
    configs?: number
    evals?: number
    ratios?: {
      last25: number
      last50: number
      maxPos: number
    }
    cycleDuration?: number
    cycleCount?: number
  }
  expanded?: boolean
}

interface ProgressSummary {
  symbolsActive: number
  indicationCycles: number
  strategyCycles: number
  totalIndicationsCalculated: number
  totalStrategiesEvaluated: number
  pseudoPositions: {
    base: number
    main: number
    real: number
    total: number
  }
  // Extended stats
  prehistoricSymbols: number
  prehistoricDataSize: number
  intervalsProcessed: number
  indicationsByType: {
    direction: number
    move: number
    active: number
    optimal: number
    auto: number
    total: number
  }
  strategyCountsByType?: {
    base: number
    main: number
    real: number
  }
  strategyEvaluatedByType?: {
    base: number
    main: number
    real: number
  }
  strategyPassedByType?: {
    base: number
    main: number
    real: number
  }
  pseudoPositionsByType: {
    baseByIndication: {
      direction: number
      move: number
      active: number
      optimal: number
    }
  }
  livePositions: number
  // Live Exchange execution — aggregated from progression counters (no exchange history call)
  liveExecution?: {
    ordersPlaced: number
    ordersFilled: number
    ordersFailed: number
    ordersRejected: number
    ordersSimulated: number
    positionsCreated: number
    positionsClosed: number
    positionsOpen: number
    wins: number
    /** Cumulative leveraged notional (qty × price). Legacy field. */
    volumeUsdTotal: number
    /** Cumulative used balance (margin). Preferred USDT figure. */
    marginUsdTotal?: number
    fillRate: number
    winRate: number
  }
  cycleDurationMs: number
  realtimeCycles?: number
  realtimeRunningConnections?: number
  prehistoricProcessing?: {
    symbolsProcessed: number
    symbolsTotal: number
    symbolsWithoutData: number
    candlesProcessed: number
    indicationResults: number
    strategyPositions: number
    errors: number
    durationMs: number
  }
  configsProcessed: number
  evalsCompleted: number
  avgCycleDuration: number
  lastUpdate: string
  errors: number
  warnings: number
}

export function DetailedLoggingDialog() {
  const { selectedConnectionId, selectedExchange } = useExchange()
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [summary, setSummary] = useState<ProgressSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>("all")
  const [activeTab, setActiveTab] = useState<"logs" | "data">("logs")

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedConnectionId) params.set("connectionId", selectedConnectionId)
      if (selectedExchange) params.set("exchange", selectedExchange)
      const suffix = params.toString() ? `?${params.toString()}` : ""
      const response = await fetch(`/api/trade-engine/detailed-logs${suffix}`, { cache: "no-store" })
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
        setSummary(data.summary || null)
      }
    } catch {
      // non-critical
    } finally {
      setLoading(false)
    }
  }, [selectedConnectionId, selectedExchange])

  // Auto-refresh every 3 seconds while the dialog is open so the data panel stays live.
  useEffect(() => {
    if (!open) return
    fetchLogs()
    const interval = setInterval(fetchLogs, 3000)
    return () => clearInterval(interval)
  }, [open, fetchLogs])

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  const filteredLogs = filter === "all" ? logs : logs.filter(log => log.type === filter)

  const getTypeColor = (type: string) => {
    switch (type) {
      case "indication": return "bg-blue-100 text-blue-800"
      case "strategy": return "bg-purple-100 text-purple-800"
      case "position": return "bg-green-100 text-green-800"
      case "live": return "bg-amber-100 text-amber-800"
      case "engine": return "bg-orange-100 text-orange-800"
      case "error": return "bg-red-100 text-red-800"
      default: return "bg-gray-100 text-gray-800"
    }
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "indication": return <Activity className="h-3 w-3" />
      case "strategy": return <TrendingUp className="h-3 w-3" />
      case "position": return <Database className="h-3 w-3" />
      case "live": return <TrendingUp className="h-3 w-3" />
      default: return <Clock className="h-3 w-3" />
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <FileText className="h-3 w-3" />
          Detailed Logs
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[82vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Detailed Engine Processing Logs</span>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] gap-1">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                </span>
                Auto-refresh 3s
              </Badge>
              <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          <Button
            variant={activeTab === "logs" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("logs")}
            className={`rounded-b-none gap-1 ${activeTab === "logs" ? "" : "text-muted-foreground"}`}
          >
            <FileText className="h-3 w-3" />
            Logs
          </Button>
          <Button
            variant={activeTab === "data" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("data")}
            className={`rounded-b-none gap-1 ${activeTab === "data" ? "" : "text-muted-foreground"}`}
          >
            <Database className="h-3 w-3" />
            Data
          </Button>
        </div>

        {/* Filters - only show for logs tab */}
        {activeTab === "logs" && (
          <div className="flex gap-1 flex-wrap">
            {["all", "indication", "strategy", "position", "live", "engine", "error"].map(f => (
              <Button
                key={f}
                variant={filter === f ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(f)}
                className="text-xs h-7"
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
        )}

        {/* Main Content - Logs or Data */}
        <ScrollArea className="flex-1 min-h-0 border rounded-md bg-slate-50/70 p-2">
          {activeTab === "data" ? (
            <div className="space-y-4 p-2">
              {summary ? (
                <>
                  {/* Prehistoric Data Section */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-700">
                      <History className="h-4 w-4" />
                      Prehistoric Data
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-amber-50 rounded p-2 text-center">
                        <div className="text-amber-700 font-bold text-lg">{summary.prehistoricSymbols}</div>
                        <div className="text-muted-foreground text-[10px]">Symbols Loaded</div>
                      </div>
                      <div className="bg-amber-50 rounded p-2 text-center">
                        <div className="text-amber-700 font-bold text-lg">{summary.prehistoricDataSize}</div>
                        <div className="text-muted-foreground text-[10px]">Data Keys</div>
                      </div>
                    </div>
                  </div>

                  {/* Intervals Processed */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-blue-700">
                      <Layers className="h-4 w-4" />
                      Intervals Processed
                    </div>
                    <div className="bg-blue-50 rounded p-2 text-center">
                      <div className="text-blue-700 font-bold text-lg">{summary.intervalsProcessed}</div>
                      <div className="text-muted-foreground text-[10px]">Total Intervals</div>
                    </div>
                  </div>

                  {/* Strategy Sets and Evaluations — includes Live tier */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700">
                      <GitBranch className="h-4 w-4" />
                      Strategy Coverage (Base → Main → Real → Live)
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
                      <div className="bg-emerald-50 rounded p-2 text-center">
                        <div className="text-emerald-700 font-bold">{summary.strategyCountsByType?.base || 0}</div>
                        <div className="text-muted-foreground text-[8px]">Base Sets</div>
                      </div>
                      <div className="bg-emerald-50 rounded p-2 text-center">
                        <div className="text-emerald-700 font-bold">{summary.strategyCountsByType?.main || 0}</div>
                        <div className="text-muted-foreground text-[8px]">Main Sets</div>
                      </div>
                      <div className="bg-emerald-50 rounded p-2 text-center">
                        <div className="text-emerald-700 font-bold">{summary.strategyCountsByType?.real || 0}</div>
                        <div className="text-muted-foreground text-[8px]">Real Sets</div>
                      </div>
                      <div className="bg-amber-50 rounded p-2 text-center">
                        <div className="text-amber-700 font-bold">{summary.liveExecution?.positionsCreated || 0}</div>
                        <div className="text-muted-foreground text-[8px]">Live Pos</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
                      <div className="bg-emerald-100 rounded p-1 text-center text-[10px]">Eval Base: {summary.strategyEvaluatedByType?.base || 0}</div>
                      <div className="bg-emerald-100 rounded p-1 text-center text-[10px]">Eval Main: {summary.strategyEvaluatedByType?.main || 0}</div>
                      <div className="bg-emerald-100 rounded p-1 text-center text-[10px]">Eval Real: {summary.strategyEvaluatedByType?.real || 0}</div>
                      <div className="bg-amber-100 rounded p-1 text-center text-[10px]">Placed: {summary.liveExecution?.ordersPlaced || 0}</div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
                      <div className="bg-emerald-200/70 rounded p-1 text-center text-[10px]">Passed Base: {summary.strategyPassedByType?.base || 0}</div>
                      <div className="bg-emerald-200/70 rounded p-1 text-center text-[10px]">Passed Main: {summary.strategyPassedByType?.main || 0}</div>
                      <div className="bg-emerald-200/70 rounded p-1 text-center text-[10px]">Passed Real: {summary.strategyPassedByType?.real || 0}</div>
                      <div className="bg-amber-200/70 rounded p-1 text-center text-[10px]">Filled: {summary.liveExecution?.ordersFilled || 0}</div>
                    </div>
                  </div>

                  {/* Live Execution — exchange-side outcomes (local tracking only) */}
                  {summary.liveExecution && (summary.liveExecution.ordersPlaced > 0 || summary.liveExecution.positionsCreated > 0) && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-amber-700">
                        <TrendingUp className="h-4 w-4" />
                        Live Exchange Execution
                        {summary.liveExecution.positionsOpen > 0 && (
                          <Badge variant="outline" className="text-[9px] gap-1 bg-amber-50 border-amber-300">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                            </span>
                            {summary.liveExecution.positionsOpen} open
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
                        <div className="bg-amber-50 rounded p-2 text-center">
                          <div className="text-amber-700 font-bold">{summary.liveExecution.ordersPlaced}</div>
                          <div className="text-muted-foreground text-[8px]">Orders Placed</div>
                        </div>
                        <div className="bg-amber-50 rounded p-2 text-center">
                          <div className="text-amber-700 font-bold">{summary.liveExecution.ordersFilled}</div>
                          <div className="text-muted-foreground text-[8px]">Orders Filled</div>
                        </div>
                        <div className="bg-amber-50 rounded p-2 text-center">
                          <div className="text-amber-700 font-bold">{summary.liveExecution.positionsCreated}</div>
                          <div className="text-muted-foreground text-[8px]">Positions</div>
                        </div>
                        <div className="bg-amber-50 rounded p-2 text-center">
                          <div className="text-amber-700 font-bold">{summary.liveExecution.positionsClosed}</div>
                          <div className="text-muted-foreground text-[8px]">Closed</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px]">
                        <div className="bg-amber-100 rounded p-1 text-center">
                          Fill <span className="font-semibold">{summary.liveExecution.fillRate.toFixed(1)}%</span>
                        </div>
                        <div className="bg-amber-100 rounded p-1 text-center">
                          WR <span className="font-semibold">{summary.liveExecution.winRate.toFixed(1)}%</span>
                        </div>
                        <div className="bg-amber-100 rounded p-1 text-center">
                          Wins <span className="font-semibold">{summary.liveExecution.wins}</span>
                        </div>
                        {/* USDT used-balance tile — shows the margin
                            committed (notional/leverage), NOT the
                            leveraged notional. Tooltip carries the
                            leveraged figure for operators who need it. */}
                        <div
                          className="bg-amber-100 rounded p-1 text-center"
                          title={
                            (summary.liveExecution.marginUsdTotal || 0) > 0
                              ? `USDT used balance (margin): $${(summary.liveExecution.marginUsdTotal || 0).toFixed(2)}\nLeveraged notional: $${summary.liveExecution.volumeUsdTotal.toFixed(2)}`
                              : `Leveraged notional: $${summary.liveExecution.volumeUsdTotal.toFixed(2)} (margin counter not yet populated)`
                          }
                        >
                          USDT <span className="text-[8px] text-muted-foreground">(used)</span> <span className="font-semibold">
                            {(() => {
                              const v = summary.liveExecution.marginUsdTotal || summary.liveExecution.volumeUsdTotal
                              // Sub-dollar margins (e.g. $5 notional at
                              // 125x leverage = $0.04) need extra
                              // precision so the operator doesn't read
                              // "$0.00" and assume nothing committed.
                              if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`
                              if (v >= 1)    return `$${v.toFixed(2)}`
                              if (v > 0)     return `$${v.toFixed(4)}`
                              return "$0.00"
                            })()}
                          </span>
                        </div>
                      </div>
                      {(summary.liveExecution.ordersRejected > 0 || summary.liveExecution.ordersFailed > 0 || summary.liveExecution.ordersSimulated > 0) && (
                        <div className="grid grid-cols-3 gap-1 text-[10px]">
                          {summary.liveExecution.ordersRejected > 0 && (
                            <div className="bg-yellow-50 border border-yellow-200 rounded p-1 text-center">
                              Rejected: <span className="font-semibold text-yellow-700">{summary.liveExecution.ordersRejected}</span>
                            </div>
                          )}
                          {summary.liveExecution.ordersFailed > 0 && (
                            <div className="bg-red-50 border border-red-200 rounded p-1 text-center">
                              Failed: <span className="font-semibold text-red-700">{summary.liveExecution.ordersFailed}</span>
                            </div>
                          )}
                          {summary.liveExecution.ordersSimulated > 0 && (
                            <div className="bg-blue-50 border border-blue-200 rounded p-1 text-center">
                              Simulated: <span className="font-semibold text-blue-700">{summary.liveExecution.ordersSimulated}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Indications by Type */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-purple-700">
                      <BarChart3 className="h-4 w-4" />
                      Indications by Type
                    </div>
                    <div className="grid grid-cols-5 gap-1">
                      <div className="bg-purple-50 rounded p-2 text-center">
                        <div className="text-purple-700 font-bold">{summary.indicationsByType.direction}</div>
                        <div className="text-muted-foreground text-[8px]">Direction</div>
                      </div>
                      <div className="bg-purple-50 rounded p-2 text-center">
                        <div className="text-purple-700 font-bold">{summary.indicationsByType.move}</div>
                        <div className="text-muted-foreground text-[8px]">Move</div>
                      </div>
                      <div className="bg-purple-50 rounded p-2 text-center">
                        <div className="text-purple-700 font-bold">{summary.indicationsByType.active}</div>
                        <div className="text-muted-foreground text-[8px]">Active</div>
                      </div>
                      <div className="bg-purple-50 rounded p-2 text-center">
                        <div className="text-purple-700 font-bold">{summary.indicationsByType.optimal}</div>
                        <div className="text-muted-foreground text-[8px]">Optimal</div>
                      </div>
                      <div className="bg-purple-50 rounded p-2 text-center">
                        <div className="text-purple-700 font-bold">{summary.indicationsByType.auto}</div>
                        <div className="text-muted-foreground text-[8px]">Auto</div>
                      </div>
                    </div>
                    <div className="bg-purple-100 rounded p-1 text-center text-xs">
                      <span className="font-bold text-purple-800">{summary.indicationsByType.total}</span>
                      <span className="text-purple-600"> total indications</span>
                    </div>
                  </div>

                  {/* Pseudo Positions */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-green-700">
                      <GitBranch className="h-4 w-4" />
                      Pseudo Positions
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      <div className="bg-green-50 rounded p-2 text-center">
                        <div className="text-green-700 font-bold">{summary.pseudoPositions.base}</div>
                        <div className="text-muted-foreground text-[8px]">Base</div>
                      </div>
                      <div className="bg-green-50 rounded p-2 text-center">
                        <div className="text-green-700 font-bold">{summary.pseudoPositions.main}</div>
                        <div className="text-muted-foreground text-[8px]">Main</div>
                      </div>
                      <div className="bg-green-50 rounded p-2 text-center">
                        <div className="text-green-700 font-bold">{summary.pseudoPositions.real}</div>
                        <div className="text-muted-foreground text-[8px]">Real</div>
                      </div>
                      <div className="bg-green-50 rounded p-2 text-center">
                        <div className="text-green-700 font-bold">{summary.livePositions}</div>
                        <div className="text-muted-foreground text-[8px]">Live</div>
                      </div>
                    </div>
                  </div>

                  {/* Base Positions by Indication Type */}
                  {summary.pseudoPositionsByType?.baseByIndication && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-cyan-700">
                        <GitBranch className="h-4 w-4" />
                        Base Pseudo by Indication Type
                      </div>
                      <div className="grid grid-cols-4 gap-1">
                        <div className="bg-cyan-50 rounded p-2 text-center">
                          <div className="text-cyan-700 font-bold">{summary.pseudoPositionsByType.baseByIndication.direction}</div>
                          <div className="text-muted-foreground text-[8px]">Direction</div>
                        </div>
                        <div className="bg-cyan-50 rounded p-2 text-center">
                          <div className="text-cyan-700 font-bold">{summary.pseudoPositionsByType.baseByIndication.move}</div>
                          <div className="text-muted-foreground text-[8px]">Move</div>
                        </div>
                        <div className="bg-cyan-50 rounded p-2 text-center">
                          <div className="text-cyan-700 font-bold">{summary.pseudoPositionsByType.baseByIndication.active}</div>
                          <div className="text-muted-foreground text-[8px]">Active</div>
                        </div>
                        <div className="bg-cyan-50 rounded p-2 text-center">
                          <div className="text-cyan-700 font-bold">{summary.pseudoPositionsByType.baseByIndication.optimal}</div>
                          <div className="text-muted-foreground text-[8px]">Optimal</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Cycle Duration */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-orange-700">
                      <Clock className="h-4 w-4" />
                      Cycle Performance
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-orange-50 rounded p-2 text-center">
                        <div className="text-orange-700 font-bold text-lg">{summary.cycleDurationMs}</div>
                        <div className="text-muted-foreground text-[10px]">Last Cycle (ms)</div>
                      </div>
                      <div className="bg-orange-50 rounded p-2 text-center">
                        <div className="text-orange-700 font-bold text-lg">{summary.avgCycleDuration}</div>
                        <div className="text-muted-foreground text-[10px]">Avg Cycle (ms)</div>
                      </div>
                    </div>
                  </div>

                  {summary.prehistoricProcessing && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-rose-700">
                        <BarChart3 className="h-4 w-4" />
                        Prehistoric Processing Details
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
                        <div className="bg-rose-50 rounded p-2 text-center">
                          <div className="text-rose-700 font-bold text-sm">{summary.prehistoricProcessing.symbolsProcessed}/{summary.prehistoricProcessing.symbolsTotal}</div>
                          <div className="text-muted-foreground text-[8px]">Symbols</div>
                        </div>
                        <div className="bg-rose-50 rounded p-2 text-center">
                          <div className="text-rose-700 font-bold text-sm">{summary.prehistoricProcessing.candlesProcessed}</div>
                          <div className="text-muted-foreground text-[8px]">Candles</div>
                        </div>
                        <div className="bg-rose-50 rounded p-2 text-center">
                          <div className="text-rose-700 font-bold text-sm">{summary.prehistoricProcessing.indicationResults}</div>
                          <div className="text-muted-foreground text-[8px]">Indication Results</div>
                        </div>
                        <div className="bg-rose-50 rounded p-2 text-center">
                          <div className="text-rose-700 font-bold text-sm">{summary.prehistoricProcessing.strategyPositions}</div>
                          <div className="text-muted-foreground text-[8px]">Strategy Positions</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-[10px]">
                        <div className="rounded bg-rose-100 px-2 py-1">No data symbols: {summary.prehistoricProcessing.symbolsWithoutData}</div>
                        <div className="rounded bg-rose-100 px-2 py-1">Process duration: {summary.prehistoricProcessing.durationMs}ms</div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center text-muted-foreground py-8">
                  No data available. Start the engine to see prehistoric data metrics.
                </div>
              )}
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No logs available. Start the engine to see processing logs.
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((log) => (
                <Collapsible
                  key={log.id}
                  open={expandedIds.has(log.id)}
                  onOpenChange={() => toggleExpand(log.id)}
                >
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center gap-2 p-2 hover:bg-muted rounded cursor-pointer text-xs border border-transparent hover:border-slate-200">
                      {expandedIds.has(log.id) ? (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      )}
                      <Badge className={`${getTypeColor(log.type)} text-[10px] px-1 py-0`}>
                        {getTypeIcon(log.type)}
                        <span className="ml-1">{log.type}</span>
                      </Badge>
                      {log.symbol && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {log.symbol}
                        </Badge>
                      )}
                      <span className="text-muted-foreground truncate flex-1 leading-relaxed">{log.message}</span>
                      <span className="text-muted-foreground text-[10px] shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-6 p-2 bg-slate-100 rounded text-xs space-y-1">
                      {log.details && (
                        <>
                          {log.details.timeframe && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Timeframe:</span>
                              <span className="font-mono">{log.details.timeframe}</span>
                            </div>
                          )}
                          {log.details.timeRange && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Time Range:</span>
                              <span className="font-mono">{log.details.timeRange}</span>
                            </div>
                          )}
                          {log.details.calculatedIndicators !== undefined && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Indicators Calculated:</span>
                              <span className="font-mono">{log.details.calculatedIndicators}</span>
                            </div>
                          )}
                          {log.details.evaluatedStrategies !== undefined && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Strategies Evaluated:</span>
                              <span className="font-mono">{log.details.evaluatedStrategies}</span>
                            </div>
                          )}
                          {log.details.pseudoPositions && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Pseudo Positions:</span>
                              <span className="font-mono">
                                Base: {log.details.pseudoPositions.base} | 
                                Main: {log.details.pseudoPositions.main} | 
                                Real: {log.details.pseudoPositions.real}
                              </span>
                            </div>
                          )}
                          {log.details.configs !== undefined && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Configs Processed:</span>
                              <span className="font-mono">{log.details.configs}</span>
                            </div>
                          )}
                          {log.details.evals !== undefined && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Evaluations:</span>
                              <span className="font-mono">{log.details.evals}</span>
                            </div>
                          )}
                          {log.details.ratios && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Ratios:</span>
                              <span className="font-mono">
                                Last 25: {log.details.ratios.last25.toFixed(2)} | 
                                Last 50: {log.details.ratios.last50.toFixed(2)} | 
                                Max Pos: {log.details.ratios.maxPos}
                              </span>
                            </div>
                          )}
                          {log.details.cycleDuration !== undefined && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Cycle Duration:</span>
                              <span className="font-mono">{log.details.cycleDuration}ms</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Smart Results Summary - Updates every 5 sec */}
        {summary && (
          <div className="border-t pt-3 mt-2">
            <div className="text-xs font-semibold mb-2 flex items-center gap-2">
              <Activity className="h-4 w-4 text-green-500" />
              Real-Time Progress Summary
              <Badge variant="outline" className="text-[10px]">
                Updated: {new Date(summary.lastUpdate).toLocaleTimeString()}
              </Badge>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs">
              <div className="bg-blue-50 rounded p-2 text-center">
                <div className="text-blue-600 font-bold text-lg">{summary.symbolsActive}</div>
                <div className="text-muted-foreground">Symbols Active</div>
              </div>
              <div className="bg-purple-50 rounded p-2 text-center">
                <div className="text-purple-600 font-bold text-lg">{summary.indicationCycles}</div>
                <div className="text-muted-foreground">Indication Cycles</div>
              </div>
              <div className="bg-green-50 rounded p-2 text-center">
                <div className="text-green-600 font-bold text-lg">{summary.strategyCycles}</div>
                <div className="text-muted-foreground">Strategy Cycles</div>
              </div>
              <div className="bg-orange-50 rounded p-2 text-center">
                <div className="text-orange-600 font-bold text-lg">{summary.totalIndicationsCalculated}</div>
                <div className="text-muted-foreground">Indicators Calc</div>
              </div>
              <div className="bg-cyan-50 rounded p-2 text-center">
                <div className="text-cyan-600 font-bold text-lg">{summary.totalStrategiesEvaluated}</div>
                <div className="text-muted-foreground">Strategies Eval</div>
              </div>
              <div className="bg-pink-50 rounded p-2 text-center">
                <div className="text-pink-600 font-bold text-lg">{summary.avgCycleDuration}ms</div>
                <div className="text-muted-foreground">Avg Cycle</div>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded bg-slate-50 p-2">Realtime cycles: <span className="font-semibold">{summary.realtimeCycles || 0}</span></div>
              <div className="rounded bg-slate-50 p-2">Realtime active connections: <span className="font-semibold">{summary.realtimeRunningConnections || 0}</span></div>
            </div>
            
            {/* Pseudo Positions Breakdown */}
            <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
              <div className="bg-gray-50 rounded p-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Base Positions:</span>
                  <span className="font-mono font-semibold">{summary.pseudoPositions.base}</span>
                </div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Main Positions:</span>
                  <span className="font-mono font-semibold">{summary.pseudoPositions.main}</span>
                </div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Real Positions:</span>
                  <span className="font-mono font-semibold">{summary.pseudoPositions.real}</span>
                </div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total:</span>
                  <span className="font-mono font-semibold text-green-600">{summary.pseudoPositions.total}</span>
                </div>
              </div>
            </div>
            
            {/* Configs and Errors */}
            <div className="mt-2 flex gap-4 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Configs:</span>
                <span className="font-mono font-semibold">{summary.configsProcessed}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Evals:</span>
                <span className="font-mono font-semibold">{summary.evalsCompleted}</span>
              </div>
              {summary.errors > 0 && (
                <div className="flex items-center gap-1 text-red-600">
                  <span>Errors:</span>
                  <span className="font-mono font-semibold">{summary.errors}</span>
                </div>
              )}
              {summary.warnings > 0 && (
                <div className="flex items-center gap-1 text-yellow-600">
                  <span>Warnings:</span>
                  <span className="font-mono font-semibold">{summary.warnings}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
