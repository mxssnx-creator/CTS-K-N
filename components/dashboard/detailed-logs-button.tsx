"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUp,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Cpu,
  Database,
  FileText,
  Gauge,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Terminal,
  Wifi,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

type LogLevel = "debug" | "info" | "warn" | "warning" | "error"
type SectionId =
  | "overview"
  | "activity"
  | "processing"
  | "settings"
  | "orders"
  | "warnings"
  | "errors"
  | "system"

type DetailedLog = {
  id: string
  timestamp: string
  level?: LogLevel
  type: string
  category?: string
  phase: string
  message: string
  connectionId?: string
  symbol?: string
  details?: Record<string, unknown>
}

type MonitorAlert = {
  id: string
  level: "critical" | "warning" | "info"
  category: string
  message: string
  timestamp: string
  connectionId?: string
  details?: Record<string, unknown>
}

type ConnectionMonitor = {
  id: string
  name: string
  exchange: string
  dashboardEnabled: boolean
  symbols: string[]
  prehistoric: {
    loaded: boolean
    symbolsProcessed: number
    symbolsTotal: number
    candlesProcessed: number
    indicationResults: number
    strategyPositions: number
    errors: number
  }
  cycles: {
    indication: number
    strategy: number
    realtime: number
  }
  liveMetrics: {
    ordersPlaced: number
    ordersFilled: number
    ordersFailed: number
    ordersRejected: number
    ordersSimulated: number
  }
  signalCapacity?: {
    total: number
    long: number
    short: number
    limit: number
    remaining: number
    selectionMode: string
    state: string
    updatedAt: string | null
    ageMs: number | null
  }
  lifecycle: {
    status: "running" | "gated" | "stalled" | "disabled" | string
    heartbeatAt: string | null
    heartbeatAgeMs: number | null
    heartbeatFresh: boolean
    lastProgressAt: string | null
    progressAgeMs: number | null
    stalled: boolean
    selectionEpoch: string | null
    historicSelectionEpoch: string | null
    generationMatches: boolean
    bootstrapStatus: string
    bootstrapGeneration: number
    retryAttempt: number
    entryProcessorsGated: boolean
    settingsRequestedVersion: string | null
    settingsAppliedVersion: string | null
    settingsSynchronized: boolean
    stateSwitchVersion: string | null
    lastError: string | null
    recoordinationReason: string | null
  }
}

type DetailedLogsResponse = {
  success: boolean
  logs?: DetailedLog[]
  summary?: {
    symbolsActive?: number
    indicationCycles?: number
    strategyCycles?: number
    realtimeCycles?: number
    avgCycleDuration?: number
    errors?: number
    warnings?: number
    prehistoricProcessing?: {
      symbolsProcessed?: number
      symbolsTotal?: number
      candlesProcessed?: number
      indicationResults?: number
      strategyPositions?: number
      errors?: number
    }
    liveExecution?: {
      ordersPlaced?: number
      ordersFilled?: number
      ordersFailed?: number
      ordersRejected?: number
      ordersSimulated?: number
      positionsOpen?: number
    }
  } | null
  monitoring?: {
    status?: "healthy" | "warning" | "critical"
    alerts?: MonitorAlert[]
    sectionCounts?: Partial<Record<SectionId, number>>
    connections?: ConnectionMonitor[]
  }
  timestamp?: string
  error?: string
}

const SECTIONS: Array<{
  id: SectionId
  label: string
  icon: typeof Activity
}> = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "processing", label: "Processing", icon: Cpu },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "orders", label: "Orders", icon: ShieldAlert },
  { id: "warnings", label: "Warnings", icon: AlertTriangle },
  { id: "errors", label: "Errors", icon: XCircle },
  { id: "system", label: "System", icon: Terminal },
]

function levelFor(log: DetailedLog): LogLevel {
  if (log.level) return log.level
  if (log.type === "error") return "error"
  if (log.type === "warning") return "warning"
  return "info"
}

