"use client"

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Clock3,
  Filter,
  Layers3,
  RadioTower,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { StatisticsSectionNav } from "@/components/statistics/statistics-section-nav"
import { toast } from "@/lib/simple-toast"

type WindowKey = "positions12" | "positions50" | "hours8" | "hours48"

interface RangeMetric {
  samples: number
  minimum: number
  maximum: number
  average: number
}

interface WindowMetric {
  trades: number
  wins: number
  losses: number
  flat: number
  grossProfit: number
  grossLoss: number
  netPnl: number
  averagePnl: number
  winRate: number
  profitFactor: number | null
  infiniteProfitFactor: boolean
  drawdown: {
    episodes: number
    inDrawdown: boolean
    maxDepth: number
    currentDepth: number
    averageDurationHours: number
    maxDurationHours: number
    currentDurationHours: number
  }
  protection: {
    stopLossPct: RangeMetric
    takeProfitPct: RangeMetric
    takeProfitStopLossRatio: RangeMetric
    standardTrades: number
    trailingTrades: number
  }
}

interface SymbolRow {
  symbol: string
  disabled?: boolean
  disabledDirections?: { long: boolean; short: boolean }
  openPositions: number
  windows: Record<WindowKey, WindowMetric>
}

interface SignalSourceRow {
  id: string
  name: string
  market: string
  priority: number
  officialDocs: string
  enabled: boolean
  weight: number
  disabledSymbols: string[]
  disabledLanes: string[]
  closedPositions: number
  openPositions: number
  health: {
    successes: number
    failures: number
    consecutiveFailures: number
    lastCandleCount: number
    lastStopLossPct: number
    lastSuccessAt: number
    lastFailureAt: number
    circuitOpenUntil: number
  }
  windows: Record<WindowKey, WindowMetric>
  symbols: SymbolRow[]
}

interface CommonTypeRow {
  type: string
  closedPositions: number
  openPositions: number
  windows: Record<WindowKey, WindowMetric>
  symbols: SymbolRow[]
}

interface AnalyticsPayload {
  success: boolean
  error?: string
  generatedAt: number
  connections: Array<{ id: string; name: string; exchange: string; selected: boolean }>
  selectedConnectionId: string | null
  signal: {
    counts: Record<string, number>
    settings: Record<string, number | boolean | string>
    windows: Record<WindowKey, WindowMetric>
    rankings: Record<WindowKey, { top: Array<{ symbol: string; metric: WindowMetric }>; worst: Array<{ symbol: string; metric: WindowMetric }> }>
    sources: SignalSourceRow[]
  }
  common: {
    counts: Record<string, number>
    windows: Record<WindowKey, WindowMetric>
    rankings: Record<WindowKey, { top: Array<{ symbol: string; metric: WindowMetric }>; worst: Array<{ symbol: string; metric: WindowMetric }> }>
    types: CommonTypeRow[]
  }
}

const WINDOWS: Array<{ key: WindowKey; label: string; short: string }> = [
  { key: "positions12", label: "Last 12 closed positions", short: "Last 12" },
  { key: "positions50", label: "Last 50 closed positions", short: "Last 50" },
  { key: "hours8", label: "Closed in the last 8 hours", short: "8 hours" },
  { key: "hours48", label: "Closed in the last 48 hours", short: "48 hours" },
]

function formatNumber(value: unknown, digits = 2): string {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "0.00"
}

