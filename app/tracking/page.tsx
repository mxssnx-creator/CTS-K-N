"use client"
export const dynamic = "force-dynamic"


import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, BarChart3, MapPin, RefreshCw, ShieldAlert, TrendingUp, Waves } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toast } from "@/lib/simple-toast"

interface TrackingProgression {
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  totalProfit: number
  tradeSuccessRate?: number
}

interface TrackingLog {
  timestamp: string
  level: string
  phase: string
  message: string
}

interface TrackingItem {
  connectionId: string
  connectionName: string
  exchange: string
  activePositions: number
  closedPositions: number
  totalVolume: number
  profit: number
  winRate: number
  progression: TrackingProgression
  logs: TrackingLog[]
  hasCredentials: boolean
  dashboardEnabled: boolean
  liveTradeEnabled: boolean
  lastUpdate: string
}

interface TrackingOverviewResponse {
  success: boolean
  items: TrackingItem[]
  summary?: {
    totalConnections: number
    activeConnections: number
    totalActivePositions: number
    totalClosedPositions: number
    totalProfit: number
  }
}

export default function TrackingPage() {
  const [activeTab, setActiveTab] = useState("overview")
  const [selectedConnection, setSelectedConnection] = useState<string>("all")
  const [data, setData] = useState<TrackingOverviewResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const loadTrackingData = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await fetch("/api/tracking/overview", { cache: "no-store" })
      const payload = await response.json()

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to load tracking overview")
      }

      setData(payload)
    } catch (error) {
      console.error("[v0] Failed to load tracking data:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load tracking")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTrackingData()
  }, [loadTrackingData])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(loadTrackingData, 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, loadTrackingData])

  const items = data?.items || []
  const selectedItem = useMemo(() => {
    if (selectedConnection === "all") return null
    return items.find((item) => item.connectionId === selectedConnection) || null
  }, [items, selectedConnection])

  const visibleItems = selectedItem ? [selectedItem] : items

  const latestLogs = useMemo(() => {
    return visibleItems
      .flatMap((item) => item.logs.map((log) => ({ ...log, connectionName: item.connectionName })))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20)
  }, [visibleItems])

  return (
    <main className="flex flex-col flex-1 overflow-auto p-6">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold">
              <MapPin className="h-8 w-8" />
              Tracking
            </h1>
            <p className="mt-1 text-muted-foreground">
              Overview, progression, error handling, and operational tracking across logistics and live processing.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={selectedConnection} onValueChange={setSelectedConnection}>
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Select connection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All connections</SelectItem>
                {items.map((item) => (
                  <SelectItem key={item.connectionId} value={item.connectionId}>
                    {item.connectionName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant={autoRefresh ? "default" : "outline"} onClick={() => setAutoRefresh((value) => !value)}>
              <Waves className="mr-2 h-4 w-4" />
              Auto Refresh {autoRefresh ? "On" : "Off"}
            </Button>

            <Button variant="outline" onClick={loadTrackingData} disabled={isLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Connections</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{data?.summary?.totalConnections || 0}</div>
              <p className="text-xs text-muted-foreground">Total tracked connections</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Positions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{data?.summary?.totalActivePositions || 0}</div>
              <p className="text-xs text-muted-foreground">Currently active positions</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Closed Positions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{data?.summary?.totalClosedPositions || 0}</div>
              <p className="text-xs text-muted-foreground">Historical closed positions</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Portfolio P&amp;L</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${(data?.summary?.totalProfit || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                ${(data?.summary?.totalProfit || 0).toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">Tracked aggregate result</p>
            </CardContent>
          </Card>
        </div>

        {visibleItems.length === 0 && !isLoading && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>
              No tracking data is available yet. Add a connection, insert it into the dashboard active panel, and enable processing to populate tracking.
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="progression" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Progression
            </TabsTrigger>
            <TabsTrigger value="errors" className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Errors & Logs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            {visibleItems.map((item) => (
              <Card key={item.connectionId}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>{item.connectionName}</span>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={item.dashboardEnabled ? "default" : "outline"}>Dashboard {item.dashboardEnabled ? "Enabled" : "Disabled"}</Badge>
                      <Badge variant={item.liveTradeEnabled ? "default" : "outline"}>Live Trade {item.liveTradeEnabled ? "On" : "Off"}</Badge>
                    </div>
                  </CardTitle>
                  <CardDescription>{item.exchange} • Last update {new Date(item.lastUpdate).toLocaleString()}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-sm text-muted-foreground">Positions</div>
                    <div className="text-lg font-semibold">{item.activePositions} active / {item.closedPositions} closed</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Volume</div>
                    <div className="text-lg font-semibold">{item.totalVolume.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Profit</div>
                    <div className={`text-lg font-semibold ${item.profit >= 0 ? "text-green-600" : "text-red-600"}`}>${item.profit.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Win Rate</div>
                    <div className="text-lg font-semibold">{item.winRate.toFixed(1)}%</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="progression" className="space-y-4">
            {visibleItems.map((item) => (
              <Card key={item.connectionId}>
                <CardHeader>
                  <CardTitle>{item.connectionName} Progression</CardTitle>
                  <CardDescription>Processing cycles, engine progression, and workflow health</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span>Cycle Success Rate</span>
                    <span className="font-semibold">{item.progression?.cycleSuccessRate?.toFixed(1) || 0}%</span>
                  </div>
                  <Progress value={item.progression?.cycleSuccessRate || 0} className="h-2" />
                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <div className="text-sm text-muted-foreground">Cycles</div>
                      <div className="text-lg font-semibold">{item.progression?.cyclesCompleted || 0}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">Successful</div>
                      <div className="text-lg font-semibold">{item.progression?.successfulCycles || 0}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">Failed</div>
                      <div className="text-lg font-semibold">{item.progression?.failedCycles || 0}</div>
                    </div>
                  </div>
                  <Separator />
                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <div className="text-sm text-muted-foreground">Trades</div>
                      <div className="text-lg font-semibold">{item.progression?.totalTrades || 0}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">Trade Success</div>
                      <div className="text-lg font-semibold">{item.progression?.tradeSuccessRate?.toFixed(1) || 0}%</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">Tracked Profit</div>
                      <div className={`text-lg font-semibold ${(item.progression?.totalProfit || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                        ${(item.progression?.totalProfit || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="errors" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Error Handling & Operational Logs</CardTitle>
                <CardDescription>Latest progression and handling events across the selected tracking scope</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {latestLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No logs yet. Once quickstart or engine processing runs, tracking events will appear here.</p>
                ) : (
                  latestLogs.map((log, index) => (
                    <div key={`${log.connectionName}-${log.timestamp}-${index}`} className="rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                          <Badge variant={log.level === "error" ? "destructive" : log.level === "warning" ? "secondary" : "outline"}>
                            {log.level}
                          </Badge>
                          <Badge variant="outline">{log.phase}</Badge>
                          <span className="text-sm font-medium">{log.connectionName}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                      <p className="text-sm text-muted-foreground">{log.message}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
