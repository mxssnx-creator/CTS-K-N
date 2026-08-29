"use client"

import { useEffect, useState } from "react"
import { Activity, RadioTower, Server, Users, Waves } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageLoading, PageState } from "@/components/page-scaffold"
import { useExchange } from "@/lib/exchange-context"

interface BroadcasterStats {
  totalConnections: number
  totalClients: number
  connectionStats: Record<string, number>
  historySize: number
}

interface ProcessingPhase {
  status: string
  progress: number
  itemsProcessed: number
  itemsTotal: number
  cycleCount: number
  duration: number
}

interface ProcessingCurrent {
  phases?: Record<string, ProcessingPhase>
  performanceMetrics?: {
    avgCycleDuration?: number
    totalProcessingTime?: number
  }
  pseudoPositions?: {
    currentActive?: number
    totalCreated?: number
    totalEvaluated?: number
  }
  evaluationCounts?: Record<string, number>
}

interface ProcessingMetrics {
  current: ProcessingCurrent | null
  summary: string
  timestamp: string
}

interface SystemHealth {
  status: "healthy" | "degraded" | "unhealthy"
  broadcaster: {
    active: boolean
    totalConnections: number
    totalClients: number
  }
  sse: {
    enabled: boolean
    protocol: string
    endpoint: string
    heartbeat: string | null
  }
}

async function readData<T>(response: Response): Promise<T | null> {
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.data ?? payload
  // Several control-plane endpoints use an envelope whose operational state
  // is top-level while the measured fields live under `data`. Preserve that
  // state when unwrapping; dropping it made StateBadge call toLowerCase() on
  // undefined and crashed the whole advanced-monitor page.
  if (
    data &&
    typeof data === "object" &&
    payload &&
    typeof payload === "object" &&
    !("status" in data) &&
    typeof payload.status === "string"
  ) {
    return { ...data, status: payload.status } as T
  }
  return data as T
}

