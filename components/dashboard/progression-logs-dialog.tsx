"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Loader2, Zap, TrendingUp, Clock, AlertCircle, RefreshCw, Trash2, Database, Activity } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { IndicationsDetail } from "@/components/dashboard/indications-detail"
import { StrategyPipeline } from "@/components/dashboard/strategy-pipeline"

// ─── interfaces ────────────────────────────────────────────────────────────────

interface ProgressionLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
  progression?: any
}

interface ProgressionLog {
  timestamp: string
  level: string
  phase: string
  message: string
  details?: any
}

// Stats shape from /stats endpoint
interface StatsShape {
  historic: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    cyclesCompleted: number
    isComplete: boolean
    progressPercent: number
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    realtimeCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    isActive: boolean
    successRate: number
    avgCycleTimeMs: number
  }
  breakdown: {
    indications: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
    strategies: { base: number; main: number; real: number; live: number; total: number; baseEvaluated: number; mainEvaluated: number; realEvaluated: number }
  }
  // ── Active-now snapshot ────────────────────────────────────────
  // Two equivalent sources are accepted, in priority order:
  //   1. `activeCounts.{indications,strategies}` — the fast per-cycle
  //      accumulator written by indication-sets-processor and
  //      strategy-coordinator (same block consumed by
  //      `statistics-overview-v2`).
  //   2. `activeProgressing.*.total.sets` — the explicit per-name
  //      rollup; used as a fallback so older API revs still surface
  //      a non-zero "alive now" number.
  activeCounts?: {
    indications?: { direction?: number; move?: number; active?: number; optimal?: number; total?: number }
    strategies?:  { base?: number; main?: number; real?: number; total?: number }
  }
  activeProgressing?: {
    indications?: Record<string, { sets?: number; trackings?: number; positions?: number }>
    strategies?:  Record<string, { sets?: number; trackings?: number; positions?: number }>
  }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string }
  // Legacy fields from /logs for trading activity
  progressionState?: {
    totalTrades?: number
    successfulTrades?: number
    tradeSuccessRate?: number
    totalProfit?: number
    processingCompleteness?: {
      prehistoricLoaded?: boolean
      indicationsRunning?: boolean
      strategiesRunning?: boolean
      realtimeRunning?: boolean
    }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function ProgressionLogsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
}: ProgressionLogsDialogProps) {
  const [logs, setLogs] = useState<ProgressionLog[]>([])
  const [stats, setStats] = useState<StatsShape | null>(null)
  const [tradingState, setTradingState] = useState<StatsShape["progressionState"] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<"log" | "info" | "breakdown" | "indications" | "strategies">("log")
  // Category filter for the log list — "all" by default, otherwise by level
  const [logFilter, setLogFilter] = useState<"all" | "info" | "warning" | "error" | "debug">("all")

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      // Primary: /stats endpoint (canonical historic + realtime + breakdown)
      // Secondary: /logs endpoint (for actual log entries + trading activity from progressionState)
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (statsRes.ok) setStats(await statsRes.json())

      if (logsRes.ok) {
        const logsData = await logsRes.json()
        const logsArr: ProgressionLog[] = (logsData.logs || logsData.recentLogs || []).slice(0, 150)
        setLogs(logsArr)
        // Trading activity fields come from /logs progressionState
        if (logsData.progressionState) {
          setTradingState(logsData.progressionState)
        }
      }
    } catch {
      // non-critical
    } finally {
      setIsLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (!open) return
    loadData()
    // Tier-1 perf: visibility-gated polling. Hidden tab = no fetches.
    let cancelled = false
    const interval = setInterval(() => {
      if (cancelled) return
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      loadData()
    }, 2000)
    const onVisibility = () => {
      if (!cancelled && typeof document !== "undefined" && document.visibilityState === "visible") loadData()
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      clearInterval(interval)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [open, loadData])

  const handleClearLogs = async () => {
    if (!confirm("Clear all logs for this connection?")) return
    try {
      const res = await fetch(`/api/connections/progression/${connectionId}/logs`, { method: "DELETE" })
      if (res.ok) {
        setLogs([])
        toast.success("Logs cleared")
      } else {
        toast.error("Failed to clear logs")
      }
    } catch {
      toast.error("Failed to clear logs")
    }
  }

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n)

  const levelCls = (level: string) => {
    switch (level?.toLowerCase()) {
      case "error":   return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400"
      case "warning": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400"
      case "debug":   return "bg-muted text-muted-foreground"
      default:        return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-400"
    }
  }

  const rt = stats?.realtime
  const h  = stats?.historic
  const bd = stats?.breakdown
  // Active-now derived numbers — single source of truth for both the
  // headline "Active Now" card and the inline breakdown headers. The
  // helper falls through `activeCounts` → `activeProgressing` → 0
  // so the dialog renders deterministically across API revs.
  const ac = stats?.activeCounts
  const ap = stats?.activeProgressing
  const activeIndications = {
    direction: Number(ac?.indications?.direction) || Number(ap?.indications?.direction?.sets) || 0,
    move:      Number(ac?.indications?.move)      || Number(ap?.indications?.move?.sets)      || 0,
    active:    Number(ac?.indications?.active)    || Number(ap?.indications?.active?.sets)    || 0,
    optimal:   Number(ac?.indications?.optimal)   || Number(ap?.indications?.optimal?.sets)   || 0,
    total:     Number(ac?.indications?.total)     || Number(ap?.indications?.total?.sets)     || 0,
  }
  const activeStrategies = {
    base:  Number(ac?.strategies?.base)  || Number(ap?.strategies?.base?.sets)  || 0,
    main:  Number(ac?.strategies?.main)  || Number(ap?.strategies?.main?.sets)  || 0,
    real:  Number(ac?.strategies?.real)  || Number(ap?.strategies?.real?.sets)  || 0,
    total: Number(ac?.strategies?.total) || Number(ap?.strategies?.total?.sets) || 0,
  }

  // MUST stay in sync with `DEFAULT_LIMITS` in `lib/indication-sets-processor.ts`
  // and the breakdown shape returned by `/api/connections/progression/[id]/stats`.
  // Each type tracks its own independent count via `indications_{type}_count`.
  const indTypes = [
    { label: "Direction",  value: bd?.indications.direction      || 0 },
    { label: "Move",       value: bd?.indications.move           || 0 },
    { label: "Active",     value: bd?.indications.active         || 0 },
    { label: "Active Adv", value: (bd?.indications as any)?.activeAdvanced || 0 },
    { label: "Optimal",    value: bd?.indications.optimal        || 0 },
    { label: "Auto",       value: bd?.indications.auto           || 0 },
  ]
  const totalIndByType = indTypes.reduce((s, r) => s + r.value, 0) || 1

  // ── Header status pills ────────────────────────────────────────
  // Shows engine state, cycle counter and "alive now" indications/
  // strategies on a single line so the operator gets the most
  // important state-of-the-world signals at a glance, even before
  // diving into a tab.
  const isEngineLive = rt?.isActive
  const totalCycles  = (rt?.indicationCycles || 0) + (rt?.strategyCycles || 0) + (rt?.realtimeCycles || 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[82vh] overflow-hidden flex flex-col p-0">
        {/* Header — modernized: brand mark + name + status pills */}
        <DialogHeader className="px-5 pt-4 pb-3 border-b">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 shrink-0">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold truncate">
                {connectionName} <span className="text-muted-foreground font-normal">— Engine Progression</span>
              </DialogTitle>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <Badge
                  variant={isEngineLive ? "default" : "outline"}
                  className={`text-[10px] h-4 px-1.5 gap-1 ${isEngineLive ? "bg-green-600 hover:bg-green-600" : ""}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isEngineLive ? "bg-white animate-pulse" : "bg-muted-foreground"}`} />
                  {isEngineLive ? "Live" : "Idle"}
                </Badge>
                {totalCycles > 0 && (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 tabular-nums">
                    {fmt(totalCycles)} cycles
                  </Badge>
                )}
                {activeIndications.total > 0 && (
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 tabular-nums">
                    {fmt(activeIndications.total)} ind alive
                  </Badge>
                )}
                {activeStrategies.total > 0 && (
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 tabular-nums">
                    {fmt(activeStrategies.total)} strat alive
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="mx-5 mt-3 grid grid-cols-5 h-9">
            <TabsTrigger value="log" className="text-xs">Logs</TabsTrigger>
            <TabsTrigger value="info" className="text-xs">Info</TabsTrigger>
            <TabsTrigger value="breakdown" className="text-xs">Breakdown</TabsTrigger>
            <TabsTrigger value="indications" className="text-xs">Indications</TabsTrigger>
            <TabsTrigger value="strategies" className="text-xs">Strategies</TabsTrigger>
          </TabsList>

          {/* ── Logs ── */}
          <TabsContent value="log" className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {logs.length} entries {isLoading && "(updating...)"}
                </span>
                {/* Live auto-refresh indicator */}
                <Badge variant="outline" className="text-[10px] gap-1 h-5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                  </span>
                  2s
                </Badge>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {/* Category filter */}
                {(["all", "info", "warning", "error", "debug"] as const).map((f) => (
                  <Button
                    key={f}
                    variant={logFilter === f ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setLogFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </Button>
                ))}
                <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading} className="h-6 w-6 p-0">
                  <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="outline" size="sm" onClick={handleClearLogs} disabled={logs.length === 0} className="h-6 w-6 p-0">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1">
              {isLoading && logs.length === 0 ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
                  <AlertCircle className="w-5 h-5" />
                  <span className="text-sm">No logs yet. Enable connection to start logging.</span>
                </div>
              ) : (
                <div className="space-y-px p-3">
                  {logs
                    .filter(l => logFilter === "all" || (l.level || "info").toLowerCase() === logFilter)
                    .map((log, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[auto_auto_auto_1fr] gap-2 text-xs p-2 rounded hover:bg-muted/40"
                    >
                      <span className="text-muted-foreground min-w-fit whitespace-nowrap">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      <Badge className={`${levelCls(log.level)} text-[10px] h-4 px-1`} variant="outline">
                        {log.level?.toUpperCase()}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] h-4 px-1 min-w-fit">
                        {log.phase}
                      </Badge>
                      <span className="break-words">{log.message}</span>
                      {log.details && (
                        <div className="col-span-4 mt-0.5 p-1.5 rounded bg-muted/30 font-mono text-[10px]">
                          <pre className="overflow-auto max-h-20">{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* ── Info ── */}
          <TabsContent value="info" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4">
                {/*
                  Active Now — headline "alive in this cycle" tiles.
                  Renders only when the engine is running so the card
                  doesn't add noise to a stopped connection. Sub-line
                  shows the cumulative-since-run-start number for
                  context, identical pattern to the breakdown headers
                  and to statistics-overview-v2's headline strip.
                */}
                {(rt?.isActive || activeIndications.total > 0 || activeStrategies.total > 0) && (
                  <div className="rounded-lg border p-4 space-y-3 border-primary/20 bg-primary/5">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-primary" />
                      <h3 className="font-semibold">Active Now</h3>
                      <Badge variant="default" className="ml-auto text-[10px] h-5">LIVE</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div
                        className="p-3 rounded-lg bg-violet-50 dark:bg-violet-950/40"
                        title={
                          `Indications passing thresholds this cycle: ${fmt(activeIndications.total)}\n` +
                          `Per-type alive: D=${fmt(activeIndications.direction)} M=${fmt(activeIndications.move)} A=${fmt(activeIndications.active)} O=${fmt(activeIndications.optimal)}\n` +
                          `Cumulative since run start: ${fmt(rt?.indicationsTotal || 0)}`
                        }
                      >
                        <div className="text-2xl font-bold tabular-nums text-violet-700 dark:text-violet-400 flex items-baseline gap-1.5">
                          {fmt(activeIndications.total)}
                          <span className="text-[11px] font-normal text-muted-foreground">
                            / {fmt(rt?.indicationsTotal || 0)} total
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">Indications (alive)</div>
                        <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                          D {fmt(activeIndications.direction)} ·
                          M {fmt(activeIndications.move)} ·
                          A {fmt(activeIndications.active)} ·
                          O {fmt(activeIndications.optimal)}
                        </div>
                      </div>
                      <div
                        className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40"
                        title={
                          `Strategy Sets alive across Base + Main + Real this cycle: ${fmt(activeStrategies.total)}\n` +
                          `Per-stage alive: B=${fmt(activeStrategies.base)} M=${fmt(activeStrategies.main)} R=${fmt(activeStrategies.real)}\n` +
                          `Cumulative Real-stage Sets since run start: ${fmt(rt?.strategiesTotal || 0)}`
                        }
                      >
                        <div className="text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400 flex items-baseline gap-1.5">
                          {fmt(activeStrategies.total)}
                          <span className="text-[11px] font-normal text-muted-foreground">
                            / {fmt(rt?.strategiesTotal || 0)} total
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">Strategies (alive)</div>
                        <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                          B {fmt(activeStrategies.base)} ·
                          M {fmt(activeStrategies.main)} ·
                          R {fmt(activeStrategies.real)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Engine Cycles — from realtime section of /stats */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    <h3 className="font-semibold">Engine Cycles</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Indication Cycles", value: fmt(rt?.indicationCycles || 0), cls: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
                      { label: "Strategy Cycles",   value: fmt(rt?.strategyCycles   || 0), cls: "text-green-700 dark:text-green-400",   bg: "bg-green-50 dark:bg-green-950" },
                      { label: "Realtime Cycles",   value: fmt(rt?.realtimeCycles   || 0), cls: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
                      { label: "Success Rate",      value: `${(rt?.successRate || 0).toFixed(1)}%`, cls: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Historic Data — from historic section of /stats */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    <h3 className="font-semibold">Historical Data</h3>
                    <Badge
                      variant={h?.isComplete ? "default" : "secondary"}
                      className="ml-auto text-[11px]"
                    >
                      {h?.isComplete ? "Loaded" : "Pending"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{h?.symbolsProcessed || 0} / {h?.symbolsTotal || 0} symbols</span>
                      <span>{h?.progressPercent || 0}%</span>
                    </div>
                    <Progress value={h?.progressPercent || 0} className="h-1.5" />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Symbols",        value: fmt(h?.symbolsProcessed || 0), cls: "text-sky-700 dark:text-sky-400",     bg: "bg-sky-50 dark:bg-sky-950" },
                      { label: "Candles",        value: fmt(h?.candlesLoaded    || 0), cls: "text-teal-700 dark:text-teal-400",   bg: "bg-teal-50 dark:bg-teal-950" },
                      { label: "Preh. Cycles",   value: fmt(h?.cyclesCompleted  || 0), cls: "text-indigo-700 dark:text-indigo-400", bg: "bg-indigo-50 dark:bg-indigo-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg} text-center`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trading Activity — from /logs progressionState */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    <h3 className="font-semibold">Trading Activity</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total Trades",  value: fmt(tradingState?.totalTrades     || 0), cls: "text-slate-700 dark:text-slate-400",   bg: "bg-slate-50 dark:bg-slate-900" },
                      { label: "Profitable",    value: fmt(tradingState?.successfulTrades || 0), cls: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
                      { label: "Win Rate",      value: `${(tradingState?.tradeSuccessRate || 0).toFixed(1)}%`, cls: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950" },
                      { label: "Total Profit",  value: `$${(tradingState?.totalProfit || 0).toFixed(2)}`, cls: "text-cyan-700 dark:text-cyan-400", bg: "bg-cyan-50 dark:bg-cyan-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-muted-foreground text-center">
                  Refreshes every 2s &bull; {new Date().toLocaleTimeString()}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── Breakdown ── */}
          <TabsContent value="breakdown" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4">
                {/* Indications by type — from /stats breakdown.indications */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-violet-500" />
                    <h3 className="font-semibold">Indications by Type</h3>
                    {/*
                      Header shows BOTH numbers so the operator sees
                      what's alive right now (left, accent color)
                      versus what was cumulatively seen since run
                      start (right, muted). Same pattern as
                      statistics-overview-v2 and engine-processing-log.
                    */}
                    <span
                      className="ml-auto text-xs flex items-center gap-1.5"
                      title={
                        `Active now (passing thresholds this cycle): ${fmt(activeIndications.total)}\n` +
                        `Cumulative since run start: ${fmt(bd?.indications.total || rt?.indicationsTotal || 0)}`
                      }
                    >
                      <span className="text-violet-600 dark:text-violet-400 font-semibold tabular-nums">
                        {fmt(activeIndications.total)}
                      </span>
                      <span className="text-muted-foreground">alive</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="text-muted-foreground tabular-nums">
                        {fmt(bd?.indications.total || rt?.indicationsTotal || 0)} total
                      </span>
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {indTypes.map(({ label, value }) => (
                      <div key={label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-medium tabular-nums">{fmt(value)}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-violet-500 rounded-full transition-all"
                            style={{ width: `${Math.min(100, (value / totalIndByType) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Strategies by stage — from /stats breakdown.strategies
                    Base → Main → Real → Live is a CASCADE FILTER (eval → filter
                    → adjust). Each stage counts the SAME logical strategy as it
                    survives the previous filter. The header "Total" shows the
                    Real-stage output only (the canonical strategy count) —
                    never Base+Main+Real summed. */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    <h3 className="font-semibold">Strategies — Pipeline Stages</h3>
                    {/*
                      Header shows alive Sets across the active stages
                      (Base + Main + Real, summed by the engine writer
                      itself — NOT a UI sum) versus the cumulative
                      Real-stage output. Same paired layout as the
                      Indications header above.
                    */}
                    <span
                      className="ml-auto text-xs flex items-center gap-1.5"
                      title={
                        `Active Sets across stages right now: ${fmt(activeStrategies.total)}\n` +
                        `Per-stage alive: B=${fmt(activeStrategies.base)} M=${fmt(activeStrategies.main)} R=${fmt(activeStrategies.real)}\n` +
                        `Cumulative final-stage (Real) Sets since run start: ${fmt(bd?.strategies.total || rt?.strategiesTotal || 0)}`
                      }
                    >
                      <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                        {fmt(activeStrategies.total)}
                      </span>
                      <span className="text-muted-foreground">alive</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="text-muted-foreground tabular-nums">
                        {fmt(bd?.strategies.total || rt?.strategiesTotal || 0)} final
                      </span>
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground -mt-1">
                    Cascade filter: Base → Main → Real → Live. Stages are NOT added together —
                    each value is the count of the SAME strategies that survived the previous filter.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center text-xs">
                    {[
                      { label: "Base", value: bd?.strategies.base || 0, eval: bd?.strategies.baseEvaluated || 0, cls: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
                      { label: "Main", value: bd?.strategies.main || 0, eval: bd?.strategies.mainEvaluated || 0, cls: "text-yellow-700 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-950" },
                      { label: "Real", value: bd?.strategies.real || 0, eval: bd?.strategies.realEvaluated || 0, cls: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
                      // Live = exchange-side tracked locally (no exchange-history fetch)
                      { label: "Live", value: bd?.strategies.live || 0, eval: 0,                                   cls: "text-amber-700 dark:text-amber-400",  bg: "bg-amber-50 dark:bg-amber-950" },
                    ].map(({ label, value, eval: evaluated, cls, bg }) => (
                      <div key={label} className={`rounded-lg ${bg} p-3`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{fmt(value)}</div>
                        <div className="text-muted-foreground">{label}</div>
                        {evaluated > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">{fmt(evaluated)} passed</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Processing completeness */}
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="text-sm font-semibold">Processing Status</div>
                  <div className="space-y-1.5 text-xs">
                    {[
                      { label: "Historic Data Loaded",  done: h?.isComplete },
                      { label: "Indications Running",    done: (rt?.indicationCycles || 0) > 0 },
                      { label: "Strategies Running",     done: (rt?.strategyCycles   || 0) > 0 },
                      { label: "Realtime Active",        done: rt?.isActive },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <Badge variant={done ? "default" : "secondary"} className="text-[10px] h-5 px-1.5">
                          {done ? "Yes" : "No"}
                        </Badge>
                      </div>
                    ))}
                  </div>

                  {(rt?.successRate || 0) > 0 && (
                    <div className="pt-2 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Cycle Success Rate</span>
                        <span className="font-medium">{(rt?.successRate || 0).toFixed(1)}%</span>
                      </div>
                      <Progress value={rt?.successRate || 0} className="h-1.5" />
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── Indications detail ── */}
          <TabsContent value="indications" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <IndicationsDetail connectionId={connectionId} />
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── Strategies pipeline ── */}
          <TabsContent value="strategies" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <StrategyPipeline connectionId={connectionId} />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
