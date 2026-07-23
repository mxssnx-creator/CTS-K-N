"use client"

import React, { type ReactNode, useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { QuickstartSection } from "./quickstart-section"
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

const STARTED_AT_STORAGE_KEY = "cts-v-dashboard-started-at"

function getPersistedStartedAt(): Date | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(STARTED_AT_STORAGE_KEY)
    if (!raw) return null
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return new Date(parsed)
  } catch {}
  return null
}

function persistStartedAt(date: Date): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STARTED_AT_STORAGE_KEY, date.toISOString())
  } catch {}
}

async function fetchStartedAtFromServer(): Promise<Date | null> {
  try {
    const res = await fetch("/api/system/status", { cache: "no-store" })
    if (!res.ok) return null
    const data = await res.json()
    const startedAt = data?.tradeEngine?.worker?.started_at || data?.engineGlobalState?.started_at
    if (typeof startedAt === "string") {
      const parsed = Date.parse(startedAt)
      if (Number.isFinite(parsed)) return new Date(parsed)
    }
  } catch {}
  return null
}

function getDurableSiteInstanceId(): string | null {
  if (typeof document === "undefined") return null
  return document.documentElement.dataset.ctsSiteInstance || null
}

function DashboardRuntimeFooter() {
  const [startedAt, setStartedAt] = useState<Date | null>(() => getPersistedStartedAt())
  const [now, setNow] = useState<Date | null>(startedAt ?? new Date())
  const [instanceId, setInstanceId] = useState<string | null>(() => getDurableSiteInstanceId())

  useEffect(() => {
    let cancelled = false

    async function resolveStartedAt() {
      if (startedAt) return
      const serverStartedAt = await fetchStartedAtFromServer()
      if (cancelled) return
      const finalStartedAt = serverStartedAt ?? new Date()
      setStartedAt(finalStartedAt)
      setNow(finalStartedAt)
      persistStartedAt(finalStartedAt)
    }

    resolveStartedAt()
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [startedAt])

  return (
    <Card className="border-dashed bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            Unique Session / Instance ID
          </Badge>
          <span className="font-mono text-foreground break-all">{instanceId ?? "—"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
          <span>Started: {startedAt ? startedAt.toLocaleString() : "—"}</span>
          <span>Now: {now ? now.toLocaleString() : "—"}</span>
          <span>Running: {formatDuration(startedAt && now ? now.getTime() - startedAt.getTime() : 0)}</span>
        </div>
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
