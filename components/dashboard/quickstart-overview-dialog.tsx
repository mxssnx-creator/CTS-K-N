"use client"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import {
  BarChart3, RefreshCw, Database, Activity, Zap, TrendingUp,
  ChevronDown, ChevronUp, CheckCircle2, Circle, Clock, DollarSign,
} from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface StratDetail {
  avgPosPerSet: number
  createdSets: number
  avgProfitFactor: number
  avgProcessingTimeMs: number
  evalPct: number
  // Shared optional fields also present on real and live tiers
  avgPosEvalReal?: number
  countPosEval?: number
  avgDrawdownTime?: number
  passRatio?: number
  evaluated?: number
  passed?: number
  failed?: number
  // Live-exclusive fields (populated only for strategyDetail.live)
  winRate?: number
  totalPnl?: number
  avgPnl?: number
  openPositions?: number
  volumeUsdTotal?: number
}

interface StatsResponse {
  // The /stats endpoint actually returns a much richer historic block
  // than originally typed here. Adding the missing fields as optional
  // so the JSX below compiles and the older callers keep working.
  historic: {
    symbolsProcessed: number; symbolsTotal: number; candlesLoaded: number
    indicatorsCalculated: number; cyclesCompleted: number; isComplete: boolean; progressPercent: number
    framesProcessed?: number
    timeframeSeconds?: number
    executedPositions?: number
    livePositionsOpen?: number
  }
  realtime: {
    indicationCycles: number; strategyCycles: number; realtimeCycles: number
    indicationsTotal: number; strategiesTotal: number; positionsOpen: number
    isActive: boolean; successRate: number; avgCycleTimeMs: number
  }
  // Snapshot of currently-open positions across stages. Optional —
  // older API revs returned only the realtime aggregate.
  //
  // Field names note:
  //   * `open` is the canonical current count (modern API)
  //   * `positions` was the legacy alias for the same value (pre-2025)
  //   * `activeAvg` / `activeSamples` are the unbounded running mean of
  //     active validated Real positions (added 2026-05; the per-set
  //     250-cap-bounded `stageReal.avgPosPerSet` is a different metric)
  openPositions?: {
    real?: {
      open: number
      total?: number
      positions?: number
      activeAvg?: number
      activeSamples?: number
    }
    live?: { open: number; total?: number; positions?: number }
  }
  breakdown: {
    indications: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
    strategies: { base: number; main: number; real: number; live: number; total: number
                  baseEvaluated: number; mainEvaluated: number; realEvaluated: number }
  }
  strategyDetail: { base: StratDetail; main: StratDetail; real: StratDetail; live?: StratDetail }
  windows: { indications: { last5m: number; last60m: number }; strategies: { last5m: number; last60m: number } }
  // ── Active Progressing — per-type / per-stage breakdown ────────────
  // Each row: { sets, trackings, positions } where:
  //   * sets       — distinct (symbol × type|stage) Sets producing
  //                  qualified entries on the latest cycle.
  //   * trackings  — cumulative entries observed since run start.
  //   * positions  — open positions held at that type/stage.
  // Optional because older API revs may not include it; consumers
  // fall back to `breakdown` when this block is missing.
  activeProgressing?: {
    indications?: Record<string, { sets: number; trackings: number; positions: number }>
    strategies?:  Record<string, { sets: number; trackings: number; positions: number }>
  }
  // activeCounts carries the SUM of per-symbol counts for each stage,
  // NOT the distinct Set count. Retained here for backward-compat reads
  // (e.g. the windows/indications tab) but NOT used for the headline
  // stage count in the Strategies tab — that uses activeProgressing.*.sets.
  activeCounts?: {
    indications?: Record<string, number>
    strategies?: { base?: number; main?: number; real?: number; total?: number }
  }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string; lastUpdate: string }
}

