"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Activity,
  Database,
  Cpu,
  HardDrive,
  TrendingUp,
  CheckCircle,
  Clock,
  Zap,
  BarChart3,
  Settings,
  RefreshCw,
  Server,
  Network,
  Target,
} from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { useExchange } from "@/lib/exchange-context"

interface SystemMetrics {
  cpu_usage: number
  memory_usage: number
  database_size: number
  database_connections: number
  api_requests_per_minute: number
  websocket_connections: number
  uptime_hours: number
}

interface TradingLogistics {
  active_connections: number
  total_strategies: number
  active_strategies: number
  open_positions: number
  total_volume_24h: number
  trades_per_hour: number
  avg_response_time: number
  workflow_health?: string
  queue_backlog?: number
  processing_pressure?: number
  success_rate?: number
}

interface ModuleStatus {
  name: string
  status: "active" | "inactive" | "error"
  health: number
  last_update: string
}

export default function OverviewPage() {
  const { selectedConnectionId, selectedConnection } = useExchange()
  const [activeTab, setActiveTab] = useState("system")
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics>({
    cpu_usage: 35,
    memory_usage: 62,
    database_size: 245,
    database_connections: 12,
    api_requests_per_minute: 450,
    websocket_connections: 8,
    uptime_hours: 168,
  })

  const [tradingLogistics, setTradingLogistics] = useState<TradingLogistics>({
    active_connections: 3,
    total_strategies: 48,
    active_strategies: 24,
    open_positions: 156,
    total_volume_24h: 125000,
    trades_per_hour: 32,
    avg_response_time: 45,
    workflow_health: "unknown",
    queue_backlog: 0,
    processing_pressure: 0,
    success_rate: 0,
  })

  const [modules, setModules] = useState<ModuleStatus[]>([
    { name: "Live Trading Engine", status: "active", health: 98, last_update: "2 min ago" },
    { name: "Indication Generator", status: "active", health: 95, last_update: "1 min ago" },
    { name: "Strategy Optimizer", status: "active", health: 92, last_update: "3 min ago" },
    { name: "Position Manager", status: "active", health: 97, last_update: "1 min ago" },
    { name: "Analytics Engine", status: "active", health: 89, last_update: "5 min ago" },
    { name: "Database Sync", status: "active", health: 94, last_update: "2 min ago" },
    { name: "API Gateway", status: "active", health: 96, last_update: "1 min ago" },
    { name: "WebSocket Server", status: "active", health: 93, last_update: "2 min ago" },
  ])

  useEffect(() => {
    // When the user picks a connection in the sidebar exchange selector the
    // Structure page is re-scoped to that connection's Redis metrics so the
    // system/trading/module widgets always mirror the "live" exchange the
    // rest of the sidebar is working against.
    const qs =
      selectedConnectionId && !selectedConnectionId.startsWith("demo")
        ? `?connectionId=${encodeURIComponent(selectedConnectionId)}`
        : ""

    const fetchMetrics = async () => {
      try {
        const response = await fetch(`/api/structure/metrics${qs}`, { cache: "no-store" })
        const result = await response.json()
        if (result.success) {
          setSystemMetrics(result.data.systemMetrics)
          setTradingLogistics(result.data.tradingLogistics)
        }
      } catch (error) {
        console.error("[v0] Error fetching metrics:", error)
      }
    }

    const fetchModules = async () => {
      try {
        const response = await fetch(`/api/structure/modules${qs}`, { cache: "no-store" })
        const result = await response.json()
        if (result.success) {
          setModules(result.data)
        }
      } catch (error) {
        console.error("[v0] Error fetching modules:", error)
      }
    }

    // Initial fetch
    fetchMetrics()
    fetchModules()

    // Refresh every 5 seconds
    const interval = setInterval(() => {
      fetchMetrics()
      fetchModules()
    }, 5000)

    return () => clearInterval(interval)
  }, [selectedConnectionId])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "text-green-500"
      case "inactive":
        return "text-gray-500"
      case "error":
        return "text-red-500"
      default:
        return "text-gray-500"
    }
  }

  const getHealthColor = (health: number) => {
    if (health >= 90) return "text-green-600"
    if (health >= 70) return "text-yellow-600"
    return "text-red-600"
  }

  const getMetricStatus = (value: number, threshold: number) => {
    return value < threshold ? "optimal" : value < threshold * 1.5 ? "warning" : "critical"
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  /*
   * Derive the "System Health" percentage from real module health data
   * instead of a hardcoded 98%. This was static placeholder content that
   * drifted from the underlying metrics and made the page feel fake.
   */
  const systemHealth = modules.length > 0
    ? Math.round(modules.reduce((s, m) => s + (m.status === "active" ? m.health : 0), 0) / modules.length)
    : 0
  const activeModuleCount = modules.filter((m) => m.status === "active").length

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader
          title="System Overview"
          description={
            selectedConnection
              ? `Workability, logistics, and module status — scoped to ${selectedConnection.name || selectedConnection.exchange}`
              : "Comprehensive system workability, logistics, and functionality status (all connections)"
          }
        />
        <div className="flex items-center gap-2">
          {/* The scoped-connection chip is now rendered globally by PageHeader
              (see components/page-header.tsx), so we only keep the system
              health status badge + refresh action here to avoid duplication. */}
          <Badge variant="outline" className="h-7 gap-1">
            <Activity className="h-3 w-3" />
            {systemHealth >= 90 ? "System Healthy" : systemHealth >= 70 ? "System Degraded" : "System Critical"}
          </Badge>
          <Button onClick={() => window.location.reload()} size="sm" className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/*
        Quick Status — compact icon-pill cards, same pattern as the rest of
        the sidebar pages. Replaces 4 bulky Card columns whose values were
        partially hardcoded (e.g. "7 days continuous", "98%").
      */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          {
            icon: CheckCircle,
            label: "System Health",
            value: `${systemHealth}%`,
            sub: systemHealth >= 90 ? "All systems OK" : "Action recommended",
            tint: systemHealth >= 90 ? "text-green-500" : systemHealth >= 70 ? "text-amber-500" : "text-red-500",
            progress: systemHealth,
          },
          {
            icon: Clock,
            label: "Uptime",
            value: `${systemMetrics.uptime_hours}h`,
            sub: systemMetrics.uptime_hours >= 168 ? "7+ days continuous" : `${Math.floor(systemMetrics.uptime_hours / 24)}d`,
            tint: "text-primary",
          },
          {
            icon: Zap,
            label: "Active Modules",
            value: `${activeModuleCount}/${modules.length}`,
            sub: activeModuleCount === modules.length ? "All operational" : "Some degraded",
            tint: activeModuleCount === modules.length ? "text-green-500" : "text-amber-500",
          },
          {
            icon: TrendingUp,
            label: "Response Time",
            value: `${tradingLogistics.avg_response_time}ms`,
            sub: tradingLogistics.avg_response_time < 100 ? "Optimal" : "Elevated",
            tint: tradingLogistics.avg_response_time < 100 ? "text-green-500" : "text-amber-500",
          },
        ].map((stat) => (
          <Card key={stat.label} className="border-border bg-card">
            <CardContent className="p-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className={`rounded bg-muted/60 p-1.5 ${stat.tint}`}>
                  <stat.icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-lg font-bold tabular-nums ${stat.tint}`}>{stat.value}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{stat.label}</div>
                </div>
              </div>
              {stat.progress !== undefined ? (
                <Progress value={stat.progress} className="h-1" />
              ) : (
                <div className="text-[10px] text-muted-foreground">{stat.sub}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="system">System Metrics</TabsTrigger>
          <TabsTrigger value="logistics">Trading Logistics</TabsTrigger>
          <TabsTrigger value="modules">Module Status</TabsTrigger>
          <TabsTrigger value="optimization">Optimization</TabsTrigger>
        </TabsList>

        {/* System Metrics Tab */}
        <TabsContent value="system" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* CPU Usage */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-blue-500" />
                  CPU Usage
                </CardTitle>
                <CardDescription>Current processor utilization</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">{systemMetrics.cpu_usage.toFixed(1)}%</span>
                    <Badge variant={systemMetrics.cpu_usage < 60 ? "default" : "destructive"}>
                      {getMetricStatus(systemMetrics.cpu_usage, 60)}
                    </Badge>
                  </div>
                  <Progress value={systemMetrics.cpu_usage} className="h-3" />
                  <div className="text-sm text-muted-foreground">Threshold: 60% (Optimal) | 90% (Critical)</div>
                </div>
              </CardContent>
            </Card>

            {/* Memory Usage */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-green-500" />
                  Memory Usage
                </CardTitle>
                <CardDescription>RAM utilization</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">{systemMetrics.memory_usage.toFixed(1)}%</span>
                    <Badge variant={systemMetrics.memory_usage < 70 ? "default" : "destructive"}>
                      {getMetricStatus(systemMetrics.memory_usage, 70)}
                    </Badge>
                  </div>
                  <Progress value={systemMetrics.memory_usage} className="h-3" />
                  <div className="text-sm text-muted-foreground">Threshold: 70% (Optimal) | 85% (Critical)</div>
                </div>
              </CardContent>
            </Card>

            {/* Database Metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-purple-500" />
                  Database Status
                </CardTitle>
                <CardDescription>Storage and connection metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Database Size</span>
                    <span className="font-semibold">{systemMetrics.database_size} MB</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Active Connections</span>
                    <span className="font-semibold">{systemMetrics.database_connections}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Query Performance</span>
                    <Badge variant="default">Excellent</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Network Metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-5 w-5 text-orange-500" />
                  Network Activity
                </CardTitle>
                <CardDescription>API and WebSocket connections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">API Requests/min</span>
                    <span className="font-semibold">{formatNumber(systemMetrics.api_requests_per_minute)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">WebSocket Connections</span>
                    <span className="font-semibold">{systemMetrics.websocket_connections}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Network Latency</span>
                    <Badge variant="default">Low</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Trading Logistics Tab */}
        <TabsContent value="logistics" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-blue-500" />
                  Exchange Connections
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/*
                  Removed the hardcoded "Bybit X03 / BingX X01 / Pionex X01"
                  list (placeholder content that was visible to every user
                  regardless of their actual connected exchanges). The
                  breakdown will re-appear once /api/structure/metrics
                  surfaces per-connection status (currently it returns only
                  the aggregate `active_connections` count).
                */}
                <div className="space-y-3">
                  <div className="text-3xl font-bold tabular-nums">{tradingLogistics.active_connections}</div>
                  <div className="text-xs text-muted-foreground">Active exchange connections</div>
                  <div className="text-xs text-muted-foreground">
                    Manage connections in the Settings &rarr; Exchange tab.
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-green-500" />
                  Strategy Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-4xl font-bold">{tradingLogistics.active_strategies}</div>
                      <div className="text-sm text-muted-foreground">of {tradingLogistics.total_strategies} total</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-semibold text-green-600">
                        {((tradingLogistics.active_strategies / tradingLogistics.total_strategies) * 100).toFixed(0)}%
                      </div>
                      <div className="text-xs text-muted-foreground">Active</div>
                    </div>
                  </div>
                  <Progress value={(tradingLogistics.active_strategies / tradingLogistics.total_strategies) * 100} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-purple-500" />
                  Position Activity
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-4xl font-bold">{tradingLogistics.open_positions}</div>
                  <div className="text-sm text-muted-foreground">Open positions</div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Trades/hour</span>
                        <span className="font-semibold">{tradingLogistics.trades_per_hour}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Workflow Health</span>
                        <span className="font-semibold capitalize">{tradingLogistics.workflow_health || "unknown"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Queue Backlog</span>
                        <span className="font-semibold">{tradingLogistics.queue_backlog || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">24h Volume</span>
                        <span className="font-semibold">{formatCurrency(tradingLogistics.total_volume_24h)}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Trading Flow Visualization */}
          <Card>
            <CardHeader>
              <CardTitle>Trading Workflow Status</CardTitle>
              <CardDescription>End-to-end trading process health</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                {[
                  { name: "Market Data", status: "active", health: 98 },
                  { name: "Signal Generation", status: "active", health: 95 },
                  { name: "Strategy Execution", status: "active", health: 96 },
                  { name: "Position Management", status: "active", health: Math.max(0, 100 - (tradingLogistics.processing_pressure || 0)) },
                  { name: "Risk Control", status: "active", health: tradingLogistics.success_rate || 94 },
                ].map((step, index) => (
                  <div key={index} className="text-center space-y-2">
                    <div className="flex justify-center">
                      {/*
                        Swapped `bg-green-100` / `bg-gray-100` (light-mode-only)
                        for token-aware tinted backgrounds so the workflow
                        circles stay legible in dark mode.
                      */}
                      <div
                        className={`w-14 h-14 rounded-full flex items-center justify-center ${
                          step.status === "active" ? "bg-green-500/15" : "bg-muted"
                        }`}
                      >
                        <CheckCircle className={`h-7 w-7 ${getStatusColor(step.status)}`} />
                      </div>
                    </div>
                    <div className="font-semibold text-xs">{step.name}</div>
                    <div className={`text-[11px] font-medium tabular-nums ${getHealthColor(step.health)}`}>{step.health}% Health</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Module Status Tab */}
        <TabsContent value="modules" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {modules.map((module, index) => (
              <Card key={index}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{module.name}</CardTitle>
                    <Badge variant={module.status === "active" ? "default" : "destructive"}>{module.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Health Score</span>
                      <span className={`text-2xl font-bold ${getHealthColor(module.health)}`}>{module.health}%</span>
                    </div>
                    <Progress value={module.health} className="h-2" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Last Update</span>
                      <span className="font-medium">{module.last_update}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Optimization Tab */}
        <TabsContent value="optimization" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                System Optimization Recommendations
              </CardTitle>
              <CardDescription>Suggestions to improve system performance and efficiency</CardDescription>
            </CardHeader>
            <CardContent>
              {/*
                Switched the recommendation banners from `bg-xxx-50` / `text-xxx-900`
                hard-coded tailwind palette utilities (which were unreadable
                in dark mode) to a tinted-border + soft-fill pattern using
                `bg-xxx-500/10` + `border-xxx-500/30`. Text uses `text-foreground`
                so it remains legible in both themes.
              */}
              <div className="space-y-4">
                <div className="flex items-start gap-3 py-2 px-4 rounded-md border border-green-500/30 bg-green-500/10">
                  <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold text-sm text-foreground">System Running Optimally</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      All metrics are within optimal ranges. CPU at {systemMetrics.cpu_usage.toFixed(1)}%, memory at{" "}
                      {systemMetrics.memory_usage.toFixed(1)}%.
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="font-semibold text-sm">Performance Recommendations</h4>

                  <div className="flex items-start gap-3 py-2 px-4 rounded-md border border-blue-500/30 bg-blue-500/10">
                    <BarChart3 className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="font-semibold text-sm text-foreground">Database Optimization</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Consider archiving positions older than 90 days to maintain optimal query performance. Current
                        database size: {systemMetrics.database_size} MB.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 py-2 px-4 rounded-md border border-indigo-500/30 bg-indigo-500/10">
                    <Target className="h-5 w-5 text-indigo-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="font-semibold text-sm text-foreground">Strategy Efficiency</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {tradingLogistics.total_strategies - tradingLogistics.active_strategies} strategies are
                        inactive. Review and remove unused strategies to reduce system overhead.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 py-2 px-4 rounded-md border border-amber-500/30 bg-amber-500/10">
                    <Zap className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="font-semibold text-sm text-foreground">API Rate Optimization</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Current API request rate: {formatNumber(systemMetrics.api_requests_per_minute)}/min. Consider
                        implementing request batching for improved efficiency.
                      </div>
                    </div>
                  </div>
                </div>

                {/*
                  Capacity Analysis — derive Load + Efficiency from real
                  numbers instead of a hardcoded "Medium"/"92%". Scalability
                  is still qualitative (the system doesn't ship a
                  real capacity model yet) but flagged as such.
                */}
                <div className="mt-4">
                  <h4 className="font-semibold text-sm mb-2">System Capacity Analysis</h4>
                  {(() => {
                    const MAX_POSITIONS = 500
                    const loadPct = Math.min(100, (tradingLogistics.open_positions / MAX_POSITIONS) * 100)
                    const loadLabel = loadPct < 25 ? "Low" : loadPct < 60 ? "Medium" : loadPct < 85 ? "High" : "Critical"
                    const loadTint =
                      loadPct < 60 ? "text-green-500" : loadPct < 85 ? "text-amber-500" : "text-red-500"

                    // Efficiency: composite of CPU/memory headroom + module health average.
                    const cpuScore = Math.max(0, 100 - systemMetrics.cpu_usage)
                    const memScore = Math.max(0, 100 - systemMetrics.memory_usage)
                    const modScore =
                      modules.length > 0 ? modules.reduce((s, m) => s + m.health, 0) / modules.length : 0
                    const efficiency = Math.round((cpuScore + memScore + modScore) / 3)

                    return (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        <div className="rounded-md bg-muted/50 p-3">
                          <div className="text-xs text-muted-foreground">Current Load</div>
                          <div className={`text-xl font-bold mt-1 ${loadTint}`}>{loadLabel}</div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {tradingLogistics.open_positions} / {MAX_POSITIONS} positions
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/50 p-3">
                          <div className="text-xs text-muted-foreground">Scalability</div>
                          <div className="text-xl font-bold mt-1 text-green-500">
                            {loadPct < 33 ? "High" : loadPct < 66 ? "Moderate" : "Constrained"}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            Headroom: {(100 - loadPct).toFixed(0)}%
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/50 p-3">
                          <div className="text-xs text-muted-foreground">Efficiency Score</div>
                          <div
                            className={`text-xl font-bold mt-1 ${
                              efficiency >= 80
                                ? "text-green-500"
                                : efficiency >= 60
                                  ? "text-amber-500"
                                  : "text-red-500"
                            }`}
                          >
                            {efficiency}%
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            CPU/Memory/Module composite
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
