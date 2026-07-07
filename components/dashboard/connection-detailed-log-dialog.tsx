"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  Activity,
  BarChart3,
  Database,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Zap,
  LineChart
} from "lucide-react"
import type { ExchangeConnection } from "@/lib/types"

interface LogEntry {
  id: number
  timestamp: Date
  category: string
  type: "info" | "success" | "warning" | "error"
  message: string
  data?: any
}

interface ConnectionMetrics {
  cyclesCompleted: number
  cycleSuccessRate: number
  averageCycleTime: number
  indicationsTotal: number
  strategiesEvaluated: number
  prehistoricCandles: number
  symbolsLoaded: number
  cpuUsage: number
  memoryUsage: number
  positionsGenerated: number
  // ── Active-now snapshot (per cycle, NOT cumulative) ────────────
  // Pulled from the same `/stats` `activeCounts` / `activeProgressing`
  // blocks that drive `statistics-overview-v2`. Defaults to 0 when
  // the engine hasn't yet emitted them so older deploys still
  // render this dialog deterministically.
  activeIndicationsTotal: number
  activeStrategiesTotal:  number
  // Per-type / per-stage breakdown for the dialog tooltip & Data tab.
  activeIndDirection: number
  activeIndMove:      number
  activeIndActive:    number
  activeIndOptimal:   number
  activeStratBase:    number
  activeStratMain:    number
  activeStratReal:    number
}

interface ConnectionDetailedLogDialogProps {
  connection: ExchangeConnection
}

