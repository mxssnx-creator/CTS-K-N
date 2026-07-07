"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, CheckCircle, Clock, TrendingUp, Zap } from "lucide-react"

interface ComponentPhase {
  name: string
  status: "idle" | "loading" | "complete" | "error"
  progress?: number
  details?: string
}

interface ComponentStatus {
  connectionId: string
  connectionName: string
  exchange: string
  engineRunning: boolean
  isActive?: boolean
  isTestnet: boolean
  phases: {
    prehistoric: {
      completed: boolean
      progressionCycles: number
      startDate?: string
      endDate?: string
    }
    indications: {
      processing: boolean
      cycleCount: number
      avgDurationMs: number
      successRate: string
      recentRecords: number
      lastRun?: string
    }
    strategies: {
      processing: boolean
      cycleCount: number
      avgDurationMs: number
      totalEvaluated: number
      recentRecords: number
      lastRun?: string
    }
    realtime: {
      processing: boolean
      cycleCount: number
      avgDurationMs: number
      lastRun?: string
    }
    liveTrading: {
      active: boolean
      tradesTotal: number
      pseudoPositions: number
      status: string
    }
  }
  metrics: {
    successRate: string
    totalCycles: number
    successfulCycles: number
    failedCycles: number
  }
}

export function SystemVerificationPanel() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/system/verify-engine")
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setStatus(data)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch verification")
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()

    if (autoRefresh) {
      const timer = setInterval(fetchStatus, 5000)
      return () => clearInterval(timer)
    }
  }, [autoRefresh])

  if (loading) return <div className="p-4 text-center">Loading verification...</div>
  if (error) return <div className="p-4 text-red-600">Error: {error}</div>

  // Prefer the active connection; fall back to the first enabled connection
  const allComps = (status?.components ?? []) as ComponentStatus[]
  const comp = (allComps.find((c) => c.isActive) ?? allComps[0]) as ComponentStatus | undefined

  if (!comp) {
    return (
      <Card className="border-yellow-200 bg-yellow-50">
        <CardHeader>
          <CardTitle className="text-yellow-900">No Main Connections</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-yellow-800">Enable a connection to start verification monitoring.</p>
        </CardContent>
      </Card>
    )
  }

  const phases = [
    {
      name: "Prehistoric Data",
      icon: Clock,
      status: comp.phases.prehistoric.completed ? "complete" : "loading",
      details: `${comp.phases.prehistoric.progressionCycles} cycles`,
      critical: true,
    },
    {
      name: "Indications",
      icon: Zap,
      status: comp.phases.indications.processing ? "loading" : "idle",
      details: `${comp.phases.indications.cycleCount} cycles | ${comp.phases.indications.successRate} success`,
      critical: true,
    },
    {
      name: "Strategies",
      icon: TrendingUp,
      status: comp.phases.strategies.processing ? "loading" : "idle",
      details: `${comp.phases.strategies.cycleCount} cycles | ${comp.phases.strategies.totalEvaluated} evaluated`,
      critical: true,
    },
    {
      name: "Realtime",
      icon: Zap,
      status: comp.phases.realtime.processing ? "loading" : "idle",
      details: `${comp.phases.realtime.cycleCount} cycles`,
      critical: false,
    },
    {
      name: "Live Trading",
      icon: CheckCircle,
      status: comp.phases.liveTrading.active ? "complete" : "idle",
      details: `${comp.phases.liveTrading.tradesTotal} trades | ${comp.phases.liveTrading.pseudoPositions} positions`,
      critical: true,
    },
  ]

  const allCriticalComplete =
    comp.engineRunning &&
    comp.phases.prehistoric.completed &&
    comp.phases.indications.cycleCount > 0 &&
    comp.phases.strategies.cycleCount > 0 &&
    comp.phases.liveTrading.active

  // Use yellow only when the engine should be running but isn't (active connection, engine stopped).
  // Inactive connections that are stopped show a neutral muted card — that is expected behavior.
  const engineStopped = !comp.engineRunning
  const cardClass = allCriticalComplete
    ? "border-green-200 bg-green-50"
    : engineStopped
      ? "border-border bg-muted/30"
      : "border-yellow-200 bg-yellow-50"
  const titleClass = allCriticalComplete ? "text-green-900" : engineStopped ? "text-foreground" : "text-yellow-900"
  const descClass = allCriticalComplete ? "text-green-800" : engineStopped ? "text-muted-foreground" : "text-yellow-800"

  return (
    <div className="space-y-4">
      <Card className={cardClass}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className={titleClass}>
                {comp.connectionName} ({comp.exchange.toUpperCase()})
              </CardTitle>
              <CardDescription className={descClass}>
                Engine {comp.engineRunning ? "Running" : "Stopped"} • {comp.isTestnet ? "Testnet" : "Mainnet"}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {comp.engineRunning ? (
                <Badge className="bg-green-600">Engine Running</Badge>
              ) : (
                <Badge variant="secondary">Engine Stopped</Badge>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-2">
        {phases.map((phase, idx) => {
          const Icon = phase.icon
          const isComplete = phase.status === "complete"

          return (
            <Card key={idx} className={isComplete ? "border-green-200" : "border-gray-200"}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex gap-3 flex-1">
                    <Icon className={`w-5 h-5 mt-0.5 ${isComplete ? "text-green-600" : "text-gray-400"}`} />
                    <div className="flex-1">
                      <p className="font-medium">{phase.name}</p>
                      <p className="text-sm text-gray-600">{phase.details}</p>
                    </div>
                  </div>
                  <Badge variant={isComplete ? "default" : "secondary"}>
                    {isComplete ? "Complete" : phase.status === "loading" ? "Processing" : "Idle"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-600">Success Rate</p>
              <p className="text-lg font-semibold">{comp.metrics.successRate}</p>
            </div>
            <div>
              <p className="text-gray-600">Total Cycles</p>
              <p className="text-lg font-semibold">{comp.metrics.totalCycles}</p>
            </div>
            <div>
              <p className="text-gray-600">Successful</p>
              <p className="text-lg font-semibold text-green-600">{comp.metrics.successfulCycles}</p>
            </div>
            <div>
              <p className="text-gray-600">Failed</p>
              <p className="text-lg font-semibold text-red-600">{comp.metrics.failedCycles}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <button
        onClick={() => setAutoRefresh(!autoRefresh)}
        className="w-full px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded border"
      >
        Auto-refresh: {autoRefresh ? "ON" : "OFF"}
      </button>
    </div>
  )
}
