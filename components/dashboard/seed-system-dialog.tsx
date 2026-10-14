"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Card, CardContent } from "@/components/ui/card"
import {
  Terminal, Activity, Database, Cpu,
  AlertTriangle, ChevronDown, Clock, TrendingUp,
  BarChart3, RefreshCw, XCircle, Zap
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useExchange } from "@/lib/exchange-context"
import { usePoll } from "@/hooks/use-poll"
import {
  buildSeedPerformance,
  buildSeedStats,
  normalizeSeedLog,
  seedLogMatchesFilter,
  type SeedLogEntry,
  type SeedLogFilter,
  type SeedStats,
} from "./seed-system-data"

// The monitor reads the heaviest monitoring endpoints (every position row of
// every connection), so it refreshes at the cadence of the other heavy panels
// and only while the dialog is open and the browser tab is visible.
const SEED_POLL_INTERVAL_MS = 10_000

async function readJson(url: string): Promise<any | null> {
  const response = await fetch(url, { cache: "no-store" }).catch(() => null)
  if (!response?.ok) return null
  return response.json().catch(() => null)
}

/** "—" for a figure without a source value, never a fabricated 0. */
function fmt(value: number | null | undefined, digits = 0, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return `${value.toFixed(digits)}${suffix}`
}

const LOG_FILTERS: Array<{ id: SeedLogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "overall", label: "Overall" },
  { id: "data", label: "Data" },
  { id: "engine", label: "Engine" },
  { id: "errors", label: "Errors" },
]