export function ConnectionDetailedLogDialog({ connection }: ConnectionDetailedLogDialogProps) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [metrics, setMetrics] = useState<ConnectionMetrics | null>(null)
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [isLoading, setIsLoading] = useState(false)

  const loadLogs = useCallback(async () => {
    if (!open) return
    setIsLoading(true)

    try {
      // Load progression logs + cumulative metrics + active-now snapshot.
      // The `/stats` endpoint is the single source of truth for the
      // active-now counters (same one consumed by statistics-overview-v2
      // and progression-logs-dialog), so we fetch it alongside the
      // legacy `/progression/[id]` endpoint that supplies the
      // cumulative totals + monitoring (cpu/memory) figures.
      const [logsRes, metricsRes, statsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connection.id}/logs`,  { cache: 'no-store' }),
        fetch(`/api/connections/progression/${connection.id}`,       { cache: 'no-store' }),
        fetch(`/api/connections/progression/${connection.id}/stats`, { cache: 'no-store' }),
      ])
      const logsData    = await logsRes.json().catch(()    => ({ logs: [] }))
      const metricsData = await metricsRes.json().catch(() => ({}))
      const statsData   = await statsRes.json().catch(()   => ({}))

      // Active-now: prefer fast `activeCounts`, fall back to
      // `activeProgressing.*.total.sets` for older API revs that emit
      // only the per-name rollup. Non-finite values normalize to 0.
      const ac = statsData?.activeCounts
      const ap = statsData?.activeProgressing
      const activeIndDirection = Number(ac?.indications?.direction) || Number(ap?.indications?.direction?.sets) || 0
      const activeIndMove      = Number(ac?.indications?.move)      || Number(ap?.indications?.move?.sets)      || 0
      const activeIndActive    = Number(ac?.indications?.active)    || Number(ap?.indications?.active?.sets)    || 0
      const activeIndOptimal   = Number(ac?.indications?.optimal)   || Number(ap?.indications?.optimal?.sets)   || 0
      const activeIndTotal     = Number(ac?.indications?.total)     || Number(ap?.indications?.total?.sets)
                              || (activeIndDirection + activeIndMove + activeIndActive + activeIndOptimal)
      const activeStratBase    = Number(ac?.strategies?.base)       || Number(ap?.strategies?.base?.sets)       || 0
      const activeStratMain    = Number(ac?.strategies?.main)       || Number(ap?.strategies?.main?.sets)       || 0
      const activeStratReal    = Number(ac?.strategies?.real)       || Number(ap?.strategies?.real?.sets)       || 0
      const activeStratTotal   = Number(ac?.strategies?.total)      || Number(ap?.strategies?.total?.sets)
                              || (activeStratBase + activeStratMain + activeStratReal)

      setMetrics({
        cyclesCompleted: metricsData.state?.cyclesCompleted || metricsData.progressionState?.cyclesCompleted || 0,
        cycleSuccessRate: metricsData.state?.cycleSuccessRate || metricsData.progressionState?.cycleSuccessRate || 0,
        averageCycleTime: metricsData.metrics?.cycleTimeMs || metricsData.progressionState?.cycleTimeMs || 0,
        indicationsTotal: metricsData.state?.indicationsCount || metricsData.progressionState?.indicationsCount || 
                          metricsData.metrics?.indicationsCount
                          || Number(statsData?.realtime?.indicationsTotal) || 0,
        // Canonical "strategies evaluated" = Real-stage count only.
        // Base → Main → Real is a cascade filter of the SAME strategies;
        // summing the three evaluated counters would multi-count them.
        strategiesEvaluated: metricsData.metrics?.totalStrategiesEvaluated
                          || metricsData.progressionState?.strategyEvaluatedReal
                          || Number(statsData?.realtime?.strategiesTotal) || 0,
        prehistoricCandles: metricsData.metrics?.prehistoricCandlesProcessed || metricsData.progressionState?.prehistoricCandlesProcessed || 0,
        symbolsLoaded: metricsData.metrics?.prehistoricSymbolsProcessed || metricsData.progressionState?.prehistoricSymbolsProcessedCount || 0,
        cpuUsage: metricsData.monitoring?.cpu || 0,
        memoryUsage: metricsData.monitoring?.memory || 0,
        positionsGenerated: metricsData.metrics?.intervalsProcessed || metricsData.progressionState?.intervalsProcessed || 0,
        activeIndicationsTotal: activeIndTotal,
        activeStrategiesTotal:  activeStratTotal,
        activeIndDirection,
        activeIndMove,
        activeIndActive,
        activeIndOptimal,
        activeStratBase,
        activeStratMain,
        activeStratReal,
      })

      setLogs(logsData.logs?.slice(-200) || [])
    } catch (err) {
      console.warn("Failed to load connection logs:", err)
    }

    setIsLoading(false)
  }, [connection.id, open])

  useEffect(() => {
    if (open) {
      loadLogs()
      const interval = setInterval(loadLogs, 3000)
      return () => clearInterval(interval)
    }
  }, [open, loadLogs])

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => ({
      ...prev,
      [category]: !prev[category]
    }))
  }

  const getTypeColor = (type: LogEntry["type"]) => {
    switch (type) {
      case "success": return "text-emerald-600"
      case "warning": return "text-amber-600"
      case "error": return "text-red-600"
      default: return "text-slate-600"
    }
  }

  const getTypeIcon = (type: LogEntry["type"]) => {
    switch (type) {
      case "success": return <CheckCircle2 className="w-3 h-3" />
      case "warning": return <AlertTriangle className="w-3 h-3" />
      case "error": return <XCircle className="w-3 h-3" />
      default: return <Clock className="w-3 h-3" />
    }
  }

  const groupedLogs = logs.reduce((acc, log) => {
    const cat = log.category || "general"
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(log)
    return acc
  }, {} as Record<string, LogEntry[]>)

  const errorCount = logs.filter(l => l.type === "error").length
  const warningCount = logs.filter(l => l.type === "warning").length

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1 text-xs">
          <Activity className="w-3.5 h-3.5" />
          Log
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {connection.name} - Detailed Connection Log
            <Badge variant="outline" className="ml-auto">{connection.exchange}</Badge>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid grid-cols-4 mb-2">
            <TabsTrigger value="overview" className="flex items-center gap-1.5 text-xs">
              <BarChart3 className="w-3.5 h-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="main" className="flex items-center gap-1.5 text-xs">
              <Zap className="w-3.5 h-3.5" />
              Main
            </TabsTrigger>
            <TabsTrigger value="data" className="flex items-center gap-1.5 text-xs">
              <Database className="w-3.5 h-3.5" />
              Data
            </TabsTrigger>
            <TabsTrigger value="errors" className="flex items-center gap-1.5 text-xs">
              <AlertTriangle className="w-3.5 h-3.5" />
              Errors
              {errorCount > 0 && <Badge variant="destructive" className="h-4 px-1 text-[10px] ml-1">{errorCount}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="mt-0">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Total Cycles</div>
                <div className="text-xl font-bold text-slate-900">{metrics?.cyclesCompleted || 0}</div>
                <Progress value={Math.min(100, (metrics?.cyclesCompleted || 0) / 10)} className="h-1" />
              </Card>
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Success Rate</div>
                <div className="text-xl font-bold text-emerald-600">{metrics?.cycleSuccessRate?.toFixed(1) || 0}%</div>
                <Progress value={metrics?.cycleSuccessRate || 0} className="h-1 bg-emerald-100" />
              </Card>
              {/*
                Indications tile = active-now headline + cumulative
                subtext. Tooltip carries the full per-type breakdown
                (Direction / Move / Active / Optimal) so the operator
                can see WHICH type is producing signal without
                expanding the Data tab.
              */}
              <Card
                className="p-3 space-y-1"
                title={
                  `Active now (passing thresholds this cycle): ${metrics?.activeIndicationsTotal || 0}\n` +
                  `Per-type alive: D=${metrics?.activeIndDirection || 0} ` +
                  `M=${metrics?.activeIndMove || 0} ` +
                  `A=${metrics?.activeIndActive || 0} ` +
                  `O=${metrics?.activeIndOptimal || 0}\n` +
                  `Cumulative since run start: ${metrics?.indicationsTotal || 0}`
                }
              >
                <div className="text-xs text-slate-500">Indications (alive)</div>
                <div className="text-xl font-bold text-violet-600 tabular-nums flex items-baseline gap-1">
                  {metrics?.activeIndicationsTotal || 0}
                  <span className="text-[10px] font-normal text-slate-500">
                    / {metrics?.indicationsTotal || 0}
                  </span>
                </div>
              </Card>
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Avg Cycle Time</div>
                <div className="text-xl font-bold text-purple-600">{metrics?.averageCycleTime || 0}ms</div>
              </Card>

              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Prehistoric Candles</div>
                <div className="text-lg font-bold text-slate-700">{metrics?.prehistoricCandles?.toLocaleString() || 0}</div>
              </Card>
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Symbols Loaded</div>
                <div className="text-lg font-bold text-slate-700">{metrics?.symbolsLoaded || 0}</div>
              </Card>
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">CPU Usage</div>
                <div className="text-lg font-bold text-slate-700">{metrics?.cpuUsage || 0}%</div>
                <Progress value={metrics?.cpuUsage || 0} className="h-1" />
              </Card>
              <Card className="p-3 space-y-1">
                <div className="text-xs text-slate-500">Memory Usage</div>
                <div className="text-lg font-bold text-slate-700">{metrics?.memoryUsage || 0}%</div>
                <Progress value={metrics?.memoryUsage || 0} className="h-1" />
              </Card>
            </div>

            <Card className="p-4">
              <h4 className="text-sm font-medium mb-2">Recent Activity</h4>
              <ScrollArea className="h-[250px]">
                <div className="space-y-1">
                  {logs.slice(0, 30).map(entry => (
                    <div key={entry.id} className={`flex items-start gap-2 text-xs py-1 ${getTypeColor(entry.type)}`}>
                      <span className="mt-0.5">{getTypeIcon(entry.type)}</span>
                      <span className="text-slate-400 min-w-[70px]">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </Card>
          </TabsContent>

          {/* Main Tab */}
          <TabsContent value="main" className="mt-0">
            <div className="space-y-2">
              {Object.entries(groupedLogs).map(([category, entries]) => (
                <Card key={category} className="overflow-hidden">
                  <button
                    onClick={() => toggleCategory(category)}
                    className="w-full flex items-center justify-between p-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {expandedCategories[category] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <span className="text-sm font-medium">{category}</span>
                      <Badge variant="outline" className="text-xs">{entries.length}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {entries.some(e => e.type === "error") && <Badge variant="destructive" className="h-4 text-[10px]">Errors</Badge>}
                      {entries.some(e => e.type === "warning") && <Badge variant="outline" className="h-4 text-[10px] bg-amber-50 text-amber-700">Warnings</Badge>}
                    </div>
                  </button>

                  {expandedCategories[category] && (
                    <div className="border-t px-3 py-2">
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-1">
                          {entries.map(entry => (
                            <div key={entry.id} className={`flex items-start gap-2 text-xs py-1 ${getTypeColor(entry.type)}`}>
                              <span className="mt-0.5">{getTypeIcon(entry.type)}</span>
                              <span className="text-slate-400 min-w-[70px]">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                              <span className="flex-1">{entry.message}</span>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* Data Tab */}
          <TabsContent value="data" className="mt-0">
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Card className="p-3 space-y-2">
                <h5 className="text-xs font-semibold text-slate-700">Prehistoric Data</h5>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500">Candles Processed</span><span>{metrics?.prehistoricCandles?.toLocaleString() || 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Symbols Loaded</span><span>{metrics?.symbolsLoaded || 0}</span></div>
                </div>
              </Card>
              {/*
                Indications & Strategies cards now show BOTH the
                cumulative total (since run start) AND the active-now
                snapshot (alive in the current cycle). The active row
                is split per-type / per-stage so the operator can see
                WHICH type is producing signal and WHICH stage is
                carrying live Sets without leaving the Data tab.
              */}
              <Card className="p-3 space-y-2">
                <h5 className="text-xs font-semibold text-slate-700">Indications</h5>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500">Total Generated</span><span className="tabular-nums">{metrics?.indicationsTotal || 0}</span></div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Active Now</span>
                    <span className="tabular-nums font-semibold text-violet-700">
                      {metrics?.activeIndicationsTotal || 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>D / M / A / O</span>
                    <span className="tabular-nums">
                      {metrics?.activeIndDirection || 0} ·
                      {metrics?.activeIndMove || 0} ·
                      {metrics?.activeIndActive || 0} ·
                      {metrics?.activeIndOptimal || 0}
                    </span>
                  </div>
                </div>
              </Card>
              <Card className="p-3 space-y-2">
                <h5 className="text-xs font-semibold text-slate-700">Strategies</h5>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500">Evaluated</span><span className="tabular-nums">{metrics?.strategiesEvaluated || 0}</span></div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Active Now</span>
                    <span className="tabular-nums font-semibold text-amber-700">
                      {metrics?.activeStrategiesTotal || 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>B / M / R</span>
                    <span className="tabular-nums">
                      {metrics?.activeStratBase || 0} ·
                      {metrics?.activeStratMain || 0} ·
                      {metrics?.activeStratReal || 0}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-slate-500">Positions Generated</span><span className="tabular-nums">{metrics?.positionsGenerated || 0}</span></div>
                </div>
              </Card>
            </div>

            <Card className="p-4">
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <LineChart className="w-4 h-4" />
                Processing Timeline
              </h4>
              <div className="space-y-2 text-xs">
                <div className="space-y-1">
                  <div className="flex justify-between"><span>Engine Initialization</span><Badge variant="default">Completed</Badge></div>
                  <Progress value={100} className="h-1.5" />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between"><span>Prehistoric Loading</span><Badge variant="default">{metrics?.prehistoricCandles ? "Completed" : "Running"}</Badge></div>
                  <Progress value={metrics?.prehistoricCandles ? 100 : 65} className="h-1.5" />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between"><span>Indications Engine</span><Badge variant="default">Active</Badge></div>
                  <Progress value={85} className="h-1.5" />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between"><span>Strategy Processing</span><Badge variant="default">Active</Badge></div>
                  <Progress value={72} className="h-1.5" />
                </div>
              </div>
            </Card>
          </TabsContent>

          {/* Errors Tab */}
          <TabsContent value="errors" className="mt-0">
            {errorCount === 0 && warningCount === 0 ? (
              <Card className="p-8 text-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
                <h4 className="font-medium text-slate-700 mb-1">No errors detected</h4>
                <p className="text-sm text-slate-500">All systems running normally with 0 errors and 0 warnings</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {errorCount > 0 && (
                  <Card className="p-3 border-red-200 bg-red-50">
                    <h5 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1.5">
                      <XCircle className="w-4 h-4" />
                      Errors ({errorCount})
                    </h5>
                    <ScrollArea className="h-[200px]">
                      <div className="space-y-1.5">
                        {logs.filter(l => l.type === "error").map(entry => (
                          <div key={entry.id} className="text-xs bg-white rounded p-2 border border-red-100">
                            <div className="flex justify-between text-slate-500 mb-1">
                              <span>{entry.category}</span>
                              <span>{new Date(entry.timestamp).toLocaleString()}</span>
                            </div>
                            <div className="text-red-700">{entry.message}</div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </Card>
                )}

                {warningCount > 0 && (
                  <Card className="p-3 border-amber-200 bg-amber-50 mt-3">
                    <h5 className="text-sm font-semibold text-amber-700 mb-2 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" />
                      Warnings ({warningCount})
                    </h5>
                    <ScrollArea className="h-[200px]">
                      <div className="space-y-1.5">
                        {logs.filter(l => l.type === "warning").map(entry => (
                          <div key={entry.id} className="text-xs bg-white rounded p-2 border border-amber-100">
                            <div className="flex justify-between text-slate-500 mb-1">
                              <span>{entry.category}</span>
                              <span>{new Date(entry.timestamp).toLocaleString()}</span>
                            </div>
                            <div className="text-amber-700">{entry.message}</div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </Card>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <Separator />

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={loadLogs} disabled={isLoading}>
            {isLoading ? "Loading..." : "Refresh"}
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
