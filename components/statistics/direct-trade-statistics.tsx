"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Activity, BarChart3, Clock3, Filter, RefreshCw, ShieldCheck, Target } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type DirectConfig = {
  setKey: string
  symbol: string
  direction: "long" | "short"
  signalDirection: "long" | "short"
  strategyType: "standard" | "trailing_fixed" | "trailing_auto" | "combination" | "inverse" | "high_protection"
  timeframe: string
  entryTactic: string
  exitTactic: string
  valid: boolean
  deactivationReason: string | null
  profitFactor: number | null
  profitFactorInfinite?: boolean
  winRate: number
  totalTrades: number
  maxDrawdownTimeMin: number
  score: number
  totalPnl: number
  bestMarketExitPnl: number
  positionCostPercent?: number
  lastPositionPnl: number | null
  lastPositionBestMarketExitPnl: number | null
  lastPositionDrawdownTimeMin: number | null
  lastPositionExitReason: string | null
  recentPositionCount?: number
  recentProfitFactor: number | null
  recentProfitFactorInfinite?: boolean
  recentWinRate?: number
  recentTotalPnl?: number
  recentAvgDrawdownTimeMin?: number
  blockCount?: number
  blockProfitFactorRatio?: number
  blockValid?: boolean
  blockDeactivationReason?: string | null
  blockObservedProfitFactor?: number | null
  blockObservedProfitFactorInfinite?: boolean
  blockNormalProfitFactor?: number
  blockMinimumProfitFactor?: number
  blockConfiguredMinimumProfitFactor?: number
  blockProfitFactorDifference?: number
  blockProfitFactorToMinimumDifference?: number
  blockComparisonAvailable?: boolean
  blockProfitFactorWindow?: number
  blockProfitFactorSampleCount?: number
  blockAvgDrawdownTimeMin?: number
  blockMaxDrawdownTimeMin?: number
  blockTotalPnl?: number
  blockVolumeIncrementRatio?: number
  blockCalculatedVolumeMultiplier?: number
  blockRealizedVolumeMultiplier?: number
}

type Status = {
  stats?: {
    totalPnl?: number
    totalPnlUsdt?: number
    profitFactor?: number
    profitFactorPercent?: number
    statsPnlBasis?: "usdt" | "percent"
    winCount?: number
    lossCount?: number
    last12Pos?: { pf: number; ddt: number; pnl: number }
    last25Pos?: { pf: number; ddt: number; pnl: number }
    last50Pos?: { pf: number; ddt: number; pnl: number }
  }
  calculation?: {
    calculatedAt?: string
    historyHours?: number
    combinations?: number
    evaluatedSets?: number
    validSets?: number
    deactivatedSets?: number
    byTimeframe?: Record<string, { evaluated: number; valid: number }>
    byEntryTactic?: Record<string, { evaluated: number; valid: number }>
    byExitTactic?: Record<string, { evaluated: number; valid: number }>
    byStrategyType?: Record<string, { evaluated: number; valid: number }>
    blockEnabled?: boolean
    blockEvaluatedSets?: number
    blockValidSets?: number
    blockDeactivatedSets?: number
    baseProfitFactor?: number | null
    baseProfitFactorInfinite?: boolean
    selectedBlockProfitFactor?: number | null
    selectedBlockProfitFactorInfinite?: boolean
    selectedBlockCount?: number
    selectedBlockPnl?: number
    blockLedgerProfitFactor?: number | null
    blockLedgerProfitFactorInfinite?: boolean
    pfBasis?: string
    takeProfitRatioAverage?: number
    takeProfitPercentAverage?: number
    baseGrossProfit?: number
    baseGrossLoss?: number
    baseNetProfit?: number
    baseNetLoss?: number
    selectedBlockGrossProfit?: number
    selectedBlockGrossLoss?: number
    selectedBlockNetProfit?: number
    selectedBlockNetLoss?: number
    blockLedgerGrossProfit?: number
    blockLedgerGrossLoss?: number
    byBlockCount?: Record<string, {
      evaluated: number
      valid: number
      disabled: number
      observedPfCount?: number
      infinitePf?: number
      meanObservedPF: number
      meanMinimumPF: number
      meanProfitFactorDifference: number
      meanProfitFactorToMinimumDifference: number
      totalPnl: number
      aggregateObservedPF?: number | null
      aggregateObservedPFInfinite?: boolean
      meanRealizedVolumeMultiplier?: number
    }>
  }
  processor?: { isHealthy?: boolean; lastTick?: string; errorsLast5min?: number } | null
}

