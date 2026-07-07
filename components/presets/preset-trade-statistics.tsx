"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Activity, TrendingUp, TrendingDown, Clock, AlertCircle } from "lucide-react"

interface PresetTradeStats {
  setId: string
  setName: string
  totalPositions: number
  activePositions: number
  closedPositions: number
  overallProfitFactor: number
  winRate: number
  avgDrawdownTime: number
  symbolBreakdown: {
    symbol: string
    positions: number
    profitFactor: number
    winRate: number
    status: "healthy" | "warning" | "critical"
  }[]
  lastEvaluated: string | null
  autoDisabled: boolean
  disabledReason: string | null
}

export function PresetTradeStatistics({ presetTypeId }: { presetTypeId: string }) {
  const [stats, setStats] = useState<PresetTradeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [evaluating, setEvaluating] = useState(false)

  useEffect(() => {
    fetchStatistics()
  }, [presetTypeId])

  const fetchStatistics = async () => {
    try {
      const res = await fetch(`/api/preset-types/${presetTypeId}/statistics`)
      const data = await res.json()
      setStats(data)
    } catch (error) {
      console.error("[v0] Failed to fetch preset trade statistics:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleManualEvaluation = async () => {
    setEvaluating(true)
    try {
      await fetch(`/api/preset-sets/${stats?.setId}/evaluate`, { method: "POST" })
      await fetchStatistics()
    } catch (error) {
      console.error("[v0] Failed to trigger evaluation:", error)
    } finally {
      setEvaluating(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Activity className="h-5 w-5 animate-spin mr-2" />
            Loading statistics...
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!stats) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground text-center">No statistics available</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Overall Statistics */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Preset Trade Statistics</CardTitle>
              <CardDescription>{stats.setName}</CardDescription>
            </div>
            <Button onClick={handleManualEvaluation} disabled={evaluating} size="sm">
              {evaluating ? "Evaluating..." : "Re-evaluate Now"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Positions</p>
              <p className="text-2xl font-bold">{stats.totalPositions}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Active</p>
              <p className="text-2xl font-bold text-blue-500">{stats.activePositions}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">PF</p>
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold">{stats.totalPositions > 0 ? stats.overallProfitFactor.toFixed(3) : "—"}</p>
                {stats.overallProfitFactor >= 1.0 ? (
                  <TrendingUp className="h-5 w-5 text-green-500" />
                ) : (
                  <TrendingDown className="h-5 w-5 text-red-500" />
                )}
              </div>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Win Rate</p>
              <p className="text-2xl font-bold">{(stats.winRate * 100).toFixed(1)}%</p>
            </div>
          </div>

          {stats.autoDisabled && (
            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-700 dark:text-red-400">Auto-disabled</p>
                <p className="text-sm text-red-600 dark:text-red-400">{stats.disabledReason}</p>
              </div>
            </div>
          )}

          {stats.lastEvaluated && (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              Last evaluated: {new Date(stats.lastEvaluated).toLocaleString()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Symbol Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Symbol Performance</CardTitle>
          <CardDescription>Breakdown by trading symbol</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {stats.symbolBreakdown.map((symbolStat) => (
              <div
                key={symbolStat.symbol}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      symbolStat.status === "healthy"
                        ? "default"
                        : symbolStat.status === "warning"
                          ? "secondary"
                          : "destructive"
                    }
                  >
                    {symbolStat.symbol}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium">{symbolStat.positions} positions</p>
                    <p className="text-xs text-muted-foreground">Win rate: {(symbolStat.winRate * 100).toFixed(1)}%</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold">PF: {symbolStat.positions > 0 ? symbolStat.profitFactor.toFixed(3) : "—"}</p>
                  <p className="text-xs text-muted-foreground capitalize">{symbolStat.status}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
