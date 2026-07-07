"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { TradingStats, TimeRangeStats } from "@/lib/trading"
import { TrendingUp, DollarSign, BarChart3, Activity, Target, AlertTriangle } from "lucide-react"

interface TradingOverviewProps {
  stats: TradingStats
  timeRangeStats: {
    "4h": TimeRangeStats
    "12h": TimeRangeStats
    "24h": TimeRangeStats
    "48h": TimeRangeStats
  }
  onCloseProfitablePositions: () => void
  onCloseAllPositions: () => void
}

export function TradingOverview({
  stats,
  timeRangeStats,
  onCloseProfitablePositions,
  onCloseAllPositions,
}: TradingOverviewProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  const marginUsagePercentage = stats.balance > 0 ? (stats.margin / stats.balance) * 100 : 0

  return (
    <div className="space-y-6">
      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Button onClick={onCloseProfitablePositions} className="flex-1 bg-transparent" variant="outline">
            <TrendingUp className="h-4 w-4 mr-2" />
            Close Profitable Positions
          </Button>
          <Button onClick={onCloseAllPositions} className="flex-1" variant="destructive">
            <AlertTriangle className="h-4 w-4 mr-2" />
            Close All Positions
          </Button>
        </CardContent>
      </Card>

      {/* Account Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{formatCurrency(stats.balance)}</div>
                <div className="text-sm text-muted-foreground">Balance</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{formatCurrency(stats.equity)}</div>
                <div className="text-sm text-muted-foreground">Equity</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{formatCurrency(stats.margin)}</div>
                <div className="text-sm text-muted-foreground">Margin Used</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-2xl font-bold">{stats.open_positions}</div>
                <div className="text-sm text-muted-foreground">Open Positions</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Performance Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Trading Performance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total P&L</span>
              <span className={`font-semibold ${stats.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(stats.total_pnl)}
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Win Rate</span>
              <span className="font-semibold">{(stats.win_rate * 100).toFixed(1)}%</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Avg Hold Time</span>
              <span className="font-semibold">
                {stats.avg_hold_time < 60
                  ? `${Math.floor(stats.avg_hold_time)}m`
                  : `${Math.floor(stats.avg_hold_time / 60)}h ${Math.floor(stats.avg_hold_time % 60)}m`}
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Largest Win</span>
              <span className="font-semibold text-green-600">{formatCurrency(stats.largest_win)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Largest Loss</span>
              <span className="font-semibold text-red-600">{formatCurrency(stats.largest_loss)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Margin Usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Used: {formatCurrency(stats.margin)}</span>
                <span>{marginUsagePercentage.toFixed(1)}%</span>
              </div>
              <Progress value={marginUsagePercentage} className="h-2" />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Free Margin</span>
                <span className="font-medium">{formatCurrency(stats.free_margin)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Volume</span>
                <span className="font-medium">{stats.total_volume.toFixed(4)} BTC</span>
              </div>
            </div>

            <div className="pt-2 border-t">
              <Badge
                variant={
                  marginUsagePercentage > 80 ? "destructive" : marginUsagePercentage > 60 ? "secondary" : "outline"
                }
              >
                {marginUsagePercentage > 80 ? "High Risk" : marginUsagePercentage > 60 ? "Medium Risk" : "Low Risk"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Time Range Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Time Range</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {Object.entries(timeRangeStats).map(([period, data]) => (
              <div key={period} className="space-y-2">
                <div className="font-semibold text-center">{period.toUpperCase()}</div>
                <div className="text-center">
                  <div className="text-lg font-bold">{data.positions_count}</div>
                  <div className="text-xs text-muted-foreground">Positions</div>
                </div>
                <div className="text-center">
                  <div className={`text-lg font-bold ${data.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCurrency(data.total_pnl)}
                  </div>
                  <div className="text-xs text-muted-foreground">P&L</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-medium">{(data.win_rate * 100).toFixed(1)}%</div>
                  <div className="text-xs text-muted-foreground">Win Rate</div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
