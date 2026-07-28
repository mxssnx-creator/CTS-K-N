"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Clock, Activity, CheckCircle, AlertCircle, RefreshCw } from "lucide-react"

interface IntervalHealth {
  enabled: boolean
  isRunning: boolean
  isProgressing: boolean
  intervalTime: number
  timeout: number
  lastStart?: string
  lastEnd?: string
}

type IndicationIntervalType =
  | "direction" | "move" | "active"
  | "trend" | "optimal" | "auto"
  | "common" | "signal"

type IntervalsData = Partial<Record<IndicationIntervalType, IntervalHealth>>

const INDICATION_INTERVALS: Array<{
  type: IndicationIntervalType
  label: string
  group: "Default" | "Additional" | "Common"
  timeout: number
}> = [
  { type: "direction", label: "Direction", group: "Default", timeout: 0.25 },
  { type: "move", label: "Move", group: "Default", timeout: 0.25 },
  { type: "active", label: "Active", group: "Default", timeout: 0.25 },
  { type: "trend", label: "Trend", group: "Additional", timeout: 0.5 },
  { type: "optimal", label: "Optimal", group: "Additional", timeout: 0.25 },
  { type: "auto", label: "Auto", group: "Additional", timeout: 0.25 },
  { type: "common", label: "Common", group: "Common", timeout: 1 },
  { type: "signal", label: "Signal", group: "Common", timeout: 0.25 },
]

interface StrategyStats {
  type: string
  enabled: boolean
  rangeCount: number
  activePositions: number
  totalIndications: number
  successRate: number
}

export function IntervalsStrategiesOverview({ connections }: { connections: any[] }) {
  const [intervals, setIntervals] = useState<IntervalsData>({})
  const [strategies, setStrategies] = useState<StrategyStats[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadData()
    const intervalId = setInterval(loadData, 5000)
    return () => clearInterval(intervalId)
  }, [connections])

  const loadData = async () => {
    try {
      const connectionId = connections[0]?.id || connections[0]?.connection_id || "default"
      
      const [intervalsRes, strategiesRes] = await Promise.all([
        fetch(`/api/monitoring/intervals/${connectionId}`).catch(() => null),
        fetch(`/api/monitoring/strategies/${connectionId}`).catch(() => null),
      ])

      if (intervalsRes?.ok) {
        const data = await intervalsRes.json()
        setIntervals(data.intervals || {})
      } else {
        // Fallback: derive interval health from system monitoring
        const sysRes = await fetch("/api/system/monitoring").catch(() => null)
        if (sysRes?.ok) {
          const sysData = await sysRes.json()
          const engineRunning = sysData.services?.tradeEngine || false
          const indicationsRunning = sysData.services?.indicationsEngine || false
          setIntervals(Object.fromEntries(INDICATION_INTERVALS.map(({ type, timeout }) => [
            type,
            {
              enabled: indicationsRunning,
              isRunning: indicationsRunning,
              isProgressing: engineRunning,
              intervalTime: type === "common" ? 1 : timeout,
              timeout,
            },
          ])) as IntervalsData)
        }
      }

      if (strategiesRes?.ok) {
        const data = await strategiesRes.json()
        setStrategies(data.strategies || [])
      } else {
        // Fallback: derive strategies from system stats
        const statsRes = await fetch("/api/main/system-stats-v3").catch(() => null)
        if (statsRes?.ok) {
          const statsData = await statsRes.json()
          const pipelineEnabled = Boolean(statsData.tradeEngines?.mainEnabled)
          const fallbackStrategies: StrategyStats[] = [
            { type: "base", enabled: pipelineEnabled, rangeCount: 0, activePositions: statsData.activeConnections?.total || 0, totalIndications: 0, successRate: 0 },
            { type: "main", enabled: pipelineEnabled, rangeCount: 0, activePositions: statsData.activeConnections?.active || 0, totalIndications: 0, successRate: 0 },
            { type: "real", enabled: pipelineEnabled, rangeCount: 0, activePositions: statsData.activeConnections?.liveTrade || 0, totalIndications: 0, successRate: 0 },
            { type: "live", enabled: pipelineEnabled, rangeCount: 0, activePositions: statsData.activeConnections?.liveTrade || 0, totalIndications: 0, successRate: 0 },
          ]
          setStrategies(fallbackStrategies)
        }
      }
    } catch (error) {
      console.error("[IntervalsStrategies] Failed to load data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const getIntervalStatus = (interval?: IntervalHealth) => {
    if (!interval || !interval.enabled) return "disabled"
    if (interval.isProgressing) return "progressing"
    if (interval.isRunning) return "running"
    return "stopped"
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "progressing":
        return "bg-yellow-500"
      case "running":
        return "bg-green-500"
      case "stopped":
        return "bg-red-500"
      case "disabled":
        return "bg-gray-400"
      default:
        return "bg-gray-400"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "progressing":
        return <RefreshCw className="h-3 w-3 animate-spin" />
      case "running":
        return <CheckCircle className="h-3 w-3" />
      case "stopped":
        return <AlertCircle className="h-3 w-3" />
      default:
        return null
    }
  }

  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return "N/A"
    const date = new Date(timestamp)
    return date.toLocaleTimeString()
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Intervals & Strategies</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Intervals Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-blue-500" />
              <CardTitle>Intervals Health</CardTitle>
            </div>
            <Button variant="outline" size="sm" onClick={loadData}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
          <CardDescription>Real-time interval progression status for all indication types</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {INDICATION_INTERVALS.map(({ type, label, group, timeout }) => {
              const interval = intervals[type]
              const status = getIntervalStatus(interval)
              return (
                <div key={type} className="p-4 border rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-blue-500" />
                      <div>
                        <div className="font-semibold">{label}</div>
                        <div className="text-[10px] text-muted-foreground">{group}</div>
                      </div>
                    </div>
                    <Badge className={`${getStatusColor(status)} text-white`}>
                      <span className="flex items-center gap-1">
                        {getStatusIcon(status)}
                        {status}
                      </span>
                    </Badge>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Interval:</span>
                      <span className="font-mono">{interval?.intervalTime ?? 0.25}s</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Exact-lane timeout:</span>
                      <span className="font-mono">{interval?.timeout ?? timeout}s</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Last Start:</span>
                      <span className="text-xs">{formatTimestamp(interval?.lastStart)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Last End:</span>
                      <span className="text-xs">{formatTimestamp(interval?.lastEnd)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* One coordinated Strategy processing flow */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-green-500" />
            Strategy Processing Flow
          </CardTitle>
          <CardDescription>
            Fresh Base → Main → Real → Live row snapshots from one combined process.
            Each row has independent evaluation settings; no row is independently switchable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {strategies.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No processing snapshots available</div>
          ) : (
            <div className="space-y-3">
              {strategies.map((strategy) => (
                <div key={strategy.type} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold capitalize">{strategy.type}</span>
                      <Badge variant={strategy.enabled ? "default" : "secondary"}>
                        {strategy.enabled ? "Processing" : "Stopped"}
                      </Badge>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {strategy.rangeCount} current sets
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs">Active Positions</div>
                      <div className="text-lg font-semibold">{strategy.activePositions}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Entries</div>
                      <div className="text-lg font-semibold">{strategy.totalIndications}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Pass Rate</div>
                      <div className="text-lg font-semibold">{strategy.successRate.toFixed(1)}%</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