function formatPf(metric: WindowMetric): string {
  if (metric.infiniteProfitFactor) return "∞"
  return metric.profitFactor == null ? "—" : formatNumber(metric.profitFactor)
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function MetricTile({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string
  value: string
  detail: string
  tone?: "default" | "positive" | "negative"
}) {
  return (
    <div className="rounded-xl border bg-card/70 p-3 shadow-sm">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${
        tone === "positive"
          ? "text-emerald-500"
          : tone === "negative"
            ? "text-rose-500"
            : ""
      }`}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
    </div>
  )
}

function WindowDetails({ metric }: { metric: WindowMetric }) {
  return (
    <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Performance</p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span>PF</span><strong className="text-right">{formatPf(metric)}</strong>
          <span>Net PnL</span><strong className="text-right">{formatNumber(metric.netPnl, 4)}</strong>
          <span>Win rate</span><strong className="text-right">{formatNumber(metric.winRate, 1)}%</strong>
          <span>W / L / Flat</span><strong className="text-right">{metric.wins}/{metric.losses}/{metric.flat}</strong>
        </div>
      </div>
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Drawdown time</p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span>Average</span><strong className="text-right">{formatNumber(metric.drawdown.averageDurationHours)}h</strong>
          <span>Maximum</span><strong className="text-right">{formatNumber(metric.drawdown.maxDurationHours)}h</strong>
          <span>Current</span><strong className="text-right">{formatNumber(metric.drawdown.currentDurationHours)}h</strong>
          <span>Episodes</span><strong className="text-right">{metric.drawdown.episodes}</strong>
        </div>
      </div>
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">TP / SL ranges</p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span>SL min–max</span>
          <strong className="text-right">{formatNumber(metric.protection.stopLossPct.minimum)}–{formatNumber(metric.protection.stopLossPct.maximum)}%</strong>
          <span>TP min–max</span>
          <strong className="text-right">{formatNumber(metric.protection.takeProfitPct.minimum)}–{formatNumber(metric.protection.takeProfitPct.maximum)}%</strong>
          <span>Avg TP/SL</span><strong className="text-right">{formatNumber(metric.protection.takeProfitStopLossRatio.average)}×</strong>
          <span>Samples</span><strong className="text-right">{metric.protection.stopLossPct.samples}</strong>
        </div>
      </div>
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Position lanes</p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span>Closed</span><strong className="text-right">{metric.trades}</strong>
          <span>Standard</span><strong className="text-right">{metric.protection.standardTrades}</strong>
          <span>Trailing</span><strong className="text-right">{metric.protection.trailingTrades}</strong>
          <span>Avg PnL</span><strong className="text-right">{formatNumber(metric.averagePnl, 4)}</strong>
        </div>
      </div>
    </div>
  )
}

export function IndicationAnalyticsDashboard({ mode }: { mode: "signal" | "common" }) {
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [connectionId, setConnectionId] = useState("all")
  const [windowKey, setWindowKey] = useState<WindowKey>("positions50")
  const [direction, setDirection] = useState("all")
  const [group, setGroup] = useState("all")
  const [symbolFilter, setSymbolFilter] = useState("")
  const deferredSymbol = useDeferredValue(symbolFilter.trim())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set())
  const [mutatingSymbol, setMutatingSymbol] = useState("")
  const initialLoad = useRef(true)

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    setError("")
    try {
      const params = new URLSearchParams()
      if (connectionId !== "all") params.set("connectionId", connectionId)
      if (direction !== "all") params.set("direction", direction)
      if (group !== "all") params.set("group", group)
      if (deferredSymbol) params.set("symbol", deferredSymbol)
      const response = await fetch(`/api/statistics/indications?${params.toString()}`, {
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || "Statistics request failed")
      setPayload(data)
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load indication statistics"
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [connectionId, deferredSymbol, direction, group])

  useEffect(() => {
    const initial = initialLoad.current
    initialLoad.current = false
    void load(initial)
  }, [load])

  const section = mode === "signal" ? payload?.signal : payload?.common
  const metric = section?.windows?.[windowKey]
  const rankings = section?.rankings?.[windowKey]
  const groups: Array<SignalSourceRow | CommonTypeRow> = useMemo(
    () => mode === "signal" ? payload?.signal?.sources || [] : payload?.common?.types || [],
    [mode, payload],
  )
  const groupOptions = useMemo(() => groups.map((row) => ({
    id: "id" in row ? row.id : row.type,
    label: "name" in row ? row.name : titleCase(row.type),
  })), [groups])
  const rankingChart = useMemo(() => {
    const rows = new Map<string, { symbol: string; pnl: number; segment: "Top" | "Worst" }>()
    for (const row of rankings?.top || []) rows.set(`top:${row.symbol}`, {
      symbol: row.symbol,
      pnl: row.metric.netPnl,
      segment: "Top",
    })
    for (const row of rankings?.worst || []) rows.set(`worst:${row.symbol}`, {
      symbol: row.symbol,
      pnl: row.metric.netPnl,
      segment: "Worst",
    })
    return [...rows.values()]
  }, [rankings])

  const toggleExpanded = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) => {
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSignalSymbol = async (
    sourceId: string,
    symbol: string,
    enabled: boolean,
    direction?: "long" | "short",
  ) => {
    const mutationKey = `${sourceId}:${symbol}:${direction || "all"}`
    setMutatingSymbol(mutationKey)
    try {
      const response = await fetch("/api/statistics/indications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, symbol, enabled, direction }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || "Symbol update failed")
      toast.success(data.message || `${symbol} updated`)
      await load(false)
    } catch (mutationError) {
      toast.error(mutationError instanceof Error ? mutationError.message : "Failed to update symbol")
    } finally {
      setMutatingSymbol("")
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 p-3 sm:p-4">
        <StatisticsSectionNav />
        <div className="grid min-h-[60vh] place-items-center rounded-2xl border bg-card/50">
          <div className="text-center">
            <RefreshCw className="mx-auto h-6 w-6 animate-spin text-primary" />
            <p className="mt-3 text-sm font-medium">Loading complete indication statistics…</p>
            <p className="mt-1 text-xs text-muted-foreground">Closed-position PF, DDT and protection windows</p>
          </div>
        </div>
      </div>
    )
  }

  if (!payload || !section || !metric || !rankings) {
    return (
      <div className="space-y-4 p-3 sm:p-4">
        <StatisticsSectionNav />
        <Card className="border-rose-500/30">
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm font-medium">Statistics could not be loaded</p>
            <p className="text-xs text-muted-foreground">{error || "No response data"}</p>
            <Button size="sm" onClick={() => void load(true)}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const modeTitle = mode === "signal" ? "Signal Engine Statistics" : "Common Indication Statistics"
  const ModeIcon = mode === "signal" ? RadioTower : Layers3
  const counts = section.counts

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <StatisticsSectionNav />

      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-primary/5 p-4 shadow-sm">
        <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ModeIcon className="h-5 w-5 text-primary" />
              {modeTitle}
            </h1>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              PF and equity drawdown-time use only closed positions from the identical selected window.
              Open positions remain separate. Rankings contain at most 12 symbols per side.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-7 bg-background/70">
              Updated {new Date(payload.generatedAt).toLocaleTimeString()}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => void load(false)} disabled={refreshing}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <Card className="border-primary/20">
        <CardContent className="grid gap-3 p-3 lg:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger size="sm" className="min-w-44">
                <SelectValue placeholder="All connections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All connections</SelectItem>
                {payload.connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name} · {connection.exchange}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger size="sm" className="min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Long + Short</SelectItem>
                <SelectItem value="long">Long only</SelectItem>
                <SelectItem value="short">Short only</SelectItem>
              </SelectContent>
            </Select>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger size="sm" className="min-w-44">
                <SelectValue placeholder={mode === "signal" ? "All sources" : "All types"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{mode === "signal" ? "All sources" : "All types"}</SelectItem>
                {groupOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative min-w-44 flex-1">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder="Filter symbols…"
                value={symbolFilter}
                onChange={(event) => setSymbolFilter(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {WINDOWS.map((window) => (
              <Button
                key={window.key}
                size="sm"
                variant={windowKey === window.key ? "default" : "outline"}
                className="h-8 px-2.5 text-[11px]"
                title={window.label}
                onClick={() => setWindowKey(window.key)}
              >
                {window.short}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        <MetricTile
          label="Closed sample"
          value={String(metric.trades)}
          detail={`${metric.wins} wins · ${metric.losses} losses`}
        />
        <MetricTile
          label="Profit factor"
          value={formatPf(metric)}
          detail={`Gross +${formatNumber(metric.grossProfit)} / −${formatNumber(metric.grossLoss)}`}
          tone={metric.netPnl > 0 ? "positive" : metric.netPnl < 0 ? "negative" : "default"}
        />
        <MetricTile
          label="Net PnL"
          value={formatNumber(metric.netPnl, 4)}
          detail={`${formatNumber(metric.averagePnl, 4)} average`}
          tone={metric.netPnl > 0 ? "positive" : metric.netPnl < 0 ? "negative" : "default"}
        />
        <MetricTile
          label="DDT max"
          value={`${formatNumber(metric.drawdown.maxDurationHours)}h`}
          detail={`${metric.drawdown.episodes} drawdown episodes`}
          tone={metric.drawdown.inDrawdown ? "negative" : "default"}
        />
        <MetricTile
          label="TP / SL"
          value={`${formatNumber(metric.protection.takeProfitStopLossRatio.average)}×`}
          detail={`${formatNumber(metric.protection.stopLossPct.average)}% / ${formatNumber(metric.protection.takeProfitPct.average)}%`}
        />
        <MetricTile
          label="Open now"
          value={String(Number(counts.openPositions || 0))}
          detail={`${Number(counts.closedPositions || 0)} closed after filters`}
        />
      </div>

      {mode === "signal" && (
        <Card className="border-emerald-500/20 bg-emerald-500/[0.025]">
          <CardContent className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Request interval", `${payload.signal.settings.requestIntervalSeconds}s`, "Hard minimum 30 seconds"],
              [
                "Direct bootstrap",
                payload.signal.settings.directExecutionEnabled ? "Enabled" : "PF-gated",
                "Source 12 · source/symbol/direction 10",
              ],
              ["Website sources", String(payload.signal.settings.maxSourcesPerCycle), "Independent public feeds per symbol cycle"],
              ["Position capacity", `${payload.signal.settings.maxPositionsTotal} total`, "Long + Short physical Signal positions"],
              ["Selection", "Best first", "Quality · confidence · agreement · R/R"],
              ["Trailing mode", payload.signal.settings.trailingEnabled ? "Enabled" : "Disabled", payload.signal.settings.trailingOnly ? "Trailing only" : "Parallel standard + trailing"],
              ["Trailing stop", `${payload.signal.settings.trailingMinStopPct}% min`, `Market ratio ${payload.signal.settings.trailingPositiveMoveRatio}`],
              ["Update range", String(payload.signal.settings.trailingUpdateStopRangeRatio), `${counts.trailingClosedPositions || 0} trailing closes`],
            ].map(([label, value, detail]) => (
              <div key={String(label)} className="rounded-lg border bg-background/60 p-2.5">
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold">{String(value)}</p>
                <p className="text-[10px] text-muted-foreground">{String(detail)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BarChart3 className="h-4 w-4 text-primary" />
              Best / worst symbol diagram
            </CardTitle>
            <CardDescription className="text-xs">
              Net realized PnL for the selected closed-position window.
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72 p-2 pt-0">
            {rankingChart.length === 0 ? (
              <div className="grid h-full place-items-center text-xs text-muted-foreground">
                No closed positions in this window.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rankingChart} margin={{ top: 12, right: 10, bottom: 36, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                  <XAxis
                    dataKey="symbol"
                    angle={-38}
                    textAnchor="end"
                    interval={0}
                    height={58}
                    tick={{ fontSize: 9 }}
                  />
                  <YAxis tick={{ fontSize: 9 }} width={48} />
                  <Tooltip
                    formatter={(value) => [formatNumber(value, 4), "Net PnL"]}
                    contentStyle={{ borderRadius: 10, fontSize: 11 }}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {rankingChart.map((row, index) => (
                      <Cell
                        key={`${row.segment}:${row.symbol}:${index}`}
                        fill={row.pnl >= 0 ? "#10b981" : "#f43f5e"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-cyan-500" />
              Protection range overview
            </CardTitle>
            <CardDescription className="text-xs">Assigned Signal/Common protection on closed positions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: "Stop loss",
                metric: metric.protection.stopLossPct,
                suffix: "%",
                color: "bg-rose-500",
              },
              {
                label: "Take profit",
                metric: metric.protection.takeProfitPct,
                suffix: "%",
                color: "bg-emerald-500",
              },
              {
                label: "TP / SL ratio",
                metric: metric.protection.takeProfitStopLossRatio,
                suffix: "×",
                color: "bg-cyan-500",
              },
            ].map((row) => {
              const width = row.metric.maximum > 0
                ? Math.min(100, (row.metric.average / row.metric.maximum) * 100)
                : 0
              return (
                <div key={row.label} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{row.label}</span>
                    <strong className="tabular-nums">{formatNumber(row.metric.average)}{row.suffix} avg</strong>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full ${row.color}`} style={{ width: `${width}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                    <span>min {formatNumber(row.metric.minimum)}{row.suffix}</span>
                    <span>{row.metric.samples} samples</span>
                    <span>max {formatNumber(row.metric.maximum)}{row.suffix}</span>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {[
          { title: "Top / optimal performing symbols", rows: rankings.top, icon: TrendingUp, tone: "text-emerald-500" },
          { title: "Worst performing symbols", rows: rankings.worst, icon: TrendingDown, tone: "text-rose-500" },
        ].map((ranking) => (
          <Card key={ranking.title}>
            <CardHeader className="pb-2">
              <CardTitle className={`flex items-center gap-2 text-sm ${ranking.tone}`}>
                <ranking.icon className="h-4 w-4" />
                {ranking.title}
                <Badge variant="outline" className="ml-auto">{ranking.rows.length}/12</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {ranking.rows.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No closed positions in this window.
                </p>
              ) : ranking.rows.map((row, index) => (
                <div key={`${ranking.title}:${row.symbol}`} className="grid grid-cols-[24px_1fr_auto_auto] items-center gap-2 rounded-lg border px-2.5 py-2 text-xs">
                  <span className="text-center text-[10px] text-muted-foreground">{index + 1}</span>
                  <span className="flex items-center gap-1.5 font-mono font-medium">
                    {row.symbol}
                    {ranking.title.startsWith("Top") && index === 0 && (
                      <Badge className="h-4 px-1 text-[8px]">Optimal</Badge>
                    )}
                  </span>
                  <span className="tabular-nums">PF {formatPf(row.metric)}</span>
                  <span className={`min-w-20 text-right tabular-nums ${row.metric.netPnl < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                    {formatNumber(row.metric.netPnl, 4)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                {mode === "signal" ? "Source → symbol performance tree" : "Indication type → symbol performance tree"}
              </CardTitle>
              <CardDescription className="text-xs">
                Best-performing symbols first. Expand a group, then click a symbol for every PF/DDT and protection window.
              </CardDescription>
            </div>
            <Badge variant="secondary">{groups.length} {mode === "signal" ? "sources" : "types"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="max-h-[920px] space-y-2 overflow-auto p-3">
          {groups.map((row) => {
            const groupId = "id" in row ? row.id : row.type
            const groupLabel = "name" in row ? row.name : titleCase(row.type)
            const groupMetric = row.windows[windowKey]
            const groupOpen = expandedGroups.has(groupId)
            return (
              <Collapsible key={groupId} open={groupOpen}>
                <div className="overflow-hidden rounded-xl border bg-card">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 p-3 text-left transition-colors hover:bg-muted/30"
                      onClick={() => toggleExpanded(setExpandedGroups, groupId)}
                    >
                      {groupOpen
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{groupLabel}</span>
                          {"priority" in row && <Badge variant="outline" className="text-[9px]">P{row.priority}</Badge>}
                          {"market" in row && <Badge variant="secondary" className="text-[9px]">{row.market}</Badge>}
                          {"enabled" in row && (
                            <Badge variant={row.enabled ? "secondary" : "destructive"} className="text-[9px]">
                              {row.enabled ? "source enabled" : "source disabled"}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {row.symbols.length} symbols · {row.closedPositions} closed · {row.openPositions} open
                          {"weight" in row ? ` · weight ${formatNumber(row.weight, 2)}` : ""}
                          {"health" in row
                            ? ` · HTTP ${row.health.successes}/${row.health.failures} · ${row.health.lastCandleCount} candles`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-right text-xs">
                        <span className="hidden sm:block">
                          <span className="text-muted-foreground">PF </span>{formatPf(groupMetric)}
                        </span>
                        <span className={groupMetric.netPnl < 0 ? "text-rose-500" : "text-emerald-500"}>
                          {formatNumber(groupMetric.netPnl, 4)}
                        </span>
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t bg-muted/[0.08] p-2">
                      <div className="grid gap-2 xl:grid-cols-2">
                        {WINDOWS.map((window) => (
                          <div key={window.key} className={`rounded-xl border ${
                            windowKey === window.key ? "border-primary/40 bg-primary/[0.025]" : "bg-background/50"
                          }`}>
                            <div className="flex items-center justify-between border-b px-3 py-2">
                              <span className="text-[10px] font-semibold uppercase tracking-wide">{window.short}</span>
                              <Badge variant="outline" className="text-[9px]">
                                {row.windows[window.key].trades} closed
                              </Badge>
                            </div>
                            <WindowDetails metric={row.windows[window.key]} />
                          </div>
                        ))}
                      </div>
                      {"health" in row && (
                        <div className="mb-2 grid gap-2 rounded-lg border bg-background/70 p-2 text-[10px] sm:grid-cols-4">
                          <span><span className="text-muted-foreground">Requests OK </span><strong>{row.health.successes}</strong></span>
                          <span><span className="text-muted-foreground">Failures </span><strong>{row.health.failures}</strong></span>
                          <span><span className="text-muted-foreground">Last source SL </span><strong>{formatNumber(row.health.lastStopLossPct, 3)}%</strong></span>
                          <span>
                            <span className="text-muted-foreground">Circuit </span>
                            <strong className={row.health.circuitOpenUntil > Date.now() ? "text-rose-500" : "text-emerald-500"}>
                              {row.health.circuitOpenUntil > Date.now() ? "open" : "ready"}
                            </strong>
                          </span>
                        </div>
                      )}
                      <div className="space-y-1.5">
                        {row.symbols.map((symbolRow, index) => {
                          const symbolKey = `${groupId}:${symbolRow.symbol}`
                          const symbolOpen = expandedSymbols.has(symbolKey)
                          const symbolMetric = symbolRow.windows[windowKey]
                          const mutating = mutatingSymbol.startsWith(`${symbolKey}:`)
                          return (
                            <Collapsible key={symbolKey} open={symbolOpen}>
                              <div className={`overflow-hidden rounded-lg border bg-background ${
                                symbolRow.disabled ? "opacity-60" : ""
                              }`}>
                                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-2.5 py-2">
                                  <CollapsibleTrigger asChild>
                                    <button
                                      type="button"
                                      className="flex min-w-0 items-center gap-2 text-left"
                                      onClick={() => toggleExpanded(setExpandedSymbols, symbolKey)}
                                    >
                                      {symbolOpen
                                        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                        : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                      <span className="w-5 text-[9px] text-muted-foreground">{index + 1}</span>
                                      <span className="truncate font-mono text-xs font-semibold">{symbolRow.symbol}</span>
                                      {symbolRow.openPositions > 0 && (
                                        <Badge variant="outline" className="text-[9px]">{symbolRow.openPositions} open</Badge>
                                      )}
                                    </button>
                                  </CollapsibleTrigger>
                                  <div className="flex items-center gap-3 text-[10px]">
                                    <span><span className="text-muted-foreground">Pos </span>{symbolMetric.trades}</span>
                                    <span><span className="text-muted-foreground">PF </span>{formatPf(symbolMetric)}</span>
                                    <span><span className="text-muted-foreground">DDT </span>{formatNumber(symbolMetric.drawdown.maxDurationHours)}h</span>
                                    <span className={symbolMetric.netPnl < 0 ? "text-rose-500" : "text-emerald-500"}>
                                      {formatNumber(symbolMetric.netPnl, 4)}
                                    </span>
                                  </div>
                                  {mode === "signal" && "id" in row ? (
                                    <div
                                      className="flex items-center gap-2"
                                      title="Enable this source symbol globally or independently for Long and Short"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      {([
                                        ["All", undefined, !symbolRow.disabled],
                                        ["L", "long", !symbolRow.disabledDirections?.long],
                                        ["S", "short", !symbolRow.disabledDirections?.short],
                                      ] as const).map(([label, laneDirection, checked]) => (
                                        <label key={label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                          {label}
                                          <Switch
                                            checked={checked}
                                            disabled={mutating}
                                            onCheckedChange={(enabled) =>
                                              void toggleSignalSymbol(
                                                row.id,
                                                symbolRow.symbol,
                                                enabled,
                                                laneDirection,
                                              )
                                            }
                                          />
                                        </label>
                                      ))}
                                    </div>
                                  ) : <span />}
                                </div>
                                <CollapsibleContent>
                                  <div className="border-t">
                                    <div className="grid gap-2 p-2 xl:grid-cols-2">
                                      {WINDOWS.map((window) => (
                                        <div key={window.key} className={`rounded-xl border ${
                                          windowKey === window.key ? "border-primary/40 bg-primary/[0.025]" : ""
                                        }`}>
                                          <div className="flex items-center justify-between border-b px-3 py-2">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide">{window.short}</span>
                                            <Badge variant="outline" className="text-[9px]">
                                              {symbolRow.windows[window.key].trades} closed
                                            </Badge>
                                          </div>
                                          <WindowDetails metric={symbolRow.windows[window.key]} />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </CollapsibleContent>
                              </div>
                            </Collapsible>
                          )
                        })}
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )
          })}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/15 px-3 py-2 text-[10px] text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        <span>Filters are applied server-side.</span>
        <CircleGauge className="ml-2 h-3.5 w-3.5" />
        <span>PF = gross profit / gross loss.</span>
        <Clock3 className="ml-2 h-3.5 w-3.5" />
        <span>DDT is equity-curve time below the prior peak.</span>
        <Activity className="ml-2 h-3.5 w-3.5" />
        <span>Open positions never enter PF/DDT.</span>
      </div>
    </div>
  )
}