type StatisticsSnapshot = {
  matched?: number
  rows?: DirectConfig[]
  rowLimit?: number
}

function displayPf(config: DirectConfig): string {
  return config.profitFactorInfinite ? "∞" : config.profitFactor == null ? "—" : config.profitFactor.toFixed(2)
}

function displayRecentPf(config: DirectConfig): string {
  if (!config.recentPositionCount) return "—"
  return config.recentProfitFactorInfinite ? "∞" : config.recentProfitFactor == null ? "—" : config.recentProfitFactor.toFixed(2)
}

function displayAggregatePf(value: number | null | undefined, infinite = false): string {
  if (infinite) return "∞"
  return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(2)
}

function formatPnl(value: number | undefined): string {
  const amount = Number(value) || 0
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(3)}%`
}

export function DirectTradeStatistics() {
  const [status, setStatus] = useState<Status>({})
  const [configs, setConfigs] = useState<DirectConfig[]>([])
  const [matched, setMatched] = useState(0)
  const [timeframe, setTimeframe] = useState("all")
  const [direction, setDirection] = useState("all")
  const [stateFilter, setStateFilter] = useState("all")
  const [strategyType, setStrategyType] = useState("all")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const selection = new URLSearchParams({
        view: "statistics",
        timeframe,
        direction,
        state: stateFilter,
        strategyType,
      })
      const [statusResponse, configResponse] = await Promise.all([
        fetch("/api/trade-engine/direct-trade/status", { cache: "no-store" }),
        fetch(`/api/trade-engine/direct-trade?${selection.toString()}`, { cache: "no-store" }),
      ])
      if (!statusResponse.ok || !configResponse.ok) throw new Error("Direct-Trade statistics are unavailable")
      const [nextStatus, snapshot] = await Promise.all([statusResponse.json(), configResponse.json()])
      setStatus(nextStatus)
      setConfigs(Array.isArray((snapshot as StatisticsSnapshot)?.rows) ? (snapshot as StatisticsSnapshot).rows! : [])
      setMatched(Math.max(0, Number((snapshot as StatisticsSnapshot)?.matched) || 0))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Direct-Trade statistics are unavailable")
    } finally {
      setLoading(false)
    }
  }, [direction, stateFilter, strategyType, timeframe])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(interval)
  }, [load])

  const chartRows = useMemo(() => Object.entries(status.calculation?.byTimeframe || {}).map(([name, count]) => ({
    name,
    evaluated: count.evaluated,
    valid: count.valid,
  })), [status.calculation?.byTimeframe])
  const visibleRows = configs
  const stats = status.stats || {}
  const calculation = status.calculation || {}
  const blockRows = Object.entries(calculation.byBlockCount || {})
    .sort(([left], [right]) => Number(left) - Number(right))

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-semibold">Direct-Trade statistics</h1>
              <Badge variant={status.processor?.isHealthy ? "default" : "secondary"}>{status.processor?.isHealthy ? "Processor healthy" : "Processor idle"}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Independent 1m / 10m / 15m sets, all selected combinations, and separate entry, exit, TP, SL and trailing evaluation lines.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Historic range" value={`${calculation.historyHours || 0}h`} icon={<Clock3 className="h-4 w-4" />} />
          <Metric label="Evaluated sets" value={String(calculation.evaluatedSets || 0)} icon={<BarChart3 className="h-4 w-4" />} />
          <Metric label="Valid / executable" value={`${calculation.validSets || 0} / ${calculation.evaluatedSets || 0}`} icon={<ShieldCheck className="h-4 w-4" />} />
          <Metric label="TF combinations" value={String(calculation.combinations || 0)} icon={<Activity className="h-4 w-4" />} />
          <Metric label="Simulated PnL" value={formatPnl(stats.totalPnl)} emphasis={Number(stats.totalPnl) >= 0} icon={<Target className="h-4 w-4" />} />
        </div>
      </Card>

      <Card className="overflow-hidden p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="text-sm font-medium">Independent Block Count PF / DDT ledger</h2><p className="text-xs text-muted-foreground">Each count uses the same causal last-position window; PF floors and projected volume are count-specific.</p></div>
          <Badge variant={calculation.blockEnabled ? "default" : "secondary"}>{calculation.blockEnabled ? "Block enabled" : "Block disabled"}</Badge>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <Metric label="Block evaluations" value={String(calculation.blockEvaluatedSets || 0)} icon={<BarChart3 className="h-4 w-4" />} />
          <Metric label="Block valid / executable" value={`${calculation.blockValidSets || 0} / ${calculation.blockEvaluatedSets || 0}`} icon={<ShieldCheck className="h-4 w-4" />} />
          <Metric label="Block disabled" value={String(calculation.blockDeactivatedSets || 0)} icon={<Activity className="h-4 w-4" />} />
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-8">
          <Metric label="Base aggregate PF" value={displayAggregatePf(calculation.baseProfitFactor, calculation.baseProfitFactorInfinite)} icon={<Target className="h-4 w-4" />} />
          <Metric label={`Selected Block PF${calculation.selectedBlockCount ? ` (n=${calculation.selectedBlockCount})` : ""}`} value={displayAggregatePf(calculation.selectedBlockProfitFactor, calculation.selectedBlockProfitFactorInfinite)} icon={<Target className="h-4 w-4" />} />
          <Metric label="All-count Block PF" value={displayAggregatePf(calculation.blockLedgerProfitFactor, calculation.blockLedgerProfitFactorInfinite)} icon={<Target className="h-4 w-4" />} />
          <Metric label="Base net + / −" value={`${formatPnl(calculation.baseNetProfit ?? calculation.baseGrossProfit)} / ${formatPnl(-(calculation.baseNetLoss ?? calculation.baseGrossLoss ?? 0))}`} icon={<BarChart3 className="h-4 w-4" />} />
          <Metric label="Block net + / −" value={`${formatPnl(calculation.selectedBlockNetProfit ?? calculation.selectedBlockGrossProfit)} / ${formatPnl(-(calculation.selectedBlockNetLoss ?? calculation.selectedBlockGrossLoss ?? 0))}`} icon={<BarChart3 className="h-4 w-4" />} />
          <Metric label="Selected Block PnL" value={formatPnl(calculation.selectedBlockPnl)} emphasis={Number(calculation.selectedBlockPnl) >= 0} icon={<Activity className="h-4 w-4" />} />
          <Metric label="TP ratio mean*" value={`${Number(calculation.takeProfitRatioAverage || 0).toFixed(2)}×`} icon={<Target className="h-4 w-4" />} />
          <Metric label="TP % mean*" value={`${Number(calculation.takeProfitPercentAverage || 0).toFixed(3)}%`} icon={<Target className="h-4 w-4" />} />
        </div>
        <div className="overflow-auto rounded-md border">
          <table className="w-full min-w-[1240px] text-xs"><thead className="bg-muted/95 text-muted-foreground"><tr><th className="p-2 text-right">Count</th><th className="p-2 text-right">Evaluated</th><th className="p-2 text-right">Valid</th><th className="p-2 text-right">Disabled</th><th className="p-2 text-right">Observed PF</th><th className="p-2 text-right">Aggregate PF</th><th className="p-2 text-right">Minimum PF</th><th className="p-2 text-right">PF vs Base</th><th className="p-2 text-right">PF vs Floor</th><th className="p-2 text-right">Realized Vol</th><th className="p-2 text-right">Projected PnL</th></tr></thead><tbody>{blockRows.map(([count, row]) => <tr key={count} className="border-t"><td className="p-2 text-right font-mono">{count}</td><td className="p-2 text-right font-mono">{row.evaluated}</td><td className="p-2 text-right font-mono text-emerald-600">{row.valid}</td><td className="p-2 text-right font-mono text-muted-foreground">{row.disabled}</td><td className="p-2 text-right font-mono">{row.meanObservedPF > 0 ? row.meanObservedPF.toFixed(2) : "—"}</td><td className="p-2 text-right font-mono">{displayAggregatePf(row.aggregateObservedPF, row.aggregateObservedPFInfinite)}</td><td className="p-2 text-right font-mono">{row.meanMinimumPF.toFixed(2)}</td><td className={`p-2 text-right font-mono ${row.meanProfitFactorDifference >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{row.meanProfitFactorDifference >= 0 ? "+" : ""}{row.meanProfitFactorDifference.toFixed(2)}</td><td className={`p-2 text-right font-mono ${row.meanProfitFactorToMinimumDifference >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{row.meanProfitFactorToMinimumDifference >= 0 ? "+" : ""}{row.meanProfitFactorToMinimumDifference.toFixed(2)}</td><td className="p-2 text-right font-mono">{Number(row.meanRealizedVolumeMultiplier || 0).toFixed(2)}×</td><td className="p-2 text-right font-mono">{row.totalPnl.toFixed(2)}%</td></tr>)}</tbody></table>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><Filter className="h-4 w-4 text-muted-foreground" /><span className="text-sm font-medium">Set selection</span><span className="text-xs text-muted-foreground">{matched} matched; the table displays the top {visibleRows.length || 100} by score.</span></div>
          <div className="flex flex-wrap gap-2">
            <Select value={timeframe} onValueChange={setTimeframe}><SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All frames</SelectItem>{Object.keys(calculation.byTimeframe || {}).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={direction} onValueChange={setDirection}><SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All sides</SelectItem><SelectItem value="long">Long</SelectItem><SelectItem value="short">Short</SelectItem></SelectContent></Select>
            <Select value={stateFilter} onValueChange={setStateFilter}><SelectTrigger className="h-8 w-[125px] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All states</SelectItem><SelectItem value="valid">Valid</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent></Select>
            <Select value={strategyType} onValueChange={setStrategyType}><SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem>{Object.keys(calculation.byStrategyType || {}).map((value) => <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select>
          </div>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows} margin={{ left: -15, right: 12 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="evaluated" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="valid" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <Card className="overflow-hidden p-4">
          <div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium">Independent sets</span><Badge variant="outline">stable lineage key</Badge></div>
          <div className="max-h-[520px] overflow-auto rounded-md border">
            <table className="w-full min-w-[960px] text-xs">
              <thead className="sticky top-0 bg-muted/95 text-muted-foreground"><tr><th className="p-2 text-left">Symbol / frame</th><th className="p-2 text-left">Type / tactics</th><th className="p-2 text-right">History PF</th><th className="p-2 text-right">Last 12 PF</th><th className="p-2 text-right">DDT</th><th className="p-2 text-right">Net PnL</th><th className="p-2 text-right">Cost</th><th className="p-2 text-right">Best exit*</th><th className="p-2 text-right">State</th></tr></thead>
              <tbody>{visibleRows.map((config) => <tr key={config.setKey} className="border-t"><td className="p-2 font-mono"><div>{config.symbol} <span className="text-muted-foreground">{config.direction}</span></div><div className="text-muted-foreground">{config.timeframe}</div></td><td className="p-2"><div>{config.strategyType.replaceAll("_", " ")}{config.strategyType === "inverse" && <span className="text-muted-foreground"> ← {config.signalDirection}</span>}</div><div className="text-muted-foreground">{config.entryTactic.replace("_", " ")} · {config.exitTactic.replace("_", " ")}</div></td><td className="p-2 text-right font-mono">{displayPf(config)}</td><td className="p-2 text-right font-mono"><div>{displayRecentPf(config)}</div><div className="text-[10px] text-muted-foreground">{config.recentPositionCount || 0}/12 · {Number(config.recentAvgDrawdownTimeMin || 0).toFixed(1)}m</div></td><td className="p-2 text-right font-mono">{config.maxDrawdownTimeMin.toFixed(1)}m</td><td className={`p-2 text-right font-mono ${config.totalPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatPnl(config.totalPnl)}</td><td className="p-2 text-right font-mono text-muted-foreground">{Number(config.positionCostPercent || 0.1).toFixed(2)}%</td><td className="p-2 text-right font-mono text-muted-foreground">{formatPnl(config.bestMarketExitPnl)}</td><td className="p-2 text-right"><Badge variant={config.valid ? "default" : "secondary"} className="text-[10px]">{config.valid ? "valid" : config.deactivationReason || "inactive"}</Badge></td></tr>)}</tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">PF basis: summed positive/negative ratio-weighted net PnL ({calculation.pfBasis || "aggregate_ratio_weighted_net_pnl"}); it is not an average of row PFs or TP ratios. The TP means (*) are diagnostics only. Target volume: {visibleRows[0]?.blockCount || 0} · {Number(visibleRows[0]?.blockCalculatedVolumeMultiplier || 1).toFixed(2)}×; realized average: {Number(visibleRows[0]?.blockRealizedVolumeMultiplier || 1).toFixed(2)}×. Best market exit is hindsight-only.</p>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-medium">Rolling execution result</h2>
          <div className="mt-3 space-y-2 text-sm">
            <ResultRow label="All closed positions PF" value={stats.profitFactor != null ? Number(stats.profitFactor).toFixed(2) : "—"} />
            <ResultRow label="Realized PnL (exchange notional)" value={stats.totalPnlUsdt != null ? `${Number(stats.totalPnlUsdt).toFixed(4)} USDT` : "—"} />
            <ResultRow label="PF basis" value={stats.statsPnlBasis === "usdt" ? "exchange notional" : "percentage fallback"} />
            <ResultRow label="Win / loss" value={`${stats.winCount || 0} / ${stats.lossCount || 0}`} />
            <ResultRow label="Last 12 positions" value={`PF ${stats.last12Pos?.pf?.toFixed(2) || "—"} · DDT ${stats.last12Pos?.ddt?.toFixed(1) || "0.0"}m`} />
            <ResultRow label="Last 25 positions" value={`PF ${stats.last25Pos?.pf?.toFixed(2) || "—"} · DDT ${stats.last25Pos?.ddt?.toFixed(1) || "0.0"}m`} />
            <ResultRow label="Last 50 positions" value={`PF ${stats.last50Pos?.pf?.toFixed(2) || "—"} · DDT ${stats.last50Pos?.ddt?.toFixed(1) || "0.0"}m`} />
            <ResultRow label="Processor errors (5m)" value={String(status.processor?.errorsLast5min || 0)} />
          </div>
          {error && <p className="mt-4 rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
        </Card>
      </div>
    </div>
  )
}

function Metric({ label, value, icon, emphasis = false }: { label: string; value: string; icon: React.ReactNode; emphasis?: boolean }) {
  return <div className="rounded-lg border bg-background/80 p-3"><div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div><div className={`mt-1 font-mono text-lg font-semibold ${emphasis ? "text-emerald-600" : ""}`}>{value}</div></div>
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 rounded bg-muted/40 px-3 py-2"><span className="text-muted-foreground">{label}</span><span className="font-mono text-right">{value}</span></div>
}