interface LogEntry {
  timestamp: string; level: string; phase: string; message: string; details?: any
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function pct(a: number, b: number) {
  if (!b) return "0%"
  return `${Math.min(100, Math.round((a / b) * 100))}%`
}

// For expansion stages (Base→Main) where a >> b, show a multiplier instead of
// a percentage that would display as "48100%". Returns e.g. "481×" or "100%".
function ratio(a: number, b: number) {
  if (!b || !a) return undefined
  const r = a / b
  if (r > 1.5) return `${Math.round(r)}× Base`   // expansion: show multiplier
  return `${Math.min(100, Math.round(r * 100))}% of Base`
}

function StatCell({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded bg-muted/50 p-2 text-center min-w-0">
      <div className={`text-base font-bold tabular-nums truncate ${accent || "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground leading-none mt-0.5">{sub}</div>}
      <div className="text-[10px] text-muted-foreground leading-none mt-0.5">{label}</div>
    </div>
  )
}

// ─── StratSection ─────────────────────────────────────────────────────────────

function StratSection({
  label, count, evaluated, evaluatedOf, detail, accentCls, bgCls,
}: {
  label: string; count: number; evaluated: number; evaluatedOf: number
  detail: StratDetail | undefined; accentCls: string; bgCls: string
}) {
  // ── eval/pass semantics ───────────────────────────────────────────
  // `evaluated` here is actually PASSED sets (the numerator we want to
  // show in "eval X/Y pass"). It's named `evaluated` for historical
  // reasons in the API schema but the UI semantics should reflect that
  // it's the pass count. The denominator `evaluatedOf` is the INPUT
  // count for this stage (parent stage's output).
  //
  // Display: "Evaluated of Base: X / Y sets (Z%)" where
  //   - X = evaluated (actually: passed at this stage)
  //   - Y = evaluatedOf (the parent stage's output / this stage's input)
  //   - Z = (X / Y) × 100%
  // Cap at 100: Main is an expansion stage (1 base → many main variants),
  // so evaluated/evaluatedOf can be >>1. Progress bars and percentages
  // should never display >100% — the expansion is captured in the raw count.
  const evalPct = Math.min(100, evaluatedOf > 0 ? Math.round((evaluated / evaluatedOf) * 1000) / 10 : (detail?.evalPct ?? 0))

  return (
    <div className={`rounded-md border p-2.5 space-y-2 ${bgCls}`}>
      {/* header */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold ${accentCls}`}>{label}</span>
        <span className={`text-lg font-bold tabular-nums ${accentCls}`}>{fmt(count)}</span>
      </div>

      {/* eval bar — only for Main and Real */}
      {evaluatedOf > 0 && (
        <div className="space-y-0.5">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Evaluated of {label === "Main" ? "Base" : "Main"}</span>
            <span className="font-medium tabular-nums">{evalPct.toFixed(1)}%</span>
          </div>
          <Progress value={Math.min(100, evalPct)} className="h-1" />
          <div className="text-[9px] text-muted-foreground text-right">
            {fmt(evaluated)} / {fmt(evaluatedOf)} sets passed
          </div>
        </div>
      )}

      {/* detail metrics */}
      {detail && (
        <div className="grid grid-cols-2 gap-1 text-[10px]">
          {detail.createdSets > 0 && (
            <div className="flex justify-between col-span-2">
              <span className="text-muted-foreground">Created Sets</span>
              <span className="font-medium tabular-nums">{fmt(detail.createdSets)}</span>
            </div>
          )}
          {detail.avgPosPerSet > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg Pos/Set</span>
              <span className="font-medium tabular-nums">{detail.avgPosPerSet.toFixed(2)}</span>
            </div>
          )}
          {detail.avgProfitFactor > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg PF</span>
              <span className="font-medium tabular-nums">{detail.avgProfitFactor.toFixed(3)}</span>
            </div>
          )}
          {detail.avgProcessingTimeMs > 0 && (
            <div className="flex justify-between col-span-2">
              <span className="text-muted-foreground">Avg Proc Time</span>
              <span className="font-medium tabular-nums">{detail.avgProcessingTimeMs.toFixed(1)}ms</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── IndWindow ────────────────────────────────────────────────────────────────

function IndWindow({ label, count, total }: { label: string; count: number; total: number }) {
  const p = total > 0 ? Math.min(100, (count / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-14 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-violet-500/70 rounded-full transition-all" style={{ width: `${p}%` }} />
      </div>
      <span className="w-12 text-right tabular-nums font-medium">{fmt(count)}</span>
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────���───────

export function QuickstartOverviewDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const connectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || connectionId

  const [isOpen, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [expandedLog, setExpandedLog] = useState<number | null>(null)
  // Newer `@types/react` rejects `useRef<T>()` with no args — pass an
  // explicit `undefined` initial value so the call shape is unambiguous.
  const pollRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const load = useCallback(async (silent = false) => {
    if (!connectionId) return
    if (!silent) setLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (logsRes.ok) {
        const d = await logsRes.json()
        setLogs((d.logs || d.recentLogs || []).slice(0, 200))
      }
      setLastRefresh(new Date())
    } catch { /* non-critical */ }
    finally { if (!silent) setLoading(false) }
  }, [connectionId])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!isOpen) return
    load()
    pollRef.current = setInterval(() => load(true), 3000)
    return () => clearInterval(pollRef.current)
  }, [isOpen, load])

  // Listen for settings changes and force immediate refresh of stats/progress
  useEffect(() => {
    if (!connectionId) return
    const handleSettingsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent
      if (customEvent.detail?.connectionId === connectionId) {
        // Settings changed for this connection, force refresh immediately
        load()
      }
    }
    window.addEventListener("connection-settings-updated", handleSettingsUpdated)
    return () => window.removeEventListener("connection-settings-updated", handleSettingsUpdated)
  }, [connectionId, load])

  const h   = stats?.historic
  const rt  = stats?.realtime
  const bd  = stats?.breakdown
  const sd  = stats?.strategyDetail
  // ── Active Progressing aliases ───────────────────────────────────────
  // Used by the Live Processing tile to surface "actively processing
  // Sets" (the headline operator metric) instead of the cumulative
  // counts in `rt.indicationsTotal` / `rt.strategiesTotal`. Aliased
  // here so the tile JSX stays readable.
  const apInd   = stats?.activeProgressing?.indications
  const apStrat = stats?.activeProgressing?.strategies
  void apStrat // reserved for the strategies tile if/when added here
  const win = stats?.windows

  // MUST stay in sync with `DEFAULT_LIMITS` in `lib/indication-sets-processor.ts`
  // and the breakdown shape returned by `/api/connections/progression/[id]/stats`.
  // Each type tracks its own independent count.
  const indTypes = [
    { label: "Direction",  value: bd?.indications.direction      || 0 },
    { label: "Move",       value: bd?.indications.move           || 0 },
    { label: "Active",     value: bd?.indications.active         || 0 },
    { label: "Active Adv", value: (bd?.indications as any)?.activeAdvanced || 0 },
    { label: "Optimal",    value: bd?.indications.optimal        || 0 },
    { label: "Auto",       value: bd?.indications.auto           || 0 },
  ]
  const totalIndByType = indTypes.reduce((s, r) => s + r.value, 0) || 1
  const evalMain5m  = win?.indications.last5m  || 0
  const evalMain60m = win?.indications.last60m || 0
  const totalIndAll = rt?.indicationsTotal || bd?.indications.total || 0

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1" title="Engine overview">
          <BarChart3 className="h-3.5 w-3.5" />
          Overview
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden p-0">
        {/* header */}
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="w-4 h-4" />
            Engine Overview
            {connectionLabel && (
              <Badge variant="secondary" className="text-[10px] font-normal">{connectionLabel}</Badge>
            )}
            {stats?.metadata?.engineRunning && (
              <Badge className="bg-green-600 text-[10px] h-4 px-1.5">Running</Badge>
            )}
            <Button
              size="icon" variant="ghost" className="ml-auto h-6 w-6"
              onClick={() => load()} disabled={loading} title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          {lastRefresh && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Updated {lastRefresh.toLocaleTimeString()}
              {stats?.metadata?.phase && stats.metadata.phase !== "—" && (
                <> &bull; <span className="capitalize">{stats.metadata.phase.replace(/_/g, " ")}</span></>
              )}
            </p>
          )}
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 grid grid-cols-5 h-8 rounded-none border-b bg-transparent px-4">
            {["overview","prehistoric","indications","strategies","logs"].map(tab => (
              <TabsTrigger key={tab} value={tab} className="text-[11px] capitalize h-7 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── Overview ───────────────────────────��─────────────────────── */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Historical Processing — shown FIRST, matching the engine's
                own top-to-bottom flow: historic load → live cycles → exec.
                This section was previously buried in the separate
                "prehistoric" tab, which meant users opening the Overview tab
                saw zero historical context up front. */}
            <div className="rounded-md border p-3 space-y-2 bg-blue-50/30 dark:bg-blue-950/20">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Database className="w-3.5 h-3.5 text-blue-500" />
                Historical Processing
                {h?.isComplete ? (
                  <Badge className="bg-green-600 hover:bg-green-600 text-white text-[10px] h-4 px-1.5 ml-auto">Loaded</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto tabular-nums">
                    {h?.progressPercent || 0}%
                  </Badge>
                )}
              </div>
              {!h?.isComplete && (
                <Progress value={h?.progressPercent || 0} className="h-1.5" />
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell
                  label="Symbols"
                  value={`${h?.symbolsProcessed || 0}/${h?.symbolsTotal || 0}`}
                  accent="text-blue-600 dark:text-blue-400"
                />
                <StatCell label="Candles"     value={fmt(h?.candlesLoaded       || 0)} accent="text-sky-600 dark:text-sky-400" />
                <StatCell label="Indicators"  value={fmt(h?.indicatorsCalculated|| 0)} accent="text-teal-600 dark:text-teal-400" />
                {/* Preh Cycles → cycle×frame work magnitude (high number).
                    Replaces the previous symbol-magnitude `cyclesCompleted`
                    display with cycles × frames so operators can see real
                    processing scale. Sub line shows the breakdown. */}
                <StatCell
                  label="Preh Cycles"
                  value={
                    (h?.cyclesCompleted || 0) > 0 && (h?.framesProcessed || 0) > 0
                      ? fmt((h?.cyclesCompleted || 0) * (h?.framesProcessed || 0))
                      : fmt(h?.cyclesCompleted || 0)
                  }
                  sub={
                    (h?.cyclesCompleted || 0) > 0 && (h?.framesProcessed || 0) > 0
                      ? `${fmt(h?.cyclesCompleted || 0)}×${fmt(h?.framesProcessed || 0)}`
                      : undefined
                  }
                  accent="text-indigo-600 dark:text-indigo-400"
                />
              </div>
              {/* ── New row: Avg PF (Base) + Avg Real Positions ───────────
                  These two metrics live alongside the historical counters
                  per spec: average profit factor across Base strategies
                  (the operator-visible quality signal) plus the snapshot
                  count of active, valid, opened Real-stage positions. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                <StatCell
                  label="Avg PF (Base)"
                  value={
                    (sd?.base?.avgProfitFactor || 0) > 0
                      ? (sd?.base?.avgProfitFactor || 0).toFixed(2)
                      : "—"
                  }
                  sub={
                    (sd?.base?.passed || 0) > 0
                      ? `n=${fmt(sd?.base?.passed || 0)}`
                      : undefined
                  }
                  accent="text-orange-600 dark:text-orange-400"
                />
                {/* Real Positions tile — was previously reading the
                    non-existent `.positions` field (legacy alias) and
                    silently rendered 0. Canonical field is `.open`.
                    Sub-line surfaces the unbounded running mean
                    (`activeAvg`, accumulated server-side, NOT capped
                    by the per-set 250-entry DB capacity) so the
                    operator sees both current snapshot + historical
                    average without a second tile. */}
                <StatCell
                  label="Real Positions"
                  value={fmt(
                    stats?.openPositions?.real?.open ??
                      stats?.openPositions?.real?.positions ??
                      0,
                  )}
                  sub={
                    (stats?.openPositions?.real?.activeSamples || 0) > 0 &&
                    (stats?.openPositions?.real?.activeAvg || 0) > 0
                      ? `avg ${(stats?.openPositions?.real?.activeAvg || 0).toFixed(2)}`
                      : "active, valid"
                  }
                  accent="text-green-600 dark:text-green-400"
                />
                <StatCell
                  label="Frames"
                  value={fmt(h?.framesProcessed || 0)}
                  sub={
                    (h?.timeframeSeconds || 1) === 1
                      ? "1s timeframe"
                      : `${h?.timeframeSeconds}s timeframe`
                  }
                  accent="text-cyan-600 dark:text-cyan-400"
                />
                <StatCell
                  label="Exec Pos"
                  value={fmt(h?.executedPositions || 0)}
                  sub="cumulative"
                  accent="text-amber-600 dark:text-amber-400"
                />
              </div>
            </div>

            {/* Live Processing counters (Ind Cycles / Strat Cycles / Indications / Positions). */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                Live Processing
                {rt?.isActive && <Badge className="bg-blue-600 text-[10px] h-4 px-1.5 ml-auto">Active</Badge>}
              </div>
              {/* Indications tile shows ACTIVELY-PROCESSING Sets (count of
                  Sets producing qualified entries on the latest cycle),
                  not the cumulative `indicationsTotal` that grows forever.
                  Source = `activeProgressing.indications.total.sets` of
                  /stats. Cumulative remains accessible as the sub-line.
                  Falls back to legacy total when the field is missing
                  (older API revs). */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell label="Ind Cycles"   value={fmt(rt?.indicationCycles || 0)}  accent="text-blue-600 dark:text-blue-400" />
                <StatCell label="Strat Cycles" value={fmt(rt?.strategyCycles   || 0)}  accent="text-violet-600 dark:text-violet-400" />
                <StatCell
                  label="Indications"
                  value={fmt(
                    apInd?.total?.sets ??
                      (rt?.indicationsTotal || 0),
                  )}
                  sub={
                    apInd?.total?.sets !== undefined && (rt?.indicationsTotal || 0) > 0
                      ? `${fmt(rt?.indicationsTotal || 0)} total`
                      : apInd?.total?.sets !== undefined
                        ? "active sets"
                        : undefined
                  }
                  accent="text-green-600 dark:text-green-400"
                />
                <StatCell label="Positions"    value={fmt(rt?.positionsOpen    || 0)}  accent="text-amber-600 dark:text-amber-400" />
              </div>
            </div>

            {/* time windows */}
            {(evalMain5m > 0 || evalMain60m > 0) && (
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                  Activity Windows
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last 5 min</span>
                    <span className="font-medium tabular-nums">{fmt(evalMain5m)} ind</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last 60 min</span>
                    <span className="font-medium tabular-nums">{fmt(evalMain60m)} ind</span>
                  </div>
                </div>
              </div>
            )}

            {/* strategies compact overview */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Zap className="w-3.5 h-3.5 text-amber-500" />
                Strategies Summary
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCell label="Base" value={fmt(bd?.strategies.base || 0)} accent="text-orange-600 dark:text-orange-400" />
                <StatCell label="Main" value={fmt(bd?.strategies.main || 0)} accent="text-yellow-600 dark:text-yellow-400"
                  sub={bd?.strategies.base ? ratio(bd.strategies.main, bd.strategies.base) : undefined}
                />
                <StatCell label="Real" value={fmt(bd?.strategies.real || 0)} accent="text-green-600 dark:text-green-400"
                  sub={bd?.strategies.main ? `${pct(bd.strategies.real, bd.strategies.main)} of Main` : undefined}
                />
                {/* Live = real exchange positions, tracked locally — so the UI
                    can show exchange-side outcomes without an exchange fetch. */}
                <StatCell label="Live" value={fmt(sd?.live?.createdSets || 0)} accent="text-amber-600 dark:text-amber-400"
                  sub={bd?.strategies.real ? `${pct(sd?.live?.createdSets || 0, bd.strategies.real)} of Real` : undefined}
                />
              </div>
            </div>

            {/* live positions + PnL + success rate */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><Activity className="w-3 h-3" />Live Pos</span>
                  <span className="font-bold tabular-nums">{fmt(rt?.positionsOpen || 0)}</span>
                </div>
                <Progress value={Math.min((rt?.positionsOpen || 0) * 10, 100)} className="h-1.5" />
              </div>
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><DollarSign className="w-3 h-3" />Total PnL</span>
                  <span className={`font-bold tabular-nums ${(sd?.live?.totalPnl || 0) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    {(sd?.live?.totalPnl || 0) >= 0 ? "+" : ""}{(sd?.live?.totalPnl || 0).toFixed(2)}
                  </span>
                </div>
                <Progress value={Math.max(0, Math.min((sd?.live?.totalPnl || 0) * 10, 100))} className="h-1.5" />
              </div>
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><TrendingUp className="w-3 h-3" />Success Rate</span>
                  <span className="font-bold tabular-nums">{(rt?.successRate || 0).toFixed(1)}%</span>
                </div>
                <Progress value={rt?.successRate || 0} className="h-1.5" />
              </div>
            </div>

            {/* cycle time + status badges */}
            <div className="rounded-md border p-3 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1 font-medium"><Clock className="w-3 h-3" />Avg Cycle</span>
                <span className="font-bold tabular-nums">{rt?.avgCycleTimeMs || 0}ms</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {[
                  { label: "Historic",    done: h?.isComplete },
                  { label: "Indications", done: (rt?.indicationCycles || 0) > 0 },
                  { label: "Strategies",  done: (rt?.strategyCycles   || 0) > 0 },
                  { label: "Realtime",    done: rt?.isActive },
                ].map(({ label, done }) => (
                  <Badge key={label} variant={done ? "default" : "secondary"} className="text-[9px] h-4 px-1">
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── Prehistoric ───────────────────────────────────────────────── */}
          <TabsContent value="prehistoric" className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-500" />
                <span className="text-sm font-semibold">Prehistoric Processing</span>
                {h?.isComplete
                  ? <Badge className="bg-green-600 text-[10px] ml-auto">Loaded</Badge>
                  : <Badge variant="secondary" className="text-[10px] ml-auto">Processing…</Badge>
                }
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Symbols: {h?.symbolsProcessed || 0} / {h?.symbolsTotal || 0}</span>
                  <span>{h?.progressPercent || 0}%</span>
                </div>
                <Progress value={h?.progressPercent || 0} className="h-2" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell label="Symbols"      value={fmt(h?.symbolsProcessed    || 0)} accent="text-blue-600 dark:text-blue-400" />
                <StatCell label="Candles"      value={fmt(h?.candlesLoaded       || 0)} accent="text-sky-600 dark:text-sky-400" />
                <StatCell label="Indicators"   value={fmt(h?.indicatorsCalculated|| 0)} accent="text-teal-600 dark:text-teal-400" />
                {/* Preh Cycles → cycle×frame work magnitude. See Overview
                    tab comment above; same logic mirrored here so both
                    surfaces tell the operator the same story. */}
                <StatCell
                  label="Preh Cycles"
                  value={
                    (h?.cyclesCompleted || 0) > 0 && (h?.framesProcessed || 0) > 0
                      ? fmt((h?.cyclesCompleted || 0) * (h?.framesProcessed || 0))
                      : fmt(h?.cyclesCompleted || 0)
                  }
                  sub={
                    (h?.cyclesCompleted || 0) > 0 && (h?.framesProcessed || 0) > 0
                      ? `${fmt(h?.cyclesCompleted || 0)}×${fmt(h?.framesProcessed || 0)}`
                      : undefined
                  }
                  accent="text-indigo-600 dark:text-indigo-400"
                />
              </div>

              {/* Quality + activity row: Base-strategy avg PF and active
                  Real-stage open positions, mirrored from the Overview tab. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell
                  label="Avg PF (Base)"
                  value={
                    (sd?.base?.avgProfitFactor || 0) > 0
                      ? (sd?.base?.avgProfitFactor || 0).toFixed(2)
                      : "—"
                  }
                  sub={
                    (sd?.base?.passed || 0) > 0
                      ? `n=${fmt(sd?.base?.passed || 0)}`
                      : undefined
                  }
                  accent="text-orange-600 dark:text-orange-400"
                />
                {/* Real Positions tile — was previously reading the
                    non-existent `.positions` field (legacy alias) and
                    silently rendered 0. Canonical field is `.open`.
                    Sub-line surfaces the unbounded running mean
                    (`activeAvg`, accumulated server-side, NOT capped
                    by the per-set 250-entry DB capacity) so the
                    operator sees both current snapshot + historical
                    average without a second tile. */}
                <StatCell
                  label="Real Positions"
                  value={fmt(
                    stats?.openPositions?.real?.open ??
                      stats?.openPositions?.real?.positions ??
                      0,
                  )}
                  sub={
                    (stats?.openPositions?.real?.activeSamples || 0) > 0 &&
                    (stats?.openPositions?.real?.activeAvg || 0) > 0
                      ? `avg ${(stats?.openPositions?.real?.activeAvg || 0).toFixed(2)}`
                      : "active, valid"
                  }
                  accent="text-green-600 dark:text-green-400"
                />
                <StatCell
                  label="Frames"
                  value={fmt(h?.framesProcessed || 0)}
                  sub={
                    (h?.timeframeSeconds || 1) === 1
                      ? "1s timeframe"
                      : `${h?.timeframeSeconds}s timeframe`
                  }
                  accent="text-cyan-600 dark:text-cyan-400"
                />
                <StatCell
                  label="Exec Pos"
                  value={fmt(h?.executedPositions || 0)}
                  sub="cumulative"
                  accent="text-amber-600 dark:text-amber-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                {[
                  { label: "Data Loaded",   done: h?.isComplete },
                  { label: "Ind Running",   done: (rt?.indicationCycles || 0) > 0 },
                  { label: "Strat Running", done: (rt?.strategyCycles   || 0) > 0 },
                  { label: "Live Active",   done: rt?.isActive },
                ].map(({ label, done }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    {done ? <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" /> : <Circle className="w-3 h-3 text-muted-foreground/30 shrink-0" />}
                    <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── Indications ───────────────────────────────────────────────── */}
          <TabsContent value="indications" className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* time window summary */}
            <div className="grid grid-cols-3 gap-2">
              <StatCell label="Total" value={fmt(totalIndAll)} accent="text-violet-600 dark:text-violet-400" />
              <StatCell label="Last 5min"  value={fmt(evalMain5m)}  sub="rolling window" />
              <StatCell label="Last 60min" value={fmt(evalMain60m)} sub="rolling window" />
            </div>

            {/* per-type bars */}
            <div className="rounded-md border p-3 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-violet-500" />
                  Indication Types
                </span>
                <span className="text-muted-foreground">{fmt(rt?.indicationCycles || 0)} cycles</span>
              </div>
              <div className="space-y-2">
                {indTypes.map(({ label, value }) => (
                  <IndWindow key={label} label={label} count={value} total={totalIndByType} />
                ))}
              </div>
            </div>

            {/* last 5 evaluated (simulated from ratio if not available) */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="text-xs font-semibold">Eval Counts — Last Periods</div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {indTypes.map(({ label, value }) => {
                  const ratio5m  = totalIndAll > 0 && evalMain5m  > 0 ? (value / totalIndAll) * evalMain5m  : 0
                  const ratio60m = totalIndAll > 0 && evalMain60m > 0 ? (value / totalIndAll) * evalMain60m : 0
                  return (
                    <React.Fragment key={label}>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{label} 5m</span>
                        <span className="font-medium tabular-nums">{fmt(Math.round(ratio5m))}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{label} 60m</span>
                        <span className="font-medium tabular-nums">{fmt(Math.round(ratio60m))}</span>
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-1.5">
              <div className="text-xs font-semibold">Realtime Metrics</div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Indication Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.indicationCycles || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Realtime Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.realtimeCycles || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Open Positions</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.positionsOpen || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Cycle Time</span>
                  <span className="font-medium tabular-nums">{rt?.avgCycleTimeMs || 0}ms</span>
                </div>
              </div>
            </div>

            {/* ── Active Progressing — per type ───────────────────────────
                Per spec: surface "Active Progressing Sets, trackings,
                active positions" per indication type. Renders only when
                the API ships the activeProgressing block (graceful
                degradation for older servers). */}
            {stats?.activeProgressing?.indications && (
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-violet-500" />
                    Active Progressing — Per Type
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {fmt(stats.activeProgressing.indications.total?.sets ?? 0)} sets ·
                    {" "}{fmt(stats.activeProgressing.indications.total?.trackings ?? 0)} tracked ·
                    {" "}{fmt(stats.activeProgressing.indications.total?.positions ?? 0)} pos
                  </span>
                </div>
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border/40">
                      <th className="text-left py-1 pr-2 font-medium">Type</th>
                      <th className="text-right py-1 px-1 font-medium" title="Distinct (symbol × type) Sets producing qualified entries on the latest cycle">Sets</th>
                      <th className="text-right py-1 px-1 font-medium" title="Cumulative entries observed (trackings)">Trackings</th>
                      <th className="text-right py-1 pl-1 font-medium" title="Indications currently passing thresholds">Positions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["direction", "move", "active", "activeAdvanced", "optimal", "auto"] as const).map((k) => {
                      const r = stats.activeProgressing!.indications![k]
                      if (!r || (r.sets === 0 && r.trackings === 0 && r.positions === 0)) return null
                      const labelMap: Record<string, string> = {
                        direction: "Direction", move: "Move", active: "Active",
                        activeAdvanced: "Active Adv", optimal: "Optimal", auto: "Auto",
                      }
                      return (
                        <tr key={k} className="border-b border-border/20 last:border-0">
                          <td className="text-left py-1 pr-2">{labelMap[k]}</td>
                          <td className="text-right py-1 px-1 font-medium text-violet-700 dark:text-violet-300">{fmt(r.sets)}</td>
                          <td className="text-right py-1 px-1">{fmt(r.trackings)}</td>
                          <td className="text-right py-1 pl-1 font-medium">{fmt(r.positions)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* ── Strategies ────────────────────────────────────────────────── */}
          <TabsContent value="strategies" className="flex-1 overflow-y-auto p-4 space-y-3">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Main strategies are formed from evaluated Base pseudo-position sets, coordinated via pis-count and
              continuous-count factors plus additional strategies — not always new sets but coordinated variable
              mappings for high-frequency evaluation. Real strategies filter Main by highest-confidence coordination.
            </p>

            {/* ── Strategy stage counts ─────────────────────────────────────
                The `count` prop is the ACTIVE-PROCESSING SETS count — how
                many distinct (symbol × stage) Set pairs produced qualified
                entries on the latest engine cycle. This comes from
                `activeProgressing.strategies.{stage}.sets`, NOT from
                `activeCounts.strategies.{stage}` which is the SUM of per-
                symbol strategy counts and grows to 172K+ over a run.
                `evaluatedOf` (the eval-bar denominator) uses the same
                `.sets` source so the ratio is sets/sets, not entries/sets. */}
            <StratSection
              label="Base"
              count={stats?.activeProgressing?.strategies?.base?.sets || 0}
              evaluated={bd?.strategies.baseEvaluated || 0}
              evaluatedOf={0}
              detail={sd?.base}
              accentCls="text-orange-600 dark:text-orange-400"
              bgCls="bg-orange-50/50 dark:bg-orange-950/20 border-orange-200/50 dark:border-orange-800/30"
            />

            <StratSection
              label="Main"
              count={stats?.activeProgressing?.strategies?.main?.sets || 0}
              evaluated={bd?.strategies.mainEvaluated || 0}
              evaluatedOf={stats?.activeProgressing?.strategies?.base?.sets || 0}
              detail={sd?.main}
              accentCls="text-yellow-600 dark:text-yellow-400"
              bgCls="bg-yellow-50/50 dark:bg-yellow-950/20 border-yellow-200/50 dark:border-yellow-800/30"
            />

            <StratSection
              label="Real"
              count={stats?.activeProgressing?.strategies?.real?.sets || 0}
              evaluated={bd?.strategies.realEvaluated || 0}
              evaluatedOf={stats?.activeProgressing?.strategies?.main?.sets || 0}
              detail={sd?.real}
              accentCls="text-green-600 dark:text-green-400"
              bgCls="bg-green-50/50 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/30"
            />

            {/* Live = real exchange positions history, tracked locally in Redis.
                No exchange-history call required — strategyDetail.live is derived
                from the progression counters + closed-position archive. */}
            <StratSection
              label="Live"
              count={sd?.live?.createdSets || 0}
              evaluated={sd?.live?.evaluated || 0}
              evaluatedOf={bd?.strategies.real || 0}
              detail={sd?.live}
              accentCls="text-amber-600 dark:text-amber-400"
              bgCls="bg-amber-50/50 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-800/30"
            />

            <div className="rounded-md border p-2.5">
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Strategy Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.strategyCycles || 0)}</span>
                </div>
                <div
                  className="flex justify-between"
                  title="Canonical total = Real-stage output. Main contains related descendants of Base, so stage outputs are not summed together."
                >
                  <span className="text-muted-foreground">Strategies (Real)</span>
                  <span className="font-medium tabular-nums">{fmt(bd?.strategies.total || 0)}</span>
                </div>
                {(bd?.strategies.live || 0) > 0 && (
                  <div className="flex justify-between col-span-2">
                    <span className="text-muted-foreground">Live Strategies</span>
                    <span className="font-medium tabular-nums">{fmt(bd!.strategies.live)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Active Progressing — per stage ──────────────────────────
                Per spec: per-stage "Active Progressing Sets, trackings,
                active positions". Mirrors the indications tab table so
                the operator gets the same shape on both sides. */}
            {stats?.activeProgressing?.strategies && (
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold">Active Progressing — Per Stage</span>
                  <span className="text-muted-foreground tabular-nums">
                    {fmt(stats.activeProgressing.strategies.total?.sets ?? 0)} sets ·
                    {" "}{fmt(stats.activeProgressing.strategies.total?.trackings ?? 0)} tracked ·
                    {" "}{fmt(stats.activeProgressing.strategies.total?.positions ?? 0)} pos
                  </span>
                </div>
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border/40">
                      <th className="text-left py-1 pr-2 font-medium">Stage</th>
                      <th className="text-right py-1 px-1 font-medium" title="Distinct (symbol × stage) Sets producing qualified entries on the latest cycle">Sets</th>
                      <th className="text-right py-1 px-1 font-medium" title="Cumulative entries observed (trackings)">Trackings</th>
                      <th className="text-right py-1 pl-1 font-medium" title="Open positions held at this stage right now">Positions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      { key: "base", label: "Base", color: "text-orange-600 dark:text-orange-400" },
                      { key: "main", label: "Main", color: "text-yellow-600 dark:text-yellow-400" },
                      { key: "real", label: "Real", color: "text-green-600 dark:text-green-400" },
                      { key: "live", label: "Live", color: "text-blue-600 dark:text-blue-400" },
                    ] as const).map(({ key, label, color }) => {
                      const r = stats.activeProgressing!.strategies![key]
                      if (!r || (r.sets === 0 && r.trackings === 0 && r.positions === 0)) return null
                      return (
                        <tr key={key} className="border-b border-border/20 last:border-0">
                          <td className={`text-left py-1 pr-2 font-semibold ${color}`}>{label}</td>
                          <td className="text-right py-1 px-1 font-medium">{fmt(r.sets)}</td>
                          <td className="text-right py-1 px-1">{fmt(r.trackings)}</td>
                          <td className="text-right py-1 pl-1 font-medium">{fmt(r.positions)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* ── Logs ──────────────────────────────────────────────────────── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 p-4">
            <div className="flex items-center justify-between pb-2 shrink-0">
              <span className="text-xs text-muted-foreground">{logs.length} entries</span>
              <Button size="sm" variant="outline" onClick={() => load()} disabled={loading} className="h-7 gap-1.5 text-xs">
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
            <ScrollArea className="flex-1 rounded border">
              <div className="p-2 space-y-px">
                {logs.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground py-8">No logs available yet.</p>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx}>
                      <button
                        type="button"
                        onClick={() => setExpandedLog(expandedLog === idx ? null : idx)}
                        className="w-full flex items-start gap-2 text-xs py-1 px-1.5 rounded hover:bg-muted/40 text-left"
                      >
                        <span className="text-muted-foreground shrink-0 tabular-nums font-mono text-[10px] pt-px">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] h-4 px-1 shrink-0 ${
                            log.level === "error"   ? "border-red-400 text-red-600 dark:text-red-400" :
                            log.level === "warning" ? "border-amber-400 text-amber-600 dark:text-amber-400" :
                            "border-border text-muted-foreground"
                          }`}
                        >
                          {log.phase}
                        </Badge>
                        <span className="flex-1 text-foreground break-words">{log.message}</span>
                        {log.details && (
                          expandedLog === idx
                            ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                            : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                        )}
                      </button>
                      {expandedLog === idx && log.details && (
                        <div className="ml-[90px] mb-1 p-1.5 rounded bg-muted/40 font-mono text-[10px] text-muted-foreground overflow-auto max-h-32">
                          <pre>{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
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
