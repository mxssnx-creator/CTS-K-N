"use client"

import React, { type ReactNode, useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { QuickstartSection } from "./quickstart-section"
import { DirectTradeSection } from "./direct-trade-section"
import { SystemOverview } from "./system-overview"
import { GlobalTradeEngineControls } from "./global-trade-engine-controls"
import { DashboardActiveConnectionsManager } from "./dashboard-active-connections-manager"
import { StatisticsOverviewV2 } from "./statistics-overview-v2"
import { SystemMonitoringPanel } from "./system-monitoring-panel"
import { DetailedLogsButton } from "./detailed-logs-button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface ErrorBoundaryProps { children: ReactNode; name: string }
interface ErrorBoundaryState { hasError: boolean; error?: Error }

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error) {
    console.error(`[Dashboard] Error in ${this.props.name}:`, error)
  }
  render() {
    if (this.state.hasError) {
      return (
        <Card className="p-4 border-destructive/50 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Failed to load: {this.props.name}</p>
          <p className="text-xs text-muted-foreground mt-1">{this.state.error?.message}</p>
        </Card>
      )
    }
    return this.props.children
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

interface RuntimeIdentity {
  bootId: string | null
  installationId: string | null
  startedAt: Date | null
  restarts: number
  recoveries: number
  crashes: number
  lastRecoveryKind: string | null
}

async function fetchRuntimeIdentity(): Promise<RuntimeIdentity | null> {
  try {
    const res = await fetch("/api/system/status", { cache: "no-store" })
    if (!res.ok) return null
    const data = await res.json()
    const rawStartedAt = data?.startup?.started_at
    const parsed = typeof rawStartedAt === "string" ? Date.parse(rawStartedAt) : Number.NaN
    return {
      bootId: typeof data?.startup?.boot_id === "string" ? data.startup.boot_id : null,
      installationId: typeof data?.siteInstanceId === "string" ? data.siteInstanceId : null,
      startedAt: Number.isFinite(parsed) ? new Date(parsed) : null,
      restarts: Math.max(0, Number(data?.startup?.service_restart_count) || 0),
      recoveries: Math.max(0, Number(data?.startup?.recovery_count) || 0),
      crashes: Math.max(0, Number(data?.startup?.crash_count) || 0),
      lastRecoveryKind: typeof data?.startup?.last_recovery_kind === "string" ? data.startup.last_recovery_kind : null,
    }
  } catch {}
  return null
}

function getDurableSiteInstanceId(): string | null {
  if (typeof document === "undefined") return null
  return document.documentElement.dataset.ctsSiteInstance || null
}

function DashboardRuntimeFooter() {
  // All of these values are time/locale/DOM dependent. They must stay null on
  // the server render AND the first client render, otherwise the SSR HTML
  // (server clock + locale) won't match the client and React throws a
  // hydration mismatch. They are populated after mount in the effects below.
  const [mounted, setMounted] = useState(false)
  const [startedAt, setStartedAt] = useState<Date | null>(null)
  const [now, setNow] = useState<Date | null>(null)
  const [runtime, setRuntime] = useState<RuntimeIdentity | null>(null)

  useEffect(() => {
    setMounted(true)
    setNow(new Date())
  }, [])

  useEffect(() => {
    if (!mounted) return
    let cancelled = false

    async function refreshRuntime() {
      const identity = await fetchRuntimeIdentity()
      if (cancelled) return
      if (!identity) return
      setRuntime(identity)
      setStartedAt(identity.startedAt)
      setNow(new Date())
    }

    void refreshRuntime()
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    const refreshTimer = window.setInterval(() => void refreshRuntime(), 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearInterval(refreshTimer)
    }
  }, [mounted])

  return (
    <Card className="border-dashed bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            Current service session
          </Badge>
          <span className="font-mono text-foreground break-all" suppressHydrationWarning>
            {mounted ? (runtime?.bootId ?? "—") : "—"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
          <span suppressHydrationWarning>Started: {mounted && startedAt ? startedAt.toLocaleString() : "—"}</span>
          <span suppressHydrationWarning>Now: {mounted && now ? now.toLocaleString() : "—"}</span>
          <span suppressHydrationWarning>
            Running: {formatDuration(mounted && startedAt && now ? now.getTime() - startedAt.getTime() : 0)}
          </span>
          <span suppressHydrationWarning>Restarts/reloads: {mounted ? (runtime?.restarts ?? 0) : 0}</span>
          <span suppressHydrationWarning title={runtime?.lastRecoveryKind || undefined}>Recoveries: {mounted ? (runtime?.recoveries ?? 0) : 0}</span>
          <span suppressHydrationWarning>Crash heals: {mounted ? (runtime?.crashes ?? 0) : 0}</span>
        </div>
      </div>
      <div className="mt-2 font-mono text-[10px] text-muted-foreground/80" suppressHydrationWarning>
        Installation: {mounted ? (runtime?.installationId ?? getDurableSiteInstanceId() ?? "—") : "—"}
      </div>
    </Card>
  )
}

export function Dashboard() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        title="CTS-K-N"
        description="Trading control"
        showExchangeSelector
      >
        <DetailedLogsButton />
      </PageHeader>

      <div className="flex-1 space-y-4 px-3 md:px-4 py-4 pb-8">
                <ErrorBoundary name="Quickstart">
          <QuickstartSection />
        </ErrorBoundary>
        <ErrorBoundary name="Direct-Trade">
          <DirectTradeSection />
        </ErrorBoundary>
        <ErrorBoundary name="System Overview">
          <SystemOverview />
        </ErrorBoundary>

        <ErrorBoundary name="Trade Engine Controls">
          <GlobalTradeEngineControls />
        </ErrorBoundary>

        <ErrorBoundary name="Active Connections">
          <DashboardActiveConnectionsManager />
        </ErrorBoundary>

        <ErrorBoundary name="Statistics">
          <StatisticsOverviewV2 />
        </ErrorBoundary>

        <DashboardRuntimeFooter />

        <ErrorBoundary name="System Monitoring">
          <SystemMonitoringPanel />
        </ErrorBoundary>
      </div>
    </div>
  )
}
