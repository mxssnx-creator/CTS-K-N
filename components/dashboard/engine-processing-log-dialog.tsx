"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Activity, BarChart2, Clock, Database, RefreshCw, StopCircle, Zap, Play } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string
  type: "prehistoric" | "realtime" | "indication" | "strategy" | "error" | "info"
  message: string
  details?: any
}

interface ProcessingStats {
  historic: {
    symbolsLoaded: number
    symbolsTotal: number
    candlesProcessed: number
    cyclesCompleted: number
    progressPercent: number
    isLoaded: boolean
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    realtimeCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    isActive: boolean
    cycleTimeMs: number
    successRate: number
    // ── ACTIVE-NOW (per cycle) ─────────────────────────────────────
    // Snapshot counts read from the engine's per-cycle "alive now"
    // accumulators (`activeCounts.{indications,strategies}.total`).
    // The dialog renders these as the headline numbers and the
    // cumulative totals above as the smaller subscript — matching the
    // pattern already used by `statistics-overview-v2`. Defaults to 0
    // when the server hasn't emitted the block yet so older API revs
    // keep rendering deterministically.
    activeIndTotal: number
    activeStratTotal: number
  }
  performance: {
    avgCycleTimeMs: number
    successRatePercent: number
    hasErrors: boolean
  }
  breakdown: {
    indications: Record<string, number>
    strategies: { base: number; main: number; real: number }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function EngineProcessingLogDialog({ connectionId: propConnectionId }: { connectionId?: string }) {
  const { selectedConnectionId } = useExchange()
  const activeConnectionId = propConnectionId || selectedConnectionId || "default-bingx-001"

  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<ProcessingStats | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry["type"], message: string, details?: any) => {
    setLogs(prev => [
      { timestamp: new Date().toISOString(), type, message, details },
      ...prev.slice(0, 499),
    ])
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      // Single canonical /stats endpoint — returns historic, realtime, breakdown in one call
      const statsRes = await fetch(
        `/api/connections/progression/${activeConnectionId}/stats`,
        { cache: "no-store" }
      )

      if (!statsRes.ok) {
        addLog("error", `Failed to fetch stats (HTTP ${statsRes.status})`)
        return
      }
      const [monitorRes, connLogRes, engineRes] = await Promise.all([
        fetch('/api/system/monitoring', { cache: 'no-store' }),
        fetch(`/api/connections/progression/${activeConnectionId}/logs`, { cache: 'no-store' }),
        fetch('/api/engine/verify', { cache: 'no-store' })
      ])

      const s = await statsRes.json()

      const historicSymbols   = s.historic?.symbolsProcessed || 0
      const historicTotal     = s.historic?.symbolsTotal     || 0
      const historicCandles   = s.historic?.candlesLoaded    || 0
      const historicCycles    = s.historic?.cyclesCompleted  || 0
      const historicPercent   = s.historic?.progressPercent  || 0
      const historicComplete  = s.historic?.isComplete       || false

      const indicationCycles  = s.realtime?.indicationCycles || 0
      const strategyCycles    = s.realtime?.strategyCycles   || 0
      const realtimeCycles    = s.realtime?.realtimeCycles   || 0
      const indicationsTotal  = s.realtime?.indicationsTotal || 0
      const strategiesTotal   = s.realtime?.strategiesTotal  || 0
      const positionsOpen     = s.realtime?.positionsOpen    || 0
      const isActive          = s.realtime?.isActive         || false
      const successRate       = s.realtime?.successRate      || 0
      const cycleTimeMs       = s.realtime?.avgCycleTimeMs   || 0
      const hasErrors         = s.metadata?.phase === "error"

      // ── Active-now snapshot ──────────────────────────────────────
      // Two equivalent sources are tried, in order:
      //   1. `activeCounts` — the per-cycle accumulator written by
      //      indication-sets-processor + strategy-coordinator. Same
      //      block consumed by `statistics-overview-v2`.
      //   2. `activeProgressing.*.total.sets` — the explicit per-name
      //      rollup populated by the unified active-progressing route.
      //      Used as a fallback so older deploys (which only emit
      //      `activeProgressing`) still surface non-zero numbers.
      const activeIndTotal =
        Number(s.activeCounts?.indications?.total) ||
        Number(s.activeProgressing?.indications?.total?.sets) ||
        0
      const activeStratTotal =
        Number(s.activeCounts?.strategies?.total) ||
        Number(s.activeProgressing?.strategies?.total?.sets) ||
        0

      const newStats: ProcessingStats = {
        historic: {
          symbolsLoaded:   historicSymbols,
          symbolsTotal:    historicTotal,
          candlesProcessed: historicCandles,
          cyclesCompleted: historicCycles,
          progressPercent: historicPercent,
          isLoaded:        historicComplete,
        },
        realtime: {
          indicationCycles,
          strategyCycles,
          realtimeCycles,
          indicationsTotal,
          strategiesTotal,
          activeIndTotal,
          activeStratTotal,
          positionsOpen,
          isActive,
          cycleTimeMs,
          successRate,
        },
        performance: {
          avgCycleTimeMs:     cycleTimeMs,
          successRatePercent: successRate,
          hasErrors,
        },
        breakdown: {
          indications: {
            Direction: s.breakdown?.indications?.direction || 0,
            Move:      s.breakdown?.indications?.move      || 0,
            Active:    s.breakdown?.indications?.active    || 0,
            Optimal:   s.breakdown?.indications?.optimal   || 0,
            Auto:      s.breakdown?.indications?.auto      || 0,
          },
          strategies: {
            base: s.breakdown?.strategies?.base || 0,
            main: s.breakdown?.strategies?.main || 0,
            real: s.breakdown?.strategies?.real || 0,
          },
        },
      }

      setStats(newStats)

      // Emit summary log entry for the Live Log tab
      if (isActive && indicationCycles > 0) {
        addLog(
          "realtime",
          `Cycle ${indicationCycles} | Indications: ${indicationsTotal} | ` +
          `Strategies: ${strategiesTotal} | Positions: ${positionsOpen} | ` +
          `${successRate.toFixed(1)}% success`
        )
      } else if (!historicComplete && historicSymbols > 0) {
        addLog("prehistoric", `Historic: ${historicSymbols}/${historicTotal} symbols | ${historicCandles.toLocaleString()} candles`)
      } else if (historicComplete && !isActive) {
        addLog("info", "Historic data loaded — awaiting first realtime cycle")
      }

    } catch (err) {
      addLog("error", "Failed to fetch engine stats", { error: String(err) })
    }
  }, [activeConnectionId, addLog])

  const startPolling = useCallback(() => {
    setIsPolling(true)
    addLog("info", `Started monitoring: ${activeConnectionId}`)
    fetchStats()
    pollIntervalRef.current = setInterval(fetchStats, 2000)
  }, [fetchStats, addLog, activeConnectionId])

  const stopPolling = useCallback(() => {
    setIsPolling(false)
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    addLog("info", "Monitoring paused")
  }, [addLog])

  useEffect(() => {
    if (open) {
      startPolling()
    } else {
      stopPolling()
    }
    return () => stopPolling()

  }, [open])

  // Re-start polling when connection changes while open
  useEffect(() => {
    if (!open) return
    stopPolling()
    startPolling()

  }, [activeConnectionId])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  const getLogBadge = (type: LogEntry["type"]) => {
    const map: Record<string, string> = {
      prehistoric: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400",
      realtime:    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400",
      indication:  "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-400",
      strategy:    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400",
      error:       "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400",
      info:        "bg-muted text-muted-foreground",
    }
    return (
      <Badge variant="outline" className={`text-[10px] px-1.5 h-4 shrink-0 ${map[type] || map.info}`}>
        {type.toUpperCase()}
      </Badge>
    )
  }

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1.5 text-xs">
          <Activity className="w-3.5 h-3.5" />
          Engine Log
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Engine Processing Log
              <span className="text-sm font-normal text-muted-foreground">{activeConnectionId}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={isPolling ? "default" : "outline"} className={isPolling ? "bg-green-600" : ""}>
                {isPolling ? "LIVE" : "PAUSED"}
              </Badge>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={isPolling ? stopPolling : startPolling}>
                {isPolling
                  ? <StopCircle className="w-3.5 h-3.5" />
                  : <Play className="w-3.5 h-3.5" />
                }
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid grid-cols-4 shrink-0">
            <TabsTrigger value="overview"   className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="historic"   className="text-xs">Historic</TabsTrigger>
            <TabsTrigger value="breakdown"  className="text-xs">Breakdown</TabsTrigger>
            <TabsTrigger value="logs"       className="text-xs">Live Log</TabsTrigger>
          </TabsList>

          {/* ── Overview ── */}
          <TabsContent value="overview" className="mt-3 space-y-3 overflow-y-auto flex-1">
            {stats ? (
              <>
                {/* Historic */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Database className="w-4 h-4 text-blue-500" />
                      Historic Data Loading
                    </div>
                    <Badge variant={stats.historic.isLoaded ? "default" : "secondary"}>
                      {stats.historic.isLoaded ? "LOADED" : "LOADING"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Symbols: {stats.historic.symbolsLoaded}/{stats.historic.symbolsTotal}</span>
                      <span>{stats.historic.progressPercent}%</span>
                    </div>
                    <Progress value={stats.historic.progressPercent} className="h-2" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.historic.cyclesCompleted)}</div>
                      <div className="text-muted-foreground">Cycles</div>
                    </div>
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.historic.candlesProcessed)}</div>
                      <div className="text-muted-foreground">Candles</div>
                    </div>
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{stats.historic.symbolsLoaded}</div>
                      <div className="text-muted-foreground">Symbols</div>
                    </div>
                  </div>
                </Card>

                {/* Realtime */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Activity className="w-4 h-4 text-green-500" />
                      Realtime Processing
                    </div>
                    <Badge variant={stats.realtime.isActive ? "default" : "secondary"}>
                      {stats.realtime.isActive ? "RUNNING" : "IDLE"}
                    </Badge>
                  </div>
                  {/*
                    Headline = active-now sets ("alive in this cycle"),
                    sub-line = cumulative-since-run-start. Hover tooltips
                    spell out both numbers so the operator never has to
                    guess which one is which. Mirrors the layout used by
                    statistics-overview-v2 so the two surfaces line up
                    when an operator pivots between them.
                  */}
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold tabular-nums">{fmt(stats.realtime.indicationCycles)}</div>
                      <div className="text-muted-foreground">Ind. Cycles</div>
                    </div>
                    <div
                      className="bg-green-50 dark:bg-green-950/30 rounded p-2"
                      title={
                        `Indications currently alive (passing thresholds this cycle): ${fmt(stats.realtime.activeIndTotal)}\n` +
                        `Cumulative indications since run start: ${fmt(stats.realtime.indicationsTotal)}`
                      }
                    >
                      <div className="font-semibold tabular-nums text-violet-700 dark:text-violet-300 flex items-baseline justify-center gap-1">
                        {fmt(stats.realtime.activeIndTotal)}
                        <span className="text-[9px] font-normal text-muted-foreground">/ {fmt(stats.realtime.indicationsTotal)}</span>
                      </div>
                      <div className="text-muted-foreground">Indications (alive)</div>
                    </div>
                    <div
                      className="bg-green-50 dark:bg-green-950/30 rounded p-2"
                      title={
                        `Strategy Sets currently alive across stages (Base + Main + Real): ${fmt(stats.realtime.activeStratTotal)}\n` +
                        `Cumulative Sets since run start: ${fmt(stats.realtime.strategiesTotal)}`
                      }
                    >
                      <div className="font-semibold tabular-nums text-amber-700 dark:text-amber-300 flex items-baseline justify-center gap-1">
                        {fmt(stats.realtime.activeStratTotal)}
                        <span className="text-[9px] font-normal text-muted-foreground">/ {fmt(stats.realtime.strategiesTotal)}</span>
                      </div>
                      <div className="text-muted-foreground">Strategies (alive)</div>
                    </div>
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold tabular-nums">{stats.realtime.positionsOpen}</div>
                      <div className="text-muted-foreground">Positions</div>
                    </div>
                  </div>
                </Card>

                {/* Performance */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <BarChart2 className="w-4 h-4 text-violet-500" />
                    Performance
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{stats.performance.avgCycleTimeMs}ms</div>
                      <div className="text-muted-foreground">Cycle Time</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{stats.performance.successRatePercent.toFixed(1)}%</div>
                      <div className="text-muted-foreground">Success Rate</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.realtime.strategyCycles)}</div>
                      <div className="text-muted-foreground">Strat. Cycles</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className={`font-semibold ${stats.performance.hasErrors ? "text-red-600" : "text-green-600"}`}>
                        {stats.performance.hasErrors ? "Yes" : "None"}
                      </div>
                      <div className="text-muted-foreground">Errors</div>
                    </div>
                  </div>
                </Card>
              </>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-12">Starting engine monitor...</p>
            )}
          </TabsContent>

          {/* ── Historic detail ── */}
          <TabsContent value="historic" className="mt-3 flex-1 overflow-y-auto">
            <Card className="p-4 space-y-3">
              {stats ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Database className="w-4 h-4 text-blue-500" />
                      Detailed Historic Status
                    </div>
                    <Badge variant={stats.historic.isLoaded ? "default" : "secondary"}>
                      {stats.historic.isLoaded ? "COMPLETE" : "IN PROGRESS"}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm">
                      <span>Overall Progress</span>
                      <span className="font-medium">{stats.historic.progressPercent}%</span>
                    </div>
                    <Progress value={stats.historic.progressPercent} className="h-2.5" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
                    {[
                      { label: "Symbols Processed",  value: `${stats.historic.symbolsLoaded} / ${stats.historic.symbolsTotal}` },
                      { label: "Candles Loaded",      value: stats.historic.candlesProcessed.toLocaleString() },
                      { label: "Historic Cycles",     value: stats.historic.cyclesCompleted.toLocaleString() },
                      { label: "Status",              value: stats.historic.isLoaded ? "Complete" : "Loading..." },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between border-b border-border/50 pb-1.5">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium">{value}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-center text-sm text-muted-foreground py-8">Waiting for historic data...</p>
              )}
            </Card>
          </TabsContent>

          {/* ── Breakdown ── */}
          <TabsContent value="breakdown" className="mt-3 space-y-3 flex-1 overflow-y-auto">
            {stats ? (
              <>
                <Card className="p-4 space-y-2">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Activity className="w-4 h-4 text-violet-500" />
                    Indications by Type
                  </div>
                  <div className="space-y-2 text-xs">
                    {Object.entries(stats.breakdown.indications).map(([type, count]) => {
                      const total = Object.values(stats.breakdown.indications).reduce((s, v) => s + v, 0) || 1
                      return (
                        <div key={type} className="space-y-0.5">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{type}</span>
                            <span className="font-medium tabular-nums">{fmt(count)}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-violet-500 rounded-full"
                              style={{ width: `${Math.min(100, (count / total) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </Card>

                <Card className="p-4 space-y-2">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    Strategies — Pipeline Stages (cascade filter)
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Base → Main → Real → Live is <em>eval → filter → adjust → promote</em>. Each stage counts the
                    SAME strategies that survived the previous filter — do not add the four values together. The
                    canonical &quot;total strategies&quot; is the Real-stage count.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center text-xs">
                    {[
                      { label: "Base (eval)",   value: stats.breakdown.strategies.base, bg: "bg-orange-50 dark:bg-orange-950/30", txt: "text-orange-700 dark:text-orange-400" },
                      { label: "Main (filter)", value: stats.breakdown.strategies.main, bg: "bg-yellow-50 dark:bg-yellow-950/30", txt: "text-yellow-700 dark:text-yellow-400" },
                      { label: "Real (adjust)", value: stats.breakdown.strategies.real, bg: "bg-green-50 dark:bg-green-950/30",  txt: "text-green-700 dark:text-green-400" },
                      { label: "Live (promoted)", value: (stats.breakdown.strategies as any).live || 0, bg: "bg-amber-50 dark:bg-amber-950/30", txt: "text-amber-700 dark:text-amber-400" },
                    ].map(({ label, value, bg, txt }) => (
                      <div key={label} className={`rounded ${bg} p-2`}>
                        <div className={`text-lg font-bold tabular-nums ${txt}`}>{fmt(value)}</div>
                        <div className="text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-8">Waiting for breakdown data...</p>
            )}
          </TabsContent>

          {/* ── Live Log ── */}
          <TabsContent value="logs" className="mt-3 flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-1 py-1.5 mb-2">
              <span className="text-xs text-muted-foreground">{logs.length} entries</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={fetchStats} disabled={isPolling}>
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
            <ScrollArea className="flex-1 rounded border">
              <div className="p-2 space-y-0.5">
                {logs.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground py-8">No events yet.</p>
                ) : (
                  [...logs].reverse().map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs p-1.5 rounded hover:bg-muted/40">
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      {getLogBadge(log.type)}
                      <span className="flex-1 break-words">{log.message}</span>
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
