"use client"

import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Card, CardContent } from "@/components/ui/card"
import { 
  Terminal, Activity, Database, Cpu, HardDrive, 
  AlertTriangle, ChevronDown, Clock, TrendingUp, 
  BarChart3, RefreshCw, XCircle, CheckCircle2, Zap
} from "lucide-react"
import { cn } from "@/lib/utils"

interface SystemStats {
  evaluations: {
    total: number
    successRate: number
    averageProfitFactor: number
    maxDrawdown: number
    drawdownTime: number
  }
  positions: {
    live: number
    pending: number
    closed: number
  }
  database: {
    requestsPerSec: number
    sizeMb: number
    totalRecords: number
    connections: number
  }
  system: {
    cpuUsage: number
    memoryUsage: number
    memoryTotal: number
    uptime: number
    processCount: number
  }
  errors: {
    total: number
    lastHour: number
    critical: number
    warning: number
  }
  data: {
    prehistoricLoaded: number
    realtimeActive: number
    evaluationsProcessed: number
    cyclesCompleted: number
  }
}

interface LogEntry {
  id: string
  timestamp: string
  category: "overall" | "data" | "engine" | "errors"
  level: "info" | "warn" | "error" | "success"
  message: string
  details?: Record<string, any>
}

export function SeedSystemDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("main")
  const [activeLogCategory, setActiveLogCategory] = useState<string>("all")
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const fetchStats = async () => {
    setLoading(true)
    try {
      // Fetch comprehensive monitoring data
      const res = await fetch("/api/monitoring/comprehensive", { cache: "no-store" })
      
      // Fetch functional overview
      const funcRes = await fetch("/api/trade-engine/functional-overview", { cache: "no-store" })
      
      // Fetch system metrics
      const metricsRes = await fetch("/api/engine-metrics", { cache: "no-store" })
      
      // Fetch detailed logs
      const logRes = await fetch("/api/monitoring/logs?limit=100", { cache: "no-store" })

      const [monitorData, funcData, metricsData, logData] = await Promise.allSettled([
        res.ok ? res.json() : null,
        funcRes.ok ? funcRes.json() : null,
        metricsRes.ok ? metricsRes.json() : null,
        logRes.ok ? logRes.json() : null
      ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null))

      const functionalOverview = funcData || {}
      const monitoring = monitorData || {}
      const metrics = metricsData || {}
      
      setStats({
        evaluations: {
          total: functionalOverview.strategiesEvaluated || 0,
          successRate: metrics.successRate || 0,
          averageProfitFactor: +(metrics.profitFactor || 0).toFixed(2),
          maxDrawdown: +(metrics.maxDrawdown || 0).toFixed(1),
          drawdownTime: metrics.drawdownTime || 0
        },
        positions: {
          live: monitoring.trading?.livePositions || 0,
          pending: monitoring.trading?.pendingPositions || 0,
          closed: monitoring.trading?.closedPositions || 0
        },
        database: {
          requestsPerSec: monitoring.database?.requestsPerSecond || 0,
          sizeMb: monitoring.database?.sizeMb || 0,
          totalRecords: functionalOverview.positionsEntriesCreated || 0,
          connections: monitoring.database?.activeConnections || 0
        },
        system: {
          cpuUsage: monitoring.system?.cpuUsage || 0,
          memoryUsage: Math.round((monitoring.system?.memoryUsed || 0) / 1024 / 1024),
          memoryTotal: Math.round((monitoring.system?.memoryTotal || 4194304) / 1024 / 1024),
          uptime: Math.floor(monitoring.system?.uptime || 0),
          processCount: monitoring.system?.processCount || 0
        },
        errors: {
          total: monitoring.errors?.total || 0,
          lastHour: monitoring.errors?.lastHour || 0,
          critical: monitoring.errors?.critical || 0,
          warning: monitoring.errors?.warnings || 0
        },
        data: {
          prehistoricLoaded: functionalOverview.symbolsActive || 0,
          realtimeActive: monitoring.connections?.liveTrade || 0,
          evaluationsProcessed: functionalOverview.indicationsCalculated || 0,
          cyclesCompleted: functionalOverview.counts?.indicationCycles || 0
        }
      })

      if (logData?.logs) {
        setLogs(logData.logs.map((log: any) => ({
          id: log.id,
          timestamp: log.timestamp,
          category: log.category || "overall",
          level: log.level || "info",
          message: log.message,
          details: log.details
        })))
      }
    } catch (e) {
      console.warn("System stats fetch failed")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetchStats()
      const interval = setInterval(fetchStats, 3000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  const toggleLogExpand = (id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
  }

  const filteredLogs = activeLogCategory === "all" 
    ? logs 
    : logs.filter(l => l.category === activeLogCategory)

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-9 px-3 text-xs gap-1.5 hover:bg-blue-100 hover:text-blue-700"
        >
          <Terminal className="w-3.5 h-3.5" />
          Seed 2.0
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl w-[95vw] h-[85vh] p-0 flex flex-col">
        <DialogHeader className="px-4 pt-4 pb-2 flex flex-row items-center justify-between">
          <DialogTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-blue-600" />
            System Monitor
          </DialogTitle>
          <div className="flex items-center gap-4">
            <Badge variant="outline" className="text-xs font-mono">Seed 2.0</Badge>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7" 
              onClick={fetchStats}
              disabled={loading}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </DialogHeader>
        
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="mx-4 h-8">
            <TabsTrigger value="main" className="h-7 text-xs">Main</TabsTrigger>
            <TabsTrigger value="log" className="h-7 text-xs">Log</TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="flex-1 p-0 m-0 data-[state=active]:flex data-[state=active]:flex-col">
            <ScrollArea className="flex-1 px-4 py-2">
              {stats && (
                <div className="space-y-4 pb-4">
                  {/* Top Summary Cards */}
                  <div className="grid grid-cols-4 gap-2">
                    <Card className="border-0 bg-slate-50">
                      <CardContent className="p-3">
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> Profit Factor
                        </div>
                        <div className="text-lg font-bold text-slate-800">{stats.evaluations.averageProfitFactor}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-slate-50">
                      <CardContent className="p-3">
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <BarChart3 className="w-3 h-3" /> Evaluations
                        </div>
                        <div className="text-lg font-bold text-slate-800">
                          {stats.evaluations.total}
                          <span className="text-xs font-normal text-slate-500 ml-1">({stats.evaluations.successRate}%)</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-slate-50">
                      <CardContent className="p-3">
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <Activity className="w-3 h-3" /> Live Positions
                        </div>
                        <div className="text-lg font-bold text-slate-800">{stats.positions.live}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-slate-50">
                      <CardContent className="p-3">
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Drawdown Time
                        </div>
                        <div className="text-lg font-bold text-slate-800">{stats.evaluations.drawdownTime}<span className="text-xs font-normal">m</span></div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* System Metrics */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5" /> System Resources
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-white border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-500 text-xs">CPU Usage</span>
                          <span className="font-mono font-medium">{stats.system.cpuUsage}%</span>
                        </div>
                        <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-blue-500 rounded-full transition-all duration-500" 
                            style={{ width: `${stats.system.cpuUsage}%` }}
                          />
                        </div>
                      </div>
                      <div className="bg-white border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-500 text-xs">Memory</span>
                          <span className="font-mono font-medium">{stats.system.memoryUsage}/{stats.system.memoryTotal} MB</span>
                        </div>
                        <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-emerald-500 rounded-full transition-all duration-500" 
                            style={{ width: `${(stats.system.memoryUsage / stats.system.memoryTotal) * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="bg-white border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-500 text-xs">Uptime</span>
                          <span className="font-mono font-medium">{formatUptime(stats.system.uptime)}</span>
                        </div>
                        <div className="text-xs text-slate-400 mt-1">
                          {stats.system.processCount} processes running
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Database Metrics */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5" /> Database
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Req/sec</div>
                        <div className="text-base font-bold font-mono">{stats.database.requestsPerSec}</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Size</div>
                        <div className="text-base font-bold font-mono">{stats.database.sizeMb} MB</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Records</div>
                        <div className="text-base font-bold font-mono">{stats.database.totalRecords}</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Connections</div>
                        <div className="text-base font-bold font-mono">{stats.database.connections}</div>
                      </div>
                    </div>
                  </div>

                  {/* Data Processing */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5" /> Data Processing
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Prehistoric</div>
                        <div className="text-base font-bold font-mono">{stats.data.prehistoricLoaded}</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Realtime</div>
                        <div className="text-base font-bold font-mono text-emerald-600">{stats.data.realtimeActive} Active</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Evaluations</div>
                        <div className="text-base font-bold font-mono">{stats.data.evaluationsProcessed}</div>
                      </div>
                      <div className="bg-white border rounded p-2.5">
                        <div className="text-xs text-slate-500">Cycles</div>
                        <div className="text-base font-bold font-mono">{stats.data.cyclesCompleted}</div>
                      </div>
                    </div>
                  </div>

                  {/* Errors */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> Errors & Status
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-red-50 border border-red-100 rounded p-2.5">
                        <div className="text-xs text-red-600">Critical</div>
                        <div className="text-base font-bold font-mono text-red-700">{stats.errors.critical}</div>
                      </div>
                      <div className="bg-amber-50 border border-amber-100 rounded p-2.5">
                        <div className="text-xs text-amber-600">Warnings</div>
                        <div className="text-base font-bold font-mono text-amber-700">{stats.errors.warning}</div>
                      </div>
                      <div className="bg-slate-50 border rounded p-2.5">
                        <div className="text-xs text-slate-500">Last Hour</div>
                        <div className="text-base font-bold font-mono">{stats.errors.lastHour}</div>
                      </div>
                      <div className="bg-slate-50 border rounded p-2.5">
                        <div className="text-xs text-slate-500">Total</div>
                        <div className="text-base font-bold font-mono">{stats.errors.total}</div>
                      </div>
                    </div>
                  </div>

                  {/* Positions */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-700">Positions</h3>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-emerald-50 border border-emerald-100 rounded p-2.5">
                        <div className="text-xs text-emerald-600">Live</div>
                        <div className="text-base font-bold font-mono text-emerald-700">{stats.positions.live}</div>
                      </div>
                      <div className="bg-blue-50 border border-blue-100 rounded p-2.5">
                        <div className="text-xs text-blue-600">Pending</div>
                        <div className="text-base font-bold font-mono text-blue-700">{stats.positions.pending}</div>
                      </div>
                      <div className="bg-slate-50 border rounded p-2.5">
                        <div className="text-xs text-slate-500">Closed</div>
                        <div className="text-base font-bold font-mono">{stats.positions.closed}</div>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Bottom Summary */}
                  <div className="text-xs text-slate-400 flex justify-between items-center">
                    <span>Max Drawdown: <span className="font-medium text-slate-600">{stats.evaluations.maxDrawdown}%</span></span>
                    <span>Success Rate: <span className="font-medium text-slate-600">{stats.evaluations.successRate}%</span></span>
                    <span>Auto-refresh: 3s</span>
                  </div>
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="log" className="flex-1 p-0 m-0 data-[state=active]:flex data-[state=active]:flex-col">
            <div className="px-4 py-2 border-b">
              <div className="flex gap-1.5">
                {[
                  { id: "all", label: "All" },
                  { id: "overall", label: "Overall" },
                  { id: "data", label: "Data" },
                  { id: "engine", label: "Engine" },
                  { id: "errors", label: "Errors" },
                ].map(cat => (
                  <Button
                    key={cat.id}
                    variant={activeLogCategory === cat.id ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs px-2.5"
                    onClick={() => setActiveLogCategory(cat.id)}
                  >
                    {cat.label}
                  </Button>
                ))}
              </div>
            </div>
            
            <ScrollArea className="flex-1">
              <div className="px-4 py-2 space-y-1">
                {filteredLogs.length === 0 ? (
                  <div className="text-center text-sm text-slate-400 py-12">No logs available</div>
                ) : (
                  filteredLogs.map(log => (
                    <Collapsible 
                      key={log.id} 
                      open={expandedLogs.has(log.id)} 
                      onOpenChange={() => toggleLogExpand(log.id)}
                      className="border rounded overflow-hidden"
                    >
                      <CollapsibleTrigger className="w-full">
                        <div className="flex items-center gap-2 p-2 hover:bg-slate-50 text-left">
                          {log.level === "success" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
                          {log.level === "warn" && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                          {log.level === "error" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                          {log.level === "info" && <Activity className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                          
                          <div className="flex-1 text-xs">
                            <div className="flex justify-between">
                              <span className="font-medium">{log.message}</span>
                              <span className="text-slate-400 font-mono text-[10px]">{log.timestamp}</span>
                            </div>
                          </div>
                          
                          <Badge variant="outline" className="h-5 text-[10px] px-1.5">
                            {log.category}
                          </Badge>
                          
                          <ChevronDown className={cn(
                            "w-3.5 h-3.5 text-slate-400 transition-transform",
                            expandedLogs.has(log.id) && "rotate-180"
                          )} />
                        </div>
                      </CollapsibleTrigger>
                      
                      <CollapsibleContent>
                        {log.details && (
                          <div className="p-2.5 bg-slate-50 border-t text-xs font-mono text-slate-600 space-y-0.5">
                            {Object.entries(log.details).map(([k, v]) => (
                              <div key={k} className="flex gap-2">
                                <span className="text-slate-400 min-w-[100px]">{k}:</span>
                                <span>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
