"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, TrendingDown, Target, AlertTriangle, type LucideIcon } from "lucide-react"

interface PortfolioMetricsProps {
  metrics: {
    total_value: number
    total_return: number
    total_return_percent: number
    daily_pnl: number
    weekly_pnl: number
    monthly_pnl: number
    sharpe_ratio: number
    max_drawdown: number
    win_rate: number
    profit_factor: number
    average_win: number
    average_loss: number
    total_trades: number
    winning_trades: number
    losing_trades: number
  }
}

const iconMap: Record<string, LucideIcon> = {
  TrendingUp,
  TrendingDown,
  Target,
  AlertTriangle,
}

export function PortfolioMetrics({ metrics }: PortfolioMetricsProps) {
  const performanceCards = [
    {
      title: "Total Return",
      value: `$${metrics.total_return.toFixed(2)}`,
      subtitle: `${metrics.total_return_percent.toFixed(2)}%`,
      icon: metrics.total_return >= 0 ? "TrendingUp" : "TrendingDown",
      color: metrics.total_return >= 0 ? "text-green-600" : "text-red-600",
      bgColor: metrics.total_return >= 0 ? "bg-green-50" : "bg-red-50",
    },
    {
      title: "Win Rate",
      value: `${metrics.win_rate.toFixed(1)}%`,
      subtitle: `${metrics.winning_trades}W / ${metrics.losing_trades}L`,
      icon: "Target",
      color: metrics.win_rate >= 50 ? "text-green-600" : "text-yellow-600",
      bgColor: metrics.win_rate >= 50 ? "bg-green-50" : "bg-yellow-50",
    },
    {
      title: "Profit Factor",
      value: metrics.profit_factor.toFixed(2),
      subtitle: `Avg Win: $${metrics.average_win.toFixed(2)}`,
      icon: "TrendingUp",
      color: metrics.profit_factor >= 1.5 ? "text-green-600" : "text-yellow-600",
      bgColor: metrics.profit_factor >= 1.5 ? "bg-green-50" : "bg-yellow-50",
    },
    {
      title: "Max Drawdown",
      value: `${metrics.max_drawdown.toFixed(2)}%`,
      subtitle: `Sharpe: ${metrics.sharpe_ratio.toFixed(2)}`,
      icon: "AlertTriangle",
      color: metrics.max_drawdown <= 20 ? "text-green-600" : "text-red-600",
      bgColor: metrics.max_drawdown <= 20 ? "bg-green-50" : "bg-red-50",
    },
  ]

  const periodPnL = [
    { label: "Daily P&L", value: metrics.daily_pnl },
    { label: "Weekly P&L", value: metrics.weekly_pnl },
    { label: "Monthly P&L", value: metrics.monthly_pnl },
  ]

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {performanceCards.map((card, index) => {
          const Icon = iconMap[card.icon]
          return (
            <Card key={index}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
                  <div className={`p-2 rounded-full ${card.bgColor}`}>
                    <Icon className={`h-5 w-5 ${card.color}`} />
                  </div>
                </div>
                <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{card.subtitle}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Period P&L */}
      <Card>
        <CardHeader>
          <CardTitle>Period Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {periodPnL.map((period, index) => {
              const isProfit = period.value >= 0
              return (
                <div key={index} className="space-y-2">
                  <p className="text-sm text-muted-foreground">{period.label}</p>
                  <div className="flex items-center gap-2">
                    {isProfit ? (
                      <TrendingUp className="h-5 w-5 text-green-600" />
                    ) : (
                      <TrendingDown className="h-5 w-5 text-red-600" />
                    )}
                    <p className={`text-2xl font-bold ${isProfit ? "text-green-600" : "text-red-600"}`}>
                      {isProfit ? "+" : ""}${period.value.toFixed(2)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Trading Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>Trading Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Total Trades</p>
              <p className="text-2xl font-bold">{metrics.total_trades}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Winning Trades</p>
              <p className="text-2xl font-bold text-green-600">{metrics.winning_trades}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Losing Trades</p>
              <p className="text-2xl font-bold text-red-600">{metrics.losing_trades}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Avg Loss</p>
              <p className="text-2xl font-bold text-red-600">${metrics.average_loss.toFixed(2)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