function isWarning(log: DetailedLog): boolean {
  const level = levelFor(log)
  return level === "warn" || level === "warning" || log.type === "warning"
}

function isError(log: DetailedLog): boolean {
  return levelFor(log) === "error" || log.type === "error"
}

function belongsToSection(log: DetailedLog, section: SectionId): boolean {
  const phase = String(log.phase || "").toLowerCase()
  const category = String(log.category || "").toLowerCase()
  if (section === "overview") return true
  if (section === "errors") return isError(log)
  if (section === "warnings") return isWarning(log)
  if (section === "system") return phase.startsWith("system_")
  if (section === "settings") {
    return log.type === "settings" || phase.includes("setting") || phase.includes("recoordination") || phase.includes("toggle")
  }
  if (section === "orders") {
    return category === "orders" || log.type === "live" || phase.includes("order")
  }
  if (section === "processing") {
    return (
      log.type === "processing" ||
      log.type === "indication" ||
      log.type === "strategy" ||
      phase.includes("prehistoric") ||
      phase.includes("historic")
    )
  }
  return !isError(log) && !isWarning(log)
}

function formatAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return "never"
  if (ageMs < 1_000) return "now"
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`
  return `${Math.floor(ageMs / 3_600_000)}h`
}

function formatTimestamp(value?: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function progressPercent(current = 0, total = 0): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)))
}

function statusTone(status?: string): string {
  if (status === "critical" || status === "stalled") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
  }
  if (status === "warning" || status === "gated") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  if (status === "healthy" || status === "running") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  return "border-border bg-muted/60 text-muted-foreground"
}

function alertTone(level: MonitorAlert["level"]): string {
  if (level === "critical") return "border-red-500/30 bg-red-500/10"
  if (level === "warning") return "border-amber-500/30 bg-amber-500/10"
  return "border-sky-500/30 bg-sky-500/10"
}

export function DetailedLogsButton() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<DetailedLogsResponse | null>(null)
  const [section, setSection] = useState<SectionId>("overview")
  const [connectionFilter, setConnectionFilter] = useState("all")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const requestSequence = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const loadLogs = useCallback(async (quiet = false) => {
    const sequence = ++requestSequence.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/trade-engine/detailed-logs", {
        cache: "no-store",
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const next = (await response.json()) as DetailedLogsResponse
      if (sequence !== requestSequence.current) return
      if (!next.success) throw new Error(next.error || "Detailed monitoring request failed")
      setData({
        ...next,
        logs: Array.isArray(next.logs) ? next.logs : [],
        monitoring: {
          ...next.monitoring,
          alerts: Array.isArray(next.monitoring?.alerts) ? next.monitoring.alerts : [],
          connections: Array.isArray(next.monitoring?.connections) ? next.monitoring.connections : [],
        },
      })
    } catch (err) {
      if (controller.signal.aborted) return
      if (sequence === requestSequence.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (!quiet && sequence === requestSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      return
    }
    void loadLogs(false)
    if (paused) return
    const timer = window.setInterval(() => void loadLogs(true), 10_000)
    return () => {
      window.clearInterval(timer)
      abortRef.current?.abort()
    }
  }, [loadLogs, open, paused])

  const logs = data?.logs || []
  const alerts = data?.monitoring?.alerts || []
  const connections = data?.monitoring?.connections || []
  const summary = data?.summary
  const monitorStatus = data?.monitoring?.status || (error ? "critical" : "healthy")

  const visibleAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      if (connectionFilter !== "all" && alert.connectionId && alert.connectionId !== connectionFilter) return false
      if (section === "warnings" && alert.level !== "warning") return false
      if (section === "errors" && alert.level !== "critical") return false
      if (!["overview", "warnings", "errors"].includes(section)) return false
      const text = `${alert.category} ${alert.message} ${alert.connectionId || ""}`.toLowerCase()
      return !query || text.includes(query.toLowerCase())
    })
  }, [alerts, connectionFilter, query, section])

  const visibleLogs = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return logs.filter((log) => {
      if (!belongsToSection(log, section)) return false
      if (connectionFilter !== "all" && log.connectionId !== connectionFilter) return false
      if (!needle) return true
      return [
        log.message,
        log.phase,
        log.category,
        log.connectionId,
        log.symbol,
      ].some((value) => String(value || "").toLowerCase().includes(needle))
    })
  }, [connectionFilter, logs, query, section])

  const filteredConnections = useMemo(
    () => connectionFilter === "all" ? connections : connections.filter((item) => item.id === connectionFilter),
    [connectionFilter, connections],
  )

  const counts = data?.monitoring?.sectionCounts || {}
  const criticalCount = alerts.filter((alert) => alert.level === "critical").length
  const warningCount = alerts.filter((alert) => alert.level === "warning").length

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          requestSequence.current++
          abortRef.current?.abort()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-border/70 bg-background/70 px-2 text-[11px] shadow-sm backdrop-blur"
          title="Open complete system monitoring, alerts, warnings, errors, and activity logs"
        >
          <span className="relative">
            <FileText className="h-3.5 w-3.5" />
            <CircleDot
              className={`absolute -right-1.5 -top-1.5 h-2.5 w-2.5 ${
                monitorStatus === "critical"
                  ? "text-red-500"
                  : monitorStatus === "warning"
                    ? "text-amber-500"
                    : "text-emerald-500"
              }`}
            />
          </span>
          Detailed Logs
          {(criticalCount > 0 || warningCount > 0) && (
            <Badge
              variant="outline"
              className="h-4 min-w-4 border-amber-500/30 px-1 text-[9px] leading-none text-amber-700 dark:text-amber-300"
            >
              {criticalCount + warningCount}
            </Badge>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="flex h-[88vh] w-[96vw] max-w-[1180px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1180px]">
        <DialogHeader className="border-b bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-7">
            <div>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Terminal className="h-4 w-4 text-primary" />
                Detailed Logs · System Monitor
                <Badge variant="outline" className={`h-5 text-[9px] uppercase ${statusTone(monitorStatus)}`}>
                  {monitorStatus}
                </Badge>
              </DialogTitle>
              <DialogDescription className="mt-1 text-[10px] leading-relaxed">
                Engine lifecycle, historic processing, settings coordination, orders, system activity, warnings, and errors.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-1">
              <Badge variant="outline" className="h-6 gap-1 px-2 font-mono text-[9px]">
                <Clock3 className="h-3 w-3" />
                {data?.timestamp ? formatTimestamp(data.timestamp) : "not loaded"}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={() => setPaused((value) => !value)}
                title={paused ? "Resume automatic refresh" : "Pause automatic refresh"}
              >
                {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {paused ? "Resume" : "Live 10s"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={() => void loadLogs(false)}
                disabled={loading}
              >
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
          <div className="bg-background px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">System health</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold capitalize">
              {monitorStatus === "healthy" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : monitorStatus === "warning" ? (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 text-red-500" />
              )}
              {monitorStatus}
            </div>
          </div>
          <div className="bg-background px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Connections</div>
            <div className="mt-1 text-[11px] font-semibold tabular-nums">
              {connections.filter((item) => item.dashboardEnabled).length}/{connections.length} enabled
            </div>
          </div>
          <div className="bg-background px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Symbols monitored</div>
            <div className="mt-1 text-[11px] font-semibold tabular-nums">{summary?.symbolsActive || 0}</div>
          </div>
          <div className="bg-background px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Open alerts</div>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold tabular-nums">
              <span className={criticalCount ? "text-red-600 dark:text-red-400" : ""}>{criticalCount} critical</span>
              <span className={warningCount ? "text-amber-600 dark:text-amber-400" : ""}>{warningCount} warn</span>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="shrink-0 border-b bg-muted/10 p-2 md:w-40 md:border-b-0 md:border-r">
            <div className="grid grid-cols-4 gap-1 md:grid-cols-1">
              {SECTIONS.map((item) => {
                const Icon = item.icon
                const count =
                  item.id === "warnings"
                    ? Number(counts.warnings ?? warningCount)
                    : item.id === "errors"
                      ? Number(counts.errors ?? criticalCount)
                      : Number(counts[item.id] || 0)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={`flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[10px] transition-colors ${
                      section === item.id
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {count > 0 && (
                      <span className="ml-auto hidden min-w-4 rounded-full bg-background/20 px-1 text-center font-mono text-[8px] md:inline">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <div className="relative min-w-[170px] flex-1">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search message, phase, symbol…"
                  className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-[10px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
              </div>
              <select
                aria-label="Connection filter"
                value={connectionFilter}
                onChange={(event) => setConnectionFilter(event.target.value)}
                className="h-7 max-w-[220px] rounded-md border bg-background px-2 text-[10px] outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All connections</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} · {connection.exchange}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              >
                <ArrowUp className="h-3 w-3" />
                Top
              </Button>
            </div>

            {error && (
              <div className="m-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-700 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <div className="font-semibold">Monitoring refresh failed</div>
                  <div className="mt-0.5 font-mono">{error}</div>
                  {data && <div className="mt-0.5 text-muted-foreground">Showing the last successful snapshot.</div>}
                </div>
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1" viewportRef={scrollContainerRef}>
              <div className="space-y-2 p-3">
                {loading && !data && (
                  <div className="flex items-center justify-center gap-2 py-16 text-[11px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading complete monitoring snapshot…
                  </div>
                )}

                {section === "overview" && data && (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <MetricCard
                        icon={Cpu}
                        label="Engine cycles"
                        value={`${summary?.indicationCycles || 0} / ${summary?.strategyCycles || 0} / ${summary?.realtimeCycles || 0}`}
                        detail="indication / strategy / realtime"
                      />
                      <MetricCard
                        icon={Database}
                        label="Historic symbols"
                        value={`${summary?.prehistoricProcessing?.symbolsProcessed || 0}/${summary?.prehistoricProcessing?.symbolsTotal || 0}`}
                        detail={`${summary?.prehistoricProcessing?.candlesProcessed || 0} candles`}
                      />
                      <MetricCard
                        icon={ShieldAlert}
                        label="Order handling"
                        value={`${summary?.liveExecution?.ordersFilled || 0}/${summary?.liveExecution?.ordersPlaced || 0}`}
                        detail={`${summary?.liveExecution?.ordersFailed || 0} failed · ${summary?.liveExecution?.ordersRejected || 0} rejected`}
                      />
                    </div>

                    <SectionLabel icon={Bell} title="Alerts and warnings" count={visibleAlerts.length} />
                    {visibleAlerts.length === 0 ? (
                      <EmptyState icon={CheckCircle2} text="No active alerts for this scope." tone="text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <div className="space-y-1.5">
                        {visibleAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
                      </div>
                    )}

                    <SectionLabel icon={Wifi} title="Connection lifecycle" count={filteredConnections.length} />
                    <div className="grid gap-2 lg:grid-cols-2">
                      {filteredConnections.map((connection) => (
                        <ConnectionLifecycleCard key={connection.id} connection={connection} />
                      ))}
                    </div>
                  </>
                )}

                {(section === "warnings" || section === "errors") && visibleAlerts.length > 0 && (
                  <>
                    <SectionLabel
                      icon={section === "errors" ? XCircle : AlertTriangle}
                      title={section === "errors" ? "Critical alerts" : "Warnings"}
                      count={visibleAlerts.length}
                    />
                    <div className="space-y-1.5">
                      {visibleAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
                    </div>
                  </>
                )}

                {section !== "overview" && (
                  <>
                    <SectionLabel
                      icon={SECTIONS.find((item) => item.id === section)?.icon || FileText}
                      title={`${SECTIONS.find((item) => item.id === section)?.label || "Logs"} log stream`}
                      count={visibleLogs.length}
                    />
                    <LogStream
                      logs={visibleLogs}
                      expandedIds={expandedIds}
                      onToggle={toggleExpanded}
                    />
                  </>
                )}

                {section === "overview" && data && (
                  <>
                    <SectionLabel icon={Activity} title="Recent activity" count={Math.min(20, visibleLogs.length)} />
                    <LogStream
                      logs={visibleLogs.slice(0, 20)}
                      expandedIds={expandedIds}
                      onToggle={toggleExpanded}
                    />
                  </>
                )}
              </div>
            </ScrollArea>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5 shadow-sm">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-sm font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[9px] text-muted-foreground">{detail}</div>
    </div>
  )
}

function SectionLabel({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof Activity
  title: string
  count: number
}) {
  return (
    <div className="flex items-center gap-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {title}
      <Badge variant="outline" className="ml-1 h-4 px-1 font-mono text-[8px]">{count}</Badge>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  text,
  tone = "text-muted-foreground",
}: {
  icon: typeof Activity
  text: string
  tone?: string
}) {
  return (
    <div className={`flex items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-[10px] ${tone}`}>
      <Icon className="h-4 w-4" />
      {text}
    </div>
  )
}

function AlertRow({ alert }: { alert: MonitorAlert }) {
  const Icon = alert.level === "critical" ? XCircle : alert.level === "warning" ? AlertTriangle : Bell
  return (
    <div className={`rounded-lg border p-2.5 ${alertTone(alert.level)}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
          alert.level === "critical"
            ? "text-red-500"
            : alert.level === "warning"
              ? "text-amber-500"
              : "text-sky-500"
        }`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold">{alert.message}</span>
            <Badge variant="outline" className="h-4 px-1 text-[8px]">{alert.category}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[9px] text-muted-foreground">
            <span>{formatTimestamp(alert.timestamp)}</span>
            {alert.connectionId && <span className="font-mono">conn={alert.connectionId}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function ConnectionLifecycleCard({ connection }: { connection: ConnectionMonitor }) {
  const lifecycle = connection.lifecycle
  const signalCapacity = connection.signalCapacity || {
    total: 0,
    long: 0,
    short: 0,
    limit: 120,
    remaining: 120,
    selectionMode: "best_first",
    state: "idle",
    updatedAt: null,
    ageMs: null,
  }
  const processed = connection.prehistoric.symbolsProcessed || 0
  const total = connection.prehistoric.symbolsTotal || connection.symbols.length
  const percent = progressPercent(processed, total)
  return (
    <div className="rounded-lg border bg-card p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold">{connection.name}</div>
          <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
            {connection.exchange} · {connection.id}
          </div>
        </div>
        <Badge variant="outline" className={`h-5 shrink-0 text-[8px] uppercase ${statusTone(lifecycle.status)}`}>
          {lifecycle.status}
        </Badge>
      </div>

      <div className="mt-2">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Historic processing</span>
          <span className="font-mono tabular-nums">{processed}/{total} · {percent}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-[width] ${
              lifecycle.stalled ? "bg-red-500" : lifecycle.entryProcessorsGated ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
        <LifecycleDatum
          label="Heartbeat"
          value={lifecycle.heartbeatAgeMs == null ? "never" : `${formatAge(lifecycle.heartbeatAgeMs)} ago`}
          good={lifecycle.heartbeatFresh || !connection.dashboardEnabled}
        />
        <LifecycleDatum
          label="Progress"
          value={lifecycle.progressAgeMs == null ? "never" : `${formatAge(lifecycle.progressAgeMs)} ago`}
          good={!connection.dashboardEnabled || !lifecycle.stalled}
        />
        <LifecycleDatum
          label="Generation"
          value={!connection.dashboardEnabled ? "preserved" : lifecycle.generationMatches ? "coordinated" : "superseded"}
          good={!connection.dashboardEnabled || lifecycle.generationMatches}
        />
        <LifecycleDatum
          label="Settings"
          value={!connection.dashboardEnabled ? "on next enable" : lifecycle.settingsSynchronized ? "applied" : "pending"}
          good={!connection.dashboardEnabled || lifecycle.settingsSynchronized}
        />
        <LifecycleDatum
          label="Bootstrap"
          value={`${lifecycle.bootstrapStatus}${lifecycle.retryAttempt ? ` · retry ${lifecycle.retryAttempt}` : ""}`}
          good={!connection.dashboardEnabled || !["retry_wait", "error"].includes(lifecycle.bootstrapStatus)}
        />
        <LifecycleDatum
          label="Entry loops"
          value={!connection.dashboardEnabled ? "stopped" : lifecycle.entryProcessorsGated ? "safely gated" : "active"}
          good={!connection.dashboardEnabled || !lifecycle.stalled}
        />
        <LifecycleDatum
          label="Signal capacity"
          value={`${signalCapacity.total}/${signalCapacity.limit}`}
          good={signalCapacity.total < signalCapacity.limit}
        />
        <LifecycleDatum
          label="Signal Long / Short"
          value={`${signalCapacity.long} / ${signalCapacity.short}`}
          good={signalCapacity.total <= signalCapacity.limit}
        />
        <LifecycleDatum
          label="Signal selection"
          value={signalCapacity.selectionMode === "best_first" ? "best first" : signalCapacity.selectionMode}
          good={signalCapacity.selectionMode === "best_first"}
        />
        <LifecycleDatum
          label="Capacity sample"
          value={signalCapacity.ageMs == null ? "waiting" : `${formatAge(signalCapacity.ageMs)} ago`}
          good={signalCapacity.ageMs == null || signalCapacity.ageMs <= 120_000}
        />
      </div>

      {lifecycle.lastError && (
        <div className="mt-2 rounded border border-red-500/20 bg-red-500/10 p-1.5 font-mono text-[8px] text-red-700 dark:text-red-300">
          {lifecycle.lastError}
        </div>
      )}
    </div>
  )
}

function LifecycleDatum({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-1 border-b border-dashed py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={`truncate font-mono ${good ? "text-foreground" : "text-amber-700 dark:text-amber-300"}`}>
        {value}
      </span>
    </div>
  )
}

function LogStream({
  logs,
  expandedIds,
  onToggle,
}: {
  logs: DetailedLog[]
  expandedIds: Set<string>
  onToggle: (id: string) => void
}) {
  if (logs.length === 0) {
    return <EmptyState icon={FileText} text="No log entries in this section." />
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {logs.map((log, index) => {
        const expanded = expandedIds.has(log.id)
        const error = isError(log)
        const warning = isWarning(log)
        return (
          <div key={log.id} className={index > 0 ? "border-t" : ""}>
            <button
              type="button"
              onClick={() => onToggle(log.id)}
              className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
            >
              {expanded ? (
                <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  error ? "bg-red-500" : warning ? "bg-amber-500" : "bg-emerald-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`text-[10px] font-medium ${error ? "text-red-700 dark:text-red-300" : ""}`}>
                    {log.message}
                  </span>
                  <Badge variant="outline" className="h-4 px-1 font-mono text-[8px]">{log.phase || log.type}</Badge>
                  {log.symbol && <Badge variant="secondary" className="h-4 px-1 font-mono text-[8px]">{log.symbol}</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[8px] text-muted-foreground">
                  <span>{formatTimestamp(log.timestamp)}</span>
                  <span>{log.category || log.type}</span>
                  {log.connectionId && <span className="font-mono">conn={log.connectionId}</span>}
                </div>
              </div>
            </button>
            {expanded && (
              <div className="border-t bg-muted/20 px-7 py-2">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[8px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(log.details || {}, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