function MetricTile({ label, value, tone = "primary" }: { label: string; value: string | number; tone?: "primary" | "info" | "success" | "warning" }) {
  const toneClass = {
    primary: "text-primary",
    info: "text-sky-600 dark:text-sky-400",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
  }[tone]

  return (
    <div className="rounded-lg border bg-muted/25 p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}

function StateBadge({ state }: { state?: string | null }) {
  const displayedState = state || "unknown"
  const normalized = displayedState.toLowerCase()
  const className = normalized === "healthy" || normalized === "completed" || normalized === "active"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : normalized === "degraded" || normalized === "running"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : normalized === "unhealthy" || normalized === "error"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-border bg-muted text-muted-foreground"

  return <Badge variant="outline" className={className}>{displayedState}</Badge>
}

export default function MonitoringAdvancedPage() {
  const { selectedConnectionId } = useExchange()
  const [broadcasterStats, setBroadcasterStats] = useState<BroadcasterStats | null>(null)
  const [processingMetrics, setProcessingMetrics] = useState<ProcessingMetrics | null>(null)
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let activeController: AbortController | null = null

    const fetchData = async () => {
      if (inFlight) return
      inFlight = true
      activeController = new AbortController()
      const { signal } = activeController

      try {
        const metricsRequest = selectedConnectionId && selectedConnectionId !== "demo-mode"
          ? fetch(`/api/metrics/processing?connectionId=${encodeURIComponent(selectedConnectionId)}`, { cache: "no-store", signal })
          : Promise.resolve(null)

        const [statsResult, healthResult, metricsResult] = await Promise.allSettled([
          fetch("/api/broadcast/stats", { cache: "no-store", signal }),
          fetch("/api/broadcast/health", { cache: "no-store", signal }),
          metricsRequest,
        ])

        if (cancelled) return

        if (statsResult.status === "fulfilled") {
          const nextStats = await readData<BroadcasterStats>(statsResult.value)
          if (nextStats) setBroadcasterStats(nextStats)
        }
        if (healthResult.status === "fulfilled") {
          const nextHealth = await readData<SystemHealth>(healthResult.value)
          if (nextHealth) setSystemHealth(nextHealth)
        }
        if (metricsResult.status === "fulfilled" && metricsResult.value) {
          const nextMetrics = await readData<ProcessingMetrics>(metricsResult.value)
          if (nextMetrics) setProcessingMetrics(nextMetrics)
        } else if (!selectedConnectionId || selectedConnectionId === "demo-mode") {
          setProcessingMetrics(null)
        }

        setLastUpdated(new Date())
      } catch (error) {
        if (!signal.aborted) console.error("[MonitoringAdvanced] Refresh failed:", error)
      } finally {
        inFlight = false
        if (!cancelled) setLoading(false)
      }
    }

    void fetchData()
    const interval = window.setInterval(() => void fetchData(), 5000)
    return () => {
      cancelled = true
      activeController?.abort()
      window.clearInterval(interval)
    }
  }, [selectedConnectionId])

  if (loading) {
    return (
      <div className="page-section">
        <PageLoading label="Loading broadcaster and processing telemetry…" />
      </div>
    )
  }

  const phases = Object.entries(processingMetrics?.current?.phases ?? {})
  const evaluations = Object.entries(processingMetrics?.current?.evaluationCounts ?? {})
    .filter(([, count]) => count > 0)

  return (
    <div className="page-section space-y-5">
      {!systemHealth && !broadcasterStats && !processingMetrics && (
        <PageState
          icon={RadioTower}
          tone="warning"
          title="Monitoring telemetry is unavailable"
          description="The broadcaster and processing endpoints returned no current data. Core execution state is not inferred from missing telemetry."
        />
      )}

      {systemHealth && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" />
                System health
              </span>
              <StateBadge state={systemHealth.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile label="Connections" value={systemHealth.broadcaster.totalConnections} tone="info" />
              <MetricTile label="Clients" value={systemHealth.broadcaster.totalClients} tone="success" />
              <MetricTile label="SSE" value={systemHealth.sse.enabled ? "Enabled" : "Disabled"} tone={systemHealth.sse.enabled ? "success" : "warning"} />
              <MetricTile label="Broadcaster" value={systemHealth.broadcaster.active ? "Active" : "Inactive"} tone={systemHealth.broadcaster.active ? "success" : "warning"} />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t pt-3 text-xs text-muted-foreground">
              <span>Protocol: <strong className="font-mono text-foreground">{systemHealth.sse.protocol}</strong></span>
              <span>Endpoint: <strong className="font-mono text-foreground">{systemHealth.sse.endpoint}</strong></span>
              <span>Heartbeat: <strong className="font-mono text-foreground">{systemHealth.sse.heartbeat || "bounded reconnect"}</strong></span>
            </div>
          </CardContent>
        </Card>
      )}

      {broadcasterStats && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-primary" />
              Broadcaster statistics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile label="Connections" value={broadcasterStats.totalConnections} tone="info" />
              <MetricTile label="Clients" value={broadcasterStats.totalClients} tone="success" />
              <MetricTile label="Message history" value={broadcasterStats.historySize} />
              <MetricTile
                label="Clients / connection"
                value={(broadcasterStats.totalClients / Math.max(broadcasterStats.totalConnections, 1)).toFixed(1)}
                tone="warning"
              />
            </div>
            {Object.keys(broadcasterStats.connectionStats).length > 0 && (
              <div className="space-y-2 border-t pt-3">
                {Object.entries(broadcasterStats.connectionStats).map(([connection, clients]) => (
                  <div key={connection} className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-foreground">{connection}</span>
                    <Badge variant="outline" className="shrink-0">
                      <Users className="mr-1 h-3 w-3" />
                      {clients}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {processingMetrics ? (
        <Tabs defaultValue="phases" className="space-y-4">
          <TabsList className="grid h-auto w-full grid-cols-3 bg-muted/60 sm:w-auto">
            <TabsTrigger value="phases">Phases</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="evaluations">Evaluations</TabsTrigger>
          </TabsList>

          <TabsContent value="phases">
            <Card>
              <CardHeader><CardTitle className="text-sm">Processing phases</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {phases.length === 0 && <p className="text-sm text-muted-foreground">No phase snapshot is available for this connection.</p>}
                {phases.map(([phase, phaseData]) => (
                  <div key={phase} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium capitalize">{phase}</span>
                      <StateBadge state={phaseData.status} />
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label={`${phase} ${Math.round(phaseData.progress)} percent`}>
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-primary to-cyan-500 transition-[width]"
                        style={{ width: `${Math.max(0, Math.min(phaseData.progress, 100))}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                      <span>{phaseData.itemsProcessed} / {phaseData.itemsTotal} items</span>
                      <span>{phaseData.cycleCount} cycles · {(phaseData.duration / 1000).toFixed(1)}s</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="metrics">
            <Card>
              <CardHeader><CardTitle className="text-sm">Performance metrics</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <MetricTile label="Average cycle" value={`${processingMetrics.current?.performanceMetrics?.avgCycleDuration?.toFixed(0) ?? 0}ms`} tone="info" />
                <MetricTile label="Processing time" value={`${((processingMetrics.current?.performanceMetrics?.totalProcessingTime ?? 0) / 1000).toFixed(1)}s`} tone="success" />
                <MetricTile label="Active positions" value={processingMetrics.current?.pseudoPositions?.currentActive ?? 0} tone="warning" />
                <MetricTile label="Positions created" value={processingMetrics.current?.pseudoPositions?.totalCreated ?? 0} />
                <MetricTile label="Positions evaluated" value={processingMetrics.current?.pseudoPositions?.totalEvaluated ?? 0} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="evaluations">
            <Card>
              <CardHeader><CardTitle className="text-sm">Evaluation counts</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {evaluations.length === 0 && <p className="text-sm text-muted-foreground">No non-zero evaluation counters are available.</p>}
                {evaluations.map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
                    <span className="text-sm capitalize">{type}</span>
                    <Badge variant="outline" className="font-mono">{count}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : selectedConnectionId && selectedConnectionId !== "demo-mode" ? (
        <PageState
          icon={Waves}
          compact
          title="No processing metrics yet"
          description="The selected connection has no current processing snapshot. Telemetry will appear after its engine begins processing."
        />
      ) : null}

      <div className="text-center text-[10px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
        Last successful refresh: {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"}
      </div>
    </div>
  )
}
