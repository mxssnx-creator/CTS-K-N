"use client"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  FileText, Activity, BarChart3, RefreshCw, Database,
  Zap, TrendingUp, Clock, ChevronDown, ChevronUp, CheckCircle2, Circle,
} from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface StratDetail {
  avgPosPerSet: number; createdSets: number; avgProfitFactor: number
  avgProcessingTimeMs: number; evalPct: number
  // Optional cross-stage evaluation counters (used by the Live StratCard
  // to show ordersFilled / ordersPlaced as a fallback when liveExecution
  // is not yet populated).
  passed?: number; evaluated?: number
  // Live-only extras (optional on base/main/real)
  winRate?: number; totalPnl?: number; avgPnl?: number
  openPositions?: number; volumeUsdTotal?: number
}

interface LiveExecution {
  ordersPlaced: number; ordersFilled: number; ordersFailed: number
  ordersRejected: number; ordersSimulated: number
  positionsCreated: number; positionsClosed: number; positionsOpen: number
  wins: number
  /** Cumulative leveraged notional (qty × price). Legacy; the UI now
   *  prefers `marginUsdTotal` for any "USDT" display. */
  volumeUsdTotal: number
  /** Cumulative used balance (margin = notional / leverage). */
  marginUsdTotal?: number
  fillRate: number; winRate: number
}

interface StatsResponse {
  historic: {
    symbolsProcessed: number; symbolsTotal: number; candlesLoaded: number
    indicatorsCalculated: number; cyclesCompleted: number; isComplete: boolean; progressPercent: number
    processing?: { indicationChurnCycles: number; strategyChurnCycles: number }
  }
  realtime: {
    indicationCycles: number; strategyCycles: number; realtimeCycles: number
    indicationsTotal: number; strategiesTotal: number; positionsOpen: number
    isActive: boolean; successRate: number; avgCycleTimeMs: number
    // Per-processor cycle counters. Each processor maintains TWO counters:
    //   - <name>      : every tick (incl. idle / empty / gated)
    //   - <name>Live  : only ticks that produced real work
    cycleCounters?: {
      indication: number; indicationLive: number
      strategy: number;   strategyLive: number
      realtime: number;   realtimeLive: number
    }
    // Cumulative tick total across ALL processors. Independent of the
    // per-Set 250-entry DB cap. Equivalent to "Frames / Total Ticks".
    framesProcessed?: number
  }
  breakdown: {
    // Each indication TYPE counted independently. `activeAdvanced` was
    // previously missing from this shape despite the engine generating it.
    indications: {
      direction:      number
      move:           number
      active:         number
      activeAdvanced: number
      optimal:        number
      auto:           number
      total:          number
    }
    strategies: { base: number; main: number; real: number; live: number; total: number
                  baseEvaluated: number; mainEvaluated: number; realEvaluated: number }
  }
  strategyDetail: { base: StratDetail; main: StratDetail; real: StratDetail; live?: StratDetail }
  liveExecution?: LiveExecution
  windows: { indications: { last5m: number; last60m: number }; strategies: { last5m: number; last60m: number } }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string; lastUpdate: string }
}

