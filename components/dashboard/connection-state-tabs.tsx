"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { ExchangeConnection } from "@/lib/types"
import { Activity, AlertCircle, AlertTriangle, Database } from "lucide-react"

interface ConnectionStateTabsProps {
  connection: ExchangeConnection
  status: "connected" | "connecting" | "error" | "disabled"
  progress?: number
}

interface ConnectionState {
  queries: number
  performance: { latency: number; throughput: number }
  activities: string[]
  indications: number
  strategies: number
  liveTrades: number
  databaseSize: number
  effectiveIntervalMs: number
  errors: string[]
  warnings: string[]
}

export function ConnectionStateTabs({ connection, status, progress = 0 }: ConnectionStateTabsProps) {
  const [state, setState] = useState<ConnectionState>({
    queries: 0,
    performance: { latency: 0, throughput: 0 },
    activities: [],
    indications: 0,
    strategies: 0,
    liveTrades: 0,
    databaseSize: 0,
    effectiveIntervalMs: 5000,
    errors: [],
    warnings: [],
  })

  useEffect(() => {
    let disposed = false
    const connectionId = encodeURIComponent(String(connection.id))
    const refresh = async () => {
      try {
        const [metricsResponse, modulesResponse] = await Promise.all([
          fetch(`/api/structure/metrics?connectionId=${connectionId}`, { cache: "no-store" }),
          fetch(`/api/structure/modules?connectionId=${connectionId}`, { cache: "no-store" }),
        ])
        const [metricsPayload, modulesPayload] = await Promise.all([
          metricsResponse.json(),
          modulesResponse.json(),
        ])
        if (disposed) return
        if (!metricsResponse.ok || !metricsPayload.success) {
          throw new Error(metricsPayload.error || "Measured connection metrics unavailable")
        }
        const system = metricsPayload.data?.systemMetrics || {}
        const logistics = metricsPayload.data?.tradingLogistics || {}
        const raw = metricsPayload.data?.rawMetrics || {}
        const modules = Array.isArray(modulesPayload.data) ? modulesPayload.data : []
        setState({
          queries: Number(system.redis_operations_per_minute) || 0,
          performance: {
            latency: Number(logistics.avg_response_time) || 0,
            throughput: (Number(system.redis_operations_per_minute) || 0) / 60,
          },
          activities: modules.map((module: any) =>
            `${String(module.name || "Module")}: ${String(module.status || "unknown")}`,
          ),
          indications: Number(raw.indicationsActive) || 0,
          strategies: Number(logistics.active_strategies) || 0,
          liveTrades: Number(raw.livePositions) || 0,
          databaseSize: Number(system.database_size) || 0,
          effectiveIntervalMs: 5000,
          errors: modules
            .filter((module: any) => module.status === "error")
            .map((module: any) => `${module.name}: ${module.detail || "measured error"}`),
          warnings: modules
            .filter((module: any) => module.status === "inactive")
            .map((module: any) => `${module.name}: ${module.detail || "inactive"}`),
        })
      } catch (error) {
        if (disposed) return
        setState((current) => ({
          ...current,
          errors: [error instanceof Error ? error.message : "Measured connection state unavailable"],
        }))
      }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [connection.id])

  return (
    <Tabs defaultValue="main" className="w-full">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="main">Main</TabsTrigger>
        <TabsTrigger value="state">State</TabsTrigger>
        <TabsTrigger value="errors" className={state.errors.length > 0 ? "text-red-600" : ""}>
          Errors {state.errors.length > 0 && `(${state.errors.length})`}
        </TabsTrigger>
        <TabsTrigger value="warnings" className={state.warnings.length > 0 ? "text-amber-600" : ""}>
          Warnings {state.warnings.length > 0 && `(${state.warnings.length})`}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="main" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Connection Overview
            </CardTitle>
            <CardDescription>{connection.name} - {connection.exchange}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground">API Type</div>
                <div className="font-semibold">{connection.api_type}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Connection Method</div>
                <div className="font-semibold">{connection.connection_method}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <Badge variant={status === "connected" ? "default" : status === "error" ? "destructive" : "secondary"}>
                  {status}
                </Badge>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Mode</div>
                <Badge variant={connection.is_testnet ? "secondary" : "default"}>
                  {connection.is_testnet ? "Testnet" : "Live"}
                </Badge>
              </div>
            </div>
            {status === "connecting" && progress !== undefined && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="state" className="space-y-4">
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Performance Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Latency</span>
                <span className="font-semibold text-sm">{state.performance.latency.toFixed(1)}ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Throughput</span>
                <span className="font-semibold text-sm">{state.performance.throughput.toFixed(0)} req/s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Redis Operations/min</span>
                <span className="font-semibold text-sm">{state.queries}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Data Processing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Indications</span>
                <span className="font-semibold text-sm">{state.indications}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Strategies</span>
                <span className="font-semibold text-sm">{state.strategies}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Live Trades</span>
                <span className="font-semibold text-sm">{state.liveTrades}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Database Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Database Size</span>
                <span className="font-semibold text-sm">{state.databaseSize.toFixed(2)} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Effective Interval</span>
                <span className="font-semibold text-sm">{(state.effectiveIntervalMs / 1000).toFixed(1)}s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Storage Type</span>
                <span className="font-semibold text-sm">Redis</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent Activities</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs">
                {state.activities.slice(0, 4).map((activity, idx) => (
                  <li key={idx} className="text-muted-foreground">
                    • {activity}
                  </li>
                ))}
                {state.activities.length === 0 && (
                  <li className="text-muted-foreground">No measured module activity yet.</li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="errors" className="space-y-4">
        {state.errors.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-sm text-muted-foreground">
              No errors detected
            </CardContent>
          </Card>
        ) : (
          state.errors.map((error, idx) => (
            <Card key={idx} className="border-red-200 bg-red-50 dark:bg-red-950 dark:border-red-800">
              <CardContent className="pt-6 flex gap-3">
                <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                <div className="text-sm text-red-800 dark:text-red-200">{error}</div>
              </CardContent>
            </Card>
          ))
        )}
      </TabsContent>

      <TabsContent value="warnings" className="space-y-4">
        {state.warnings.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-sm text-muted-foreground">
              No warnings
            </CardContent>
          </Card>
        ) : (
          state.warnings.map((warning, idx) => (
            <Card key={idx} className="border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
              <CardContent className="pt-6 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800 dark:text-amber-200">{warning}</div>
              </CardContent>
            </Card>
          ))
        )}
      </TabsContent>
    </Tabs>
  )
}
