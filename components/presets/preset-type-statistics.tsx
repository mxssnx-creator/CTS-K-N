"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { TrendingUp, TrendingDown, Activity, Target, BarChart3 } from "lucide-react"

interface PresetTypeStatisticsProps {
  presetTypeId: string
  presetTypeName: string
}

export function PresetTypeStatistics({ presetTypeId, presetTypeName }: PresetTypeStatisticsProps) {
  const [statistics, setStatistics] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStatistics()
  }, [presetTypeId])

  const loadStatistics = async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/preset-types/${presetTypeId}/statistics`)
      if (response.ok) {
        const data = await response.json()
        setStatistics(data)
      }
    } catch (error) {
      console.error("[v0] Failed to load statistics:", error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!statistics) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">No statistics available</CardContent>
      </Card>
    )
  }

  const { summary, set_performance, recent_trades, performance_over_time } = statistics

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Trades</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.total_trades}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.open_trades} open, {summary.closed_trades} closed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.win_rate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.winning_trades}W / {summary.losing_trades}L
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Profit Factor</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.profit_factor.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.profit_factor >= 1.5 ? "Excellent" : summary.profit_factor >= 1.0 ? "Good" : "Poor"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total PnL</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${summary.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
              ${summary.total_pnl.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Avg Win: ${summary.avg_win.toFixed(2)} | Avg Loss: ${summary.avg_loss.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Configuration Sets Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Configuration Sets Performance
          </CardTitle>
          <CardDescription>
            Performance breakdown by configuration set ({summary.active_sets} active sets)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {set_performance.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No trades yet</p>
          ) : (
            <div className="space-y-3">
              {set_performance.map((set: any) => (
                <div key={set.set_id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex-1">
                    <div className="font-medium">{set.set_name}</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {set.trades_count} trades • {set.wins}W / {set.losses}L • WR: {set.win_rate.toFixed(1)}%
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-medium">PF: {set.profit_factor.toFixed(2)}</div>
                      <div
                        className={`text-sm font-bold ${Number.parseFloat(set.total_pnl) >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        ${Number.parseFloat(set.total_pnl || 0).toFixed(2)}
                      </div>
                    </div>
                    {Number.parseFloat(set.total_pnl) >= 0 ? (
                      <TrendingUp className="h-5 w-5 text-green-600" />
                    ) : (
                      <TrendingDown className="h-5 w-5 text-red-600" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Performance Over Time */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Performance Over Time (Last 7 Days)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {performance_over_time.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {performance_over_time.map((day: any) => (
                <div key={day.date} className="flex items-center justify-between p-2 border-b last:border-0">
                  <div className="text-sm font-medium">{new Date(day.date).toLocaleDateString()}</div>
                  <div className="flex items-center gap-4">
                    <div className="text-sm text-muted-foreground">
                      {day.trades} trades ({day.wins} wins)
                    </div>
                    <div
                      className={`text-sm font-bold ${Number.parseFloat(day.pnl) >= 0 ? "text-green-600" : "text-red-600"}`}
                    >
                      ${Number.parseFloat(day.pnl || 0).toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Trades */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Recent Trades
          </CardTitle>
          <CardDescription>Last 20 trades from this preset type</CardDescription>
        </CardHeader>
        <CardContent>
          {recent_trades.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No trades yet</p>
          ) : (
            <div className="space-y-2">
              {recent_trades.map((trade: any) => (
                <div key={trade.id} className="flex items-center justify-between p-3 border rounded-lg text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{trade.symbol}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {trade.set_name} • {trade.connection_name}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={trade.side === "long" ? "default" : "secondary"}>{trade.side}</Badge>
                    <Badge variant={trade.status === "open" ? "outline" : "secondary"}>{trade.status}</Badge>
                    {trade.status === "closed" && (
                      <div
                        className={`font-bold ${Number.parseFloat(trade.profit_loss) >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        ${Number.parseFloat(trade.profit_loss || 0).toFixed(2)}
                      </div>
                    )}
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