interface LogEntry {
  timestamp: Date; level: "info" | "success" | "warning" | "error"
  message: string; phase?: string; details?: any
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function levelCls(level: string) {
  switch (level) {
    case "error":   return "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/60"
    case "warning": return "text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/60"
    case "success": return "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/60"
    default:        return "text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/60"
  }
}

function Row({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[11px] py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

function SectionCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border p-3 space-y-2 ${className}`}>
      {children}
    </div>
  )
}

// ─── StratCard ────────────────────────────────────────────────────────────────

function StratCard({
  label, count, evaluated, evaluatedOf, detail, accentCls, bgCls,
}: {
  label: string; count: number; evaluated: number; evaluatedOf: number
  detail?: StratDetail; accentCls: string; bgCls: string
}) {
  const evalPct = evaluatedOf > 0
    ? Math.round((evaluated / evaluatedOf) * 1000) / 10
    : (detail?.evalPct ?? 0)

  return (
    <div className={`rounded-md border p-2.5 space-y-2 ${bgCls}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold ${accentCls}`}>{label}</span>
        <span className={`text-xl font-bold tabular-nums ${accentCls}`}>{fmt(count)}</span>
      </div>

      {evaluatedOf > 0 && (
        <div className="space-y-0.5">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>% eval of {label === "Main" ? "Base" : "Main"}</span>
            <span className="font-medium">{evalPct.toFixed(1)}%</span>
          </div>
          <Progress value={Math.min(100, evalPct)} className="h-1" />
          <div className="text-[9px] text-muted-foreground text-right">
            {fmt(evaluated)} / {fmt(evaluatedOf)}
          </div>
        </div>
      )}

      {detail && (
        <div className="divide-y divide-border/40 text-[10px]">
          {detail.createdSets > 0 && <Row label="Created Sets"     value={fmt(detail.createdSets)} />}
          {detail.avgPosPerSet > 0 && <Row label="Avg Pos/Set"     value={detail.avgPosPerSet.toFixed(2)} />}
          {detail.avgProfitFactor > 0 && <Row label="Avg Prof Factor" value={detail.avgProfitFactor.toFixed(3)} />}
          {detail.avgProcessingTimeMs > 0 && <Row label="Avg Proc Time"  value={`${detail.avgProcessingTimeMs.toFixed(1)}ms`} />}
        </div>
      )}
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

export function QuickstartComprehensiveLogDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const activeConnectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || activeConnectionId

  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [expandedLog, setExpandedLog] = useState<number | null>(null)
  const [logFilter, setLogFilter] = useState<"all" | "info" | "success" | "warning" | "error">("all")
  const logsEndRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const fetchData = useCallback(async (silent = false) => {
    if (!activeConnectionId) return
    if (!silent) setIsLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${activeConnectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${activeConnectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (statsRes.ok) setStats(await statsRes.json())

      if (logsRes.ok) {
        const data = await logsRes.json()
        const rawLogs = data.logs || data.recentLogs || []
        setLogs(rawLogs.slice(0, 200).map((log: any) => ({
          timestamp: new Date(log.timestamp || Date.now()),
          level: (["error","warning","success"].includes(log.level) ? log.level : "info") as LogEntry["level"],
          message: log.message || "",
          phase: log.phase || "",
          details: log.details,
        })))
      }
    } catch { /* non-critical */ }
    finally { if (!silent) setIsLoading(false) }
  }, [activeConnectionId])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!open) return
    fetchData()
    // Tier-1 perf: pause the 2s poll when the tab is hidden. On
    // re-foreground we fire a single immediate catch-up tick so the
    // first paint shows fresh data.
    let cancelled = false
    pollRef.current = setInterval(() => {
      if (cancelled) return
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      fetchData(true)
    }, 2000)
    const onVisibility = () => {
      if (!cancelled && typeof document !== "undefined" && document.visibilityState === "visible") fetchData(true)
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      clearInterval(pollRef.current)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [open, fetchData])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  const rt  = stats?.realtime
  const h   = stats?.historic
  const bd  = stats?.breakdown
  const sd  = stats?.strategyDetail
  const win = stats?.windows
  const meta = stats?.metadata

  // Indication types — MUST stay in sync with `DEFAULT_LIMITS` in
  // `lib/indication-sets-processor.ts`. Each type has its own independent
  // counter on `progression:{connId}`. Each is its own column in the
  // breakdown so the operator can see contributions per type at a glance.
  const indTypes = [
    { label: "Direction",  key: "direction"      as const },
    { label: "Move",       key: "move"           as const },
    { label: "Active",     key: "active"         as const },
    { label: "Active Adv", key: "activeAdvanced" as const },
    { label: "Optimal",    key: "optimal"        as const },
    { label: "Auto",       key: "auto"           as const },
  ]
  const totalIndByType = indTypes.reduce((s, { key }) => s + (bd?.indications[key] ?? 0), 0) || 1
  const totalIndAll = rt?.indicationsTotal || bd?.indications.total || 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1">
          <FileText className="w-3.5 h-3.5" />
          Logs & Data
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Activity className="w-4 h-4" />
            Engine Data & Logs
            {connectionLabel && (
              <Badge variant="secondary" className="text-[10px] font-normal">{connectionLabel}</Badge>
            )}
            {meta?.engineRunning && <Badge className="bg-green-600 text-[10px] h-4 px-1.5">Running</Badge>}
            <Button size="icon" variant="ghost" className="ml-auto h-6 w-6"
              onClick={() => fetchData()} disabled={isLoading}>
              <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          {meta?.phase && meta.phase !== "—" && (
            <p className="text-[10px] text-muted-foreground mt-0.5 capitalize">
              Phase: {meta.phase.replace(/_/g, " ")}
              {meta.message ? ` — ${meta.message}` : ""}
            </p>
          )}
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 grid grid-cols-4 h-8 rounded-none border-b bg-transparent px-4">
            {["overview","indications","strategies","logs"].map(tab => (
              <TabsTrigger key={tab} value={tab}
                className="text-[11px] capitalize h-7 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── Overview ─────────────────────────────────────────────────── */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto p-4 space-y-3">
            {!stats ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                Loading data for {connectionLabel}…
              </div>
            ) : (
              <>
                {/* Prehistoric (rendered FIRST — the engine loads historic
                    data before running any live cycles, so the dashboard's
                    vertical order should match the actual processing order.
                    Previously the live "Key counters" grid was shown above
                    this card, which hid the historic context on open). */}
                <SectionCard className="bg-blue-50/30 dark:bg-blue-950/20">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Database className="w-3.5 h-3.5 text-blue-500" />
                    Historical Processing
                    {h?.isComplete
                      ? <Badge className="bg-green-600 hover:bg-green-600 text-white text-[10px] h-4 px-1.5 ml-auto">Loaded</Badge>
                      : <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto tabular-nums">{h?.progressPercent || 0}%</Badge>
                    }
                  </div>
                  {!h?.isComplete && <Progress value={h?.progressPercent || 0} className="h-1.5" />}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-center text-[10px]">
                    <div className="rounded bg-muted/50 p-1.5">
                      <div className="font-bold text-sm tabular-nums">
                        {h?.symbolsProcessed || 0}
                        <span className="text-muted-foreground font-normal">/{h?.symbolsTotal || 0}</span>
                      </div>
                      <div className="text-muted-foreground">Symbols</div>
                    </div>
                    <div className="rounded bg-muted/50 p-1.5">
                      <div className="font-bold text-sm tabular-nums">{fmt(h?.candlesLoaded || 0)}</div>
                      <div className="text-muted-foreground">Candles</div>
                    </div>
                    <div className="rounded bg-muted/50 p-1.5">
                      <div className="font-bold text-sm tabular-nums">{fmt(h?.indicatorsCalculated || 0)}</div>
                      <div className="text-muted-foreground">Indicators</div>
                    </div>
                    <div className="rounded bg-muted/50 p-1.5">
                      <div className="font-bold text-sm tabular-nums">{fmt(h?.cyclesCompleted || 0)}</div>
                      <div className="text-muted-foreground">P-Cycles</div>
                    </div>
                  </div>
                </SectionCard>

                {/* Live Key counters (AFTER historical). */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[
                    { label: "Ind Cycles",  value: fmt(rt?.indicationCycles || 0), color: "text-blue-600 dark:text-blue-400" },
                    { label: "Indications", value: fmt(rt?.indicationsTotal  || 0), color: "text-violet-600 dark:text-violet-400" },
                    { label: "Strategies",  value: fmt(rt?.strategiesTotal   || 0), color: "text-amber-600 dark:text-amber-400" },
                    { label: "Positions",   value: fmt(rt?.positionsOpen     || 0), color: "text-green-600 dark:text-green-400" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="rounded-md bg-muted/60 p-2.5 text-center">
                      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>

                {/* Live metrics + windows */}
                <SectionCard>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                    Live Processing
                    {rt?.isActive && <Badge className="bg-blue-600 text-[9px] h-4 px-1.5 ml-auto">Active</Badge>}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                    <Row label="Indication Cycles" value={fmt(rt?.indicationCycles || 0)} />
                    <Row label="Strategy Cycles"   value={fmt(rt?.strategyCycles   || 0)} />
                    <Row label="Realtime Cycles"   value={fmt(rt?.realtimeCycles   || 0)} />
                    <Row label="Success Rate"      value={`${(rt?.successRate || 0).toFixed(1)}%`} />
                    {(rt?.avgCycleTimeMs || 0) > 0 && (
                      <Row label="Avg Cycle Time"  value={`${rt!.avgCycleTimeMs}ms`} />
                    )}
                    {(win?.indications.last5m || 0) > 0 && (
                      <Row label="Ind (last 5m)"   value={fmt(win!.indications.last5m)} />
                    )}
                    {(win?.indications.last60m || 0) > 0 && (
                      <Row label="Ind (last 60m)"  value={fmt(win!.indications.last60m)} />
                    )}
                  </div>
                </SectionCard>

                {/* Processing flags */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {[
                    { label: "Historic Loaded",  done: h?.isComplete },
                    { label: "Indications Active", done: (rt?.indicationCycles || 0) > 0 },
                    { label: "Strategies Active",  done: (rt?.strategyCycles   || 0) > 0 },
                    { label: "Realtime Active",    done: rt?.isActive },
                  ].map(({ label, done }) => (
                    <div key={label}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full border ${
                        done
                          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
                          : "border-border bg-muted/30 text-muted-foreground"
                      }`}>
                      {done ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Circle className="w-2.5 h-2.5 opacity-30" />}
                      {label}
                    </div>
                  ))}
                </div>
              </>
            )}
          </TabsContent>

          {/* ── Indications ───────────────────────────────────────────────── */}
          <TabsContent value="indications" className="flex-1 overflow-y-auto p-4 space-y-3">
            {!stats ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading…</div>
            ) : (
              <>
                {/* window summary */}
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: "Total",    value: fmt(totalIndAll),                   color: "text-violet-600 dark:text-violet-400" },
                    { label: "Last 5m",  value: fmt(win?.indications.last5m || 0),  color: "text-blue-600 dark:text-blue-400" },
                    { label: "Last 60m", value: fmt(win?.indications.last60m || 0), color: "text-sky-600 dark:text-sky-400" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="rounded-md bg-muted/60 p-2 text-center">
                      <div className={`text-base font-bold tabular-nums ${color}`}>{value}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>

                {/* type breakdown with bars */}
                <SectionCard>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Activity className="w-3.5 h-3.5 text-violet-500" />
                    Types
                    <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                      {fmt(rt?.indicationCycles || 0)} cycles
                    </span>
                  </div>
                  <div className="space-y-2">
                    {indTypes.map(({ label, key }) => {
                      const val  = bd?.indications[key] ?? 0
                      const p    = Math.min(100, (val / totalIndByType) * 100)
                      const pct5m  = totalIndAll > 0 && (win?.indications.last5m  || 0) > 0
                        ? Math.round((val / totalIndAll) * (win!.indications.last5m))  : 0
                      const pct60m = totalIndAll > 0 && (win?.indications.last60m || 0) > 0
                        ? Math.round((val / totalIndAll) * (win!.indications.last60m)) : 0

                      return (
                        <div key={key} className="space-y-0.5">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-muted-foreground w-16 shrink-0">{label}</span>
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden mx-2">
                              <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${p}%` }} />
                            </div>
                            <span className="font-medium tabular-nums w-12 text-right">{fmt(val)}</span>
                          </div>
                          {(pct5m > 0 || pct60m > 0) && (
                            <div className="flex gap-3 text-[9px] text-muted-foreground pl-16">
                              {pct5m  > 0 && <span>5m: {fmt(pct5m)}</span>}
                              {pct60m > 0 && <span>60m: {fmt(pct60m)}</span>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </SectionCard>

                <SectionCard>
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                    Cycle Metrics
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {/*
                     * "Cycles" rows show TOTAL ticks per processor (incl. idle).
                     * "Live" rows (when present) show only ticks that produced
                     * real work — a meaningful "engine doing useful things"
                     * signal that's not skewed by warmup churn.
                     * Each processor type has its OWN counter — they are NOT
                     * the same number unless every tick was productive.
                     */}
                    <Row label="Indication Cycles" value={fmt(rt?.indicationCycles || 0)} />
                    <Row label="Strategy Cycles"   value={fmt(rt?.strategyCycles   || 0)} />
                    <Row label="Realtime Cycles"   value={fmt(rt?.realtimeCycles   || 0)} />
                    {rt?.cycleCounters && (
                      <>
                        <Row label="Indication Live" value={fmt(rt.cycleCounters.indicationLive || 0)} />
                        <Row label="Strategy Live"   value={fmt(rt.cycleCounters.strategyLive   || 0)} />
                        <Row label="Realtime Live"   value={fmt(rt.cycleCounters.realtimeLive   || 0)} />
                      </>
                    )}
                    {(rt?.framesProcessed || 0) > 0 && (
                      <Row label="Frames Processed" value={fmt(rt!.framesProcessed!)} />
                    )}
                    <Row label="Open Positions"    value={fmt(rt?.positionsOpen     || 0)} />
                    <Row label="Success Rate"      value={`${(rt?.successRate || 0).toFixed(1)}%`} />
                    {(rt?.avgCycleTimeMs || 0) > 0 && (
                      <Row label="Avg Cycle"       value={`${rt!.avgCycleTimeMs}ms`} />
                    )}
                  </div>
                </SectionCard>
              </>
            )}
          </TabsContent>

          {/* ── Strategies ────────────────────────────────────────────────── */}
          <TabsContent value="strategies" className="flex-1 overflow-y-auto p-4 space-y-3">
            {!stats ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading…</div>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Main strategies evaluate Base pseudo-position sets via pis-count and continuous-count factor
                  coordination — not necessarily new sets, but variable-mapped coordinations for high-frequency
                  processing. Real strategies are the highest-confidence subset of Main.
                </p>

                <StratCard
                  label="Base"
                  count={bd?.strategies.base || 0}
                  evaluated={bd?.strategies.baseEvaluated || 0}
                  evaluatedOf={0}
                  detail={sd?.base}
                  accentCls="text-orange-600 dark:text-orange-400"
                  bgCls="bg-orange-50/40 dark:bg-orange-950/20 border-orange-200/50 dark:border-orange-800/30"
                />

                <StratCard
                  label="Main"
                  count={bd?.strategies.main || 0}
                  evaluated={bd?.strategies.mainEvaluated || 0}
                  evaluatedOf={bd?.strategies.base || 0}
                  detail={sd?.main}
                  accentCls="text-yellow-600 dark:text-yellow-400"
                  bgCls="bg-yellow-50/40 dark:bg-yellow-950/20 border-yellow-200/50 dark:border-yellow-800/30"
                />

                <StratCard
                  label="Real"
                  count={bd?.strategies.real || 0}
                  evaluated={bd?.strategies.realEvaluated || 0}
                  evaluatedOf={bd?.strategies.main || 0}
                  detail={sd?.real}
                  accentCls="text-green-600 dark:text-green-400"
                  bgCls="bg-green-50/40 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/30"
                />

                {/* 4th tier — Live exchange execution. Mirrors Real's shape with extra metrics. */}
                <StratCard
                  label="Live"
                  count={bd?.strategies.live || stats?.liveExecution?.positionsCreated || 0}
                  evaluated={stats?.liveExecution?.ordersFilled || sd?.live?.passed || 0}
                  evaluatedOf={stats?.liveExecution?.ordersPlaced || sd?.live?.evaluated || 0}
                  detail={sd?.live}
                  accentCls="text-amber-600 dark:text-amber-400"
                  bgCls="bg-amber-50/40 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-800/30"
                />

                {/* Live Execution detail when present */}
                {stats?.liveExecution && (stats.liveExecution.ordersPlaced > 0 || stats.liveExecution.positionsCreated > 0) && (
                  <SectionCard className="bg-amber-50/30 border-amber-200/50 dark:bg-amber-950/10 dark:border-amber-800/30">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <TrendingUp className="w-3.5 h-3.5" />
                      Live Exchange Execution
                      {stats.liveExecution.positionsOpen > 0 && (
                        <Badge className="bg-green-600 text-[9px] h-4 px-1.5 ml-auto">{stats.liveExecution.positionsOpen} open</Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[11px]">
                      <Row label="Orders Placed"    value={fmt(stats.liveExecution.ordersPlaced)} />
                      <Row label="Orders Filled"    value={fmt(stats.liveExecution.ordersFilled)} />
                      <Row label="Positions Created" value={fmt(stats.liveExecution.positionsCreated)} />
                      <Row label="Positions Closed"  value={fmt(stats.liveExecution.positionsClosed)} />
                      <Row label="Fill Rate" value={`${stats.liveExecution.fillRate.toFixed(1)}%`} />
                      <Row label="Win Rate"  value={`${stats.liveExecution.winRate.toFixed(1)}%`} />
                      <Row label="Wins"      value={fmt(stats.liveExecution.wins)} />
                      {/* USDT row shows used-balance (margin), not the
                          leveraged notional. We fall back to the legacy
                          notional only when no margin counter exists. */}
                      <Row
                        label="USDT (used)"
                        value={(() => {
                          const v = stats.liveExecution.marginUsdTotal || stats.liveExecution.volumeUsdTotal
                          // Sub-dollar margins (high leverage on tiny
                          // notional) need 4-decimal precision so the
                          // operator can see cents committed instead
                          // of an apparent zero.
                          if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`
                          if (v >= 1)    return `$${v.toFixed(2)}`
                          if (v > 0)     return `$${v.toFixed(4)}`
                          return "$0.00"
                        })()}
                      />
                    </div>
                    {(stats.liveExecution.ordersRejected > 0 || stats.liveExecution.ordersFailed > 0 || stats.liveExecution.ordersSimulated > 0) && (
                      <div className="flex flex-wrap gap-1.5 text-[10px] pt-1 border-t">
                        {stats.liveExecution.ordersRejected > 0 && (
                          <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">Rejected: {stats.liveExecution.ordersRejected}</span>
                        )}
                        {stats.liveExecution.ordersFailed > 0 && (
                          <span className="px-2 py-0.5 rounded bg-red-100 text-red-800">Failed: {stats.liveExecution.ordersFailed}</span>
                        )}
                        {stats.liveExecution.ordersSimulated > 0 && (
                          <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800">Simulated: {stats.liveExecution.ordersSimulated}</span>
                        )}
                      </div>
                    )}
                  </SectionCard>
                )}

                <SectionCard>
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    Summary
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <Row label="Strategy Cycles" value={fmt(rt?.strategyCycles || 0)} />
                    <Row label="Final (Real)"    value={fmt(bd?.strategies.total || 0)} />
                    {(win?.strategies.last5m  || 0) > 0 && <Row label="Strat 5m"  value={fmt(win!.strategies.last5m)} />}
                    {(win?.strategies.last60m || 0) > 0 && <Row label="Strat 60m" value={fmt(win!.strategies.last60m)} />}
                    {(bd?.strategies.live || 0) > 0 && (
                      <Row label="Live" value={fmt(bd!.strategies.live)} />
                    )}
                  </div>
                </SectionCard>
              </>
            )}
          </TabsContent>

          {/* ── Logs ──────────────────────────────────────────────────────── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 p-4">
            <div className="flex items-center justify-between pb-2 shrink-0 gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {logs.length} entries {isLoading && "· updating…"}
              </span>
              <div className="flex items-center gap-1 flex-wrap">
                {(["all", "info", "success", "warning", "error"] as const).map(f => (
                  <Button
                    key={f}
                    size="sm"
                    variant={logFilter === f ? "default" : "outline"}
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setLogFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </Button>
                ))}
                <Button size="sm" variant="outline" onClick={() => fetchData()} disabled={isLoading} className="h-6 w-6 p-0">
                  <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1 border rounded-md">
              {logs.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  No logs yet for {connectionLabel}
                </div>
              ) : (
                <div className="space-y-px p-2">
                  {logs.filter(l => logFilter === "all" || l.level === logFilter).map((log, idx) => (
                    <div key={idx}>
                      <button
                        type="button"
                        onClick={() => setExpandedLog(expandedLog === idx ? null : idx)}
                        className={`w-full text-left text-[11px] px-2 py-1.5 rounded font-mono flex items-start gap-2 ${levelCls(log.level)} hover:opacity-90`}
                      >
                        <span className="opacity-60 shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                        {log.phase && <span className="opacity-70 shrink-0">[{log.phase}]</span>}
                        <span className="flex-1 break-words">{log.message}</span>
                        {log.details && (
                          expandedLog === idx
                            ? <ChevronUp className="w-3 h-3 shrink-0 mt-0.5 opacity-60" />
                            : <ChevronDown className="w-3 h-3 shrink-0 mt-0.5 opacity-60" />
                        )}
                      </button>
                      {expandedLog === idx && log.details && (
                        <div className="mx-2 mb-1 p-2 rounded bg-muted/60 font-mono text-[10px] text-muted-foreground overflow-auto max-h-40">
                          <pre>{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
