"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Bell, CheckCircle2, History, Info, RefreshCw, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageLoading, PageState } from "@/components/page-scaffold"
import { toast } from "@/lib/simple-toast"

interface MonitoringAlert {
  id: string
  level: "critical" | "warning" | "info"
  category: string
  message: string
  timestamp: string
  acknowledged: boolean
  acknowledgedAt?: string | null
}

interface MonitoringResponse {
  success: boolean
  alerts: MonitoringAlert[]
  count: number
  unacknowledgedCount: number
  criticalCount: number
  warningCount: number
  infoCount: number
}

interface DeliveryAlert {
  id: string
  severity: "info" | "warning" | "error" | "critical"
  title: string
  message: string
  source: string
  timestamp: string
}

interface DeliveryResponse {
  alerts: DeliveryAlert[]
  stats?: Record<string, number>
  total: number
}

function severityClasses(level: string): string {
  if (level === "critical" || level === "error") {
    return "border-destructive/30 bg-destructive/8 text-destructive"
  }
  if (level === "warning") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
}

function SeverityIcon({ level }: { level: string }) {
  if (level === "critical" || level === "error") return <ShieldAlert className="h-4 w-4" />
  if (level === "warning") return <AlertTriangle className="h-4 w-4" />
  return <Info className="h-4 w-4" />
}

export default function AlertsPage() {
  const [monitoring, setMonitoring] = useState<MonitoringResponse | null>(null)
  const [delivery, setDelivery] = useState<DeliveryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const inFlight = useRef(false)
  const abortController = useRef<AbortController | null>(null)

  const loadAlerts = useCallback(async (background = false) => {
    if (inFlight.current) return
    inFlight.current = true
    if (background) setRefreshing(true)
    abortController.current = new AbortController()

    try {
      const [monitoringResult, deliveryResult] = await Promise.allSettled([
        fetch("/api/monitoring/alerts", { cache: "no-store", signal: abortController.current.signal }),
        fetch("/api/alerts?limit=100", { cache: "no-store", signal: abortController.current.signal }),
      ])

      let updated = false
      const failures: string[] = []

      if (monitoringResult.status === "fulfilled" && monitoringResult.value.ok) {
        const payload = await monitoringResult.value.json() as MonitoringResponse
        if (payload.success) {
          setMonitoring(payload)
          updated = true
        } else {
          failures.push("monitoring alerts")
        }
      } else {
        failures.push("monitoring alerts")
      }

      if (deliveryResult.status === "fulfilled" && deliveryResult.value.ok) {
        setDelivery(await deliveryResult.value.json() as DeliveryResponse)
        updated = true
      } else {
        failures.push("delivery history")
      }

      setError(failures.length > 0 ? `Unavailable: ${failures.join(", ")}` : null)
      if (updated) setLastUpdated(new Date())
    } catch (loadError) {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load alerts")
      }
    } finally {
      inFlight.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadAlerts()
    const interval = window.setInterval(() => void loadAlerts(true), 10_000)
    return () => {
      abortController.current?.abort()
      window.clearInterval(interval)
    }
  }, [loadAlerts])

  const acknowledge = async (alertId: string) => {
    try {
      const response = await fetch("/api/monitoring/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.success) throw new Error(payload.error || "Acknowledgement failed")

      setMonitoring((current) => current ? {
        ...current,
        unacknowledgedCount: Math.max(0, current.unacknowledgedCount - 1),
        alerts: current.alerts.map((alert) => alert.id === alertId
          ? { ...alert, acknowledged: true, acknowledgedAt: payload.acknowledgedAt }
          : alert),
      } : current)
      toast.success("Alert acknowledged")
    } catch (ackError) {
      toast.error(ackError instanceof Error ? ackError.message : "Acknowledgement failed")
    }
  }

  if (loading) {
    return (
      <div className="page-section">
        <PageLoading label="Loading real operational alerts…" />
      </div>
    )
  }

  const activeAlerts = monitoring?.alerts ?? []
  const deliveryAlerts = delivery?.alerts ?? []

  return (
    <div className="page-section space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border bg-card/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Operational alert stream</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Values come from Redis-backed monitoring and the current process alert manager; no demo alerts are substituted.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadAlerts(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-700 dark:text-amber-300" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}. Existing data remains visible where available.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold tabular-nums">{monitoring?.count ?? 0}</div><div className="text-xs text-muted-foreground">Active conditions</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold tabular-nums text-destructive">{monitoring?.criticalCount ?? 0}</div><div className="text-xs text-muted-foreground">Critical</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{monitoring?.warningCount ?? 0}</div><div className="text-xs text-muted-foreground">Warnings</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold tabular-nums text-sky-600 dark:text-sky-400">{monitoring?.infoCount ?? 0}</div><div className="text-xs text-muted-foreground">Information</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold tabular-nums text-primary">{monitoring?.unacknowledgedCount ?? 0}</div><div className="text-xs text-muted-foreground">Unacknowledged</div></CardContent></Card>
      </div>

      <Tabs defaultValue="active" className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 sm:w-[26rem]">
          <TabsTrigger value="active">
            <Bell className="mr-2 h-4 w-4" />
            Active conditions
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="mr-2 h-4 w-4" />
            Delivery history
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-3">
          {activeAlerts.length === 0 ? (
            <PageState
              icon={CheckCircle2}
              compact
              title="No active alert conditions"
              description="Monitoring currently reports no failed-order, inactive-connection, high-error-rate, or configuration alert."
            />
          ) : activeAlerts.map((alert) => (
            <Card key={alert.id} className={alert.acknowledged ? "opacity-70" : undefined}>
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${severityClasses(alert.level)}`}>
                  <SeverityIcon level={alert.level} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={severityClasses(alert.level)}>{alert.level}</Badge>
                    <Badge variant="secondary">{alert.category}</Badge>
                    {alert.acknowledged && <Badge variant="outline"><CheckCircle2 className="mr-1 h-3 w-3" />Acknowledged</Badge>}
                  </div>
                  <p className="mt-2 text-sm text-foreground">{alert.message}</p>
                  <p className="mt-1 text-[10px] font-mono text-muted-foreground">{new Date(alert.timestamp).toLocaleString()}</p>
                </div>
                {!alert.acknowledged && (
                  <Button variant="outline" size="sm" onClick={() => void acknowledge(alert.id)}>
                    <CheckCircle2 className="h-4 w-4" />
                    Acknowledge
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Current process delivery history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {deliveryAlerts.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No alerts have been emitted by this application process.</p>
              ) : deliveryAlerts.map((alert) => (
                <div key={alert.id} className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-start">
                  <Badge variant="outline" className={severityClasses(alert.severity)}>{alert.severity}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{alert.title}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{alert.message}</p>
                    <p className="mt-1 text-[10px] font-mono text-muted-foreground">{alert.source} · {new Date(alert.timestamp).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-center text-[10px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
        Last successful refresh: {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"}
      </p>
    </div>
  )
}