export function SeedSystemDialog() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId || null
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("main")
  const [activeLogCategory, setActiveLogCategory] = useState<SeedLogFilter>("all")
  const [stats, setStats] = useState<SeedStats | null>(null)
  const [logs, setLogs] = useState<SeedLogEntry[]>([])
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())

  const fetchStats = useCallback(async () => {
    // Only the visible tab is read. The Main tab's three endpoints are
    // requested in parallel; the Log tab needs only the log endpoint.
    if (activeTab === "log") {
      const logData = await readJson("/api/monitoring/logs?limit=100")
      if (Array.isArray(logData?.logs)) setLogs(logData.logs.map(normalizeSeedLog))
      return
    }
    const [monitoring, overview, engineMetrics] = await Promise.all([
      readJson("/api/monitoring/comprehensive"),
      readJson("/api/trade-engine/functional-overview"),
      connectionId
        ? readJson(`/api/engine-metrics?connectionId=${encodeURIComponent(connectionId)}`)
        : Promise.resolve(null),
    ])
    setStats(buildSeedStats(monitoring, overview, buildSeedPerformance(connectionId, engineMetrics)))
  }, [activeTab, connectionId])

  const { refresh, isRunning: loading } = usePoll(fetchStats, {
    intervalMs: SEED_POLL_INTERVAL_MS,
    enabled: isOpen,
  })

  // Switching tab or connection while open reads the new view at once
  // instead of waiting for the next tick.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  useEffect(() => {
    if (isOpenRef.current) refreshRef.current()
  }, [activeTab, connectionId])

  const toggleLogExpand = (id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const formatUptime = (seconds: number | null) => {
    if (seconds === null) return "—"
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
  }

  const filteredLogs = logs.filter((log) => seedLogMatchesFilter(log, activeLogCategory))
  const performance = stats?.performance
  const profitFactorText = performance?.profitFactorInfinite ? "∞" : fmt(performance?.profitFactor, 2)
  const memoryShare = stats?.system.memoryUsedMb != null && stats.system.memoryTotalMb
    ? (stats.system.memoryUsedMb / stats.system.memoryTotalMb) * 100
    : 0

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
              onClick={refresh}
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
                  {/* Realized results of the selected connection (results ledger) */}
                  <div className="text-xs text-muted-foreground">
                    Realized results{performance?.connectionId ? ` · ${performance.connectionId}` : ""}
                    {performance?.settledTrades != null && ` · ${performance.settledTrades} settled trades`}
                    {performance?.connectionId && performance.available && !performance.complete && " · ledger backfill in progress"}
                    {performance?.reason && <span className="ml-1">— {performance.reason}</span>}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <Card className="border-0 bg-muted">
                      <CardContent className="p-3">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> Realized PF
                        </div>
                        <div className="text-lg font-bold text-foreground">{profitFactorText}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-muted">
                      <CardContent className="p-3">
                        <div
                          className="text-xs text-muted-foreground flex items-center gap-1"
                          title="Sum of the last observed Base/Main/Real/Live evaluations of every active symbol"
                        >
                          <BarChart3 className="w-3 h-3" /> Evaluations (basket snapshot)
                        </div>
                        <div className="text-lg font-bold text-foreground">{fmt(stats.evaluationsSnapshot)}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-muted">
                      <CardContent className="p-3">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Activity className="w-3 h-3" /> Live Positions
                        </div>
                        <div className="text-lg font-bold text-foreground">{fmt(stats.positions.live)}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-muted">
                      <CardContent className="p-3">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Drawdown Time{performance?.lookbackDays ? ` (${performance.lookbackDays}d max)` : ""}
                        </div>
                        <div className="text-lg font-bold text-foreground">
                          {fmt(performance?.drawdownMinutes)}
                          {performance?.drawdownMinutes != null && <span className="text-xs font-normal">m</span>}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* System Metrics */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5" /> System Resources
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-card border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground text-xs">CPU Usage</span>
                          <span className="font-mono font-medium">{fmt(stats.system.cpuUsage, 1, "%")}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.min(100, stats.system.cpuUsage ?? 0)}%` }}
                          />
                        </div>
                      </div>
                      <div className="bg-card border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground text-xs">Memory</span>
                          <span className="font-mono font-medium">{fmt(stats.system.memoryUsedMb)}/{fmt(stats.system.memoryTotalMb)} MB</span>
                        </div>
                        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.min(100, memoryShare)}%` }}
                          />
                        </div>
                      </div>
                      <div className="bg-card border rounded p-2.5 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground text-xs">Uptime</span>
                          <span className="font-mono font-medium">{formatUptime(stats.system.uptimeSeconds)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {fmt(stats.system.processCount)} processes running
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Database Metrics */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5" /> Database
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Req/sec</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.database.requestsPerSec, 1)}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Size</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.database.sizeMb, 2, " MB")}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Keys</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.database.keys)}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5" title="Dashboard-enabled exchange connections">
                        <div className="text-xs text-muted-foreground">Active Connections</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.database.activeConnections)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Data Processing */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5" /> Data Processing
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Prehistoric Symbols</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.data.prehistoricSymbols)}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Live Trade Connections</div>
                        <div className="text-base font-bold font-mono text-emerald-600">{fmt(stats.data.liveTradeConnections)}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Strategy Cycles (since start)</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.data.strategyCycles)}</div>
                      </div>
                      <div className="bg-card border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Indication Cycles (since start)</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.data.indicationCycles)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Errors */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> Errors & Status
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-red-50 border border-red-100 rounded p-2.5">
                        <div className="text-xs text-red-600">Critical</div>
                        <div className="text-base font-bold font-mono text-red-700">{fmt(stats.errors.critical)}</div>
                      </div>
                      <div className="bg-amber-50 border border-amber-100 rounded p-2.5">
                        <div className="text-xs text-amber-600">Warnings</div>
                        <div className="text-base font-bold font-mono text-amber-700">{fmt(stats.errors.warning)}</div>
                      </div>
                      <div className="bg-muted border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Last Hour</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.errors.lastHour)}</div>
                      </div>
                      <div className="bg-muted border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Total</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.errors.total)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Positions */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground/80">Positions</h3>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-emerald-50 border border-emerald-100 rounded p-2.5">
                        <div className="text-xs text-emerald-600">Live</div>
                        <div className="text-base font-bold font-mono text-emerald-700">{fmt(stats.positions.live)}</div>
                      </div>
                      <div className="bg-blue-50 border border-blue-100 rounded p-2.5">
                        <div className="text-xs text-blue-600">Pending</div>
                        <div className="text-base font-bold font-mono text-blue-700">{fmt(stats.positions.pending)}</div>
                      </div>
                      <div className="bg-muted border rounded p-2.5">
                        <div className="text-xs text-muted-foreground">Closed</div>
                        <div className="text-base font-bold font-mono">{fmt(stats.positions.closed)}</div>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Bottom Summary */}
                  <div className="text-xs text-muted-foreground flex justify-between items-center">
                    <span>
                      Max Drawdown{performance?.lookbackDays ? ` (${performance.lookbackDays}d)` : ""}:{" "}
                      <span className="font-medium text-foreground/80">{fmt(performance?.maxDrawdownUsd, 2, " USDT")}</span>
                    </span>
                    <span>Win Rate: <span className="font-medium text-foreground/80">{fmt(performance?.winRate, 1, "%")}</span></span>
                    <span>Auto-refresh: {SEED_POLL_INTERVAL_MS / 1000}s</span>
                  </div>
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="log" className="flex-1 p-0 m-0 data-[state=active]:flex data-[state=active]:flex-col">
            <div className="px-4 py-2 border-b">
              <div className="flex gap-1.5">
                {LOG_FILTERS.map(cat => (
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
                  <div className="text-center text-sm text-muted-foreground py-12">No logs available</div>
                ) : (
                  filteredLogs.map(log => (
                    <Collapsible
                      key={log.id}
                      open={expandedLogs.has(log.id)}
                      onOpenChange={() => toggleLogExpand(log.id)}
                      className="border rounded overflow-hidden"
                    >
                      <CollapsibleTrigger className="w-full">
                        <div className="flex items-center gap-2 p-2 hover:bg-muted text-left">
                          {log.level === "warn" && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                          {log.level === "error" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                          {log.level === "info" && <Activity className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}

                          <div className="flex-1 text-xs">
                            <div className="flex justify-between">
                              <span className="font-medium">{log.message}</span>
                              <span className="text-muted-foreground font-mono text-[10px]">{log.timestamp}</span>
                            </div>
                          </div>

                          <Badge variant="outline" className="h-5 text-[10px] px-1.5" title={`Group: ${log.group}`}>
                            {log.category}
                          </Badge>

                          <ChevronDown className={cn(
                            "w-3.5 h-3.5 text-muted-foreground transition-transform",
                            expandedLogs.has(log.id) && "rotate-180"
                          )} />
                        </div>
                      </CollapsibleTrigger>

                      <CollapsibleContent>
                        {log.details && (
                          <div className="p-2.5 bg-muted border-t text-xs font-mono text-foreground/80 space-y-0.5">
                            {Object.entries(log.details).map(([k, v]) => (
                              <div key={k} className="flex gap-2">
                                <span className="text-muted-foreground min-w-[100px]">{k}:</span>
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
