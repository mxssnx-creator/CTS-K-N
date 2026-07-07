"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { AnalyticsFilter } from "@/lib/analytics"
import type { TradingPosition } from "@/lib/trading"
import { TrendingUp, TrendingDown, Activity, Target, Clock, DollarSign } from "lucide-react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { formatSampledMetric, grossProfitFactorTitle } from "@/lib/metric-formatting"

interface PresetTradeStatsProps {
  filter: AnalyticsFilter
  positions: TradingPosition[]
}

interface PresetStats {
  preset_id: string
  preset_name: string
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number
  total_pnl: number
  avg_pnl: number
  profit_factor: number
  max_drawdown: number
  avg_duration_minutes: number
  best_symbol: string
  worst_symbol: string
}

export function PresetTradeStats({ filter, positions }: PresetTradeStatsProps) {
  const [presets, setPresets] = useState<any[]>([])
  const [presetStats, setPresetStats] = useState<PresetStats[]>([])

  useEffect(() => {
    loadPresets()
  }, [])

  useEffect(() => {
    if (presets.length > 0) {
      calculatePresetStats()
    }
  }, [presets, filter, positions])

  const loadPresets = async () => {
    try {
      const response = await fetch("/api/presets")
      const data = await response.json()
      setPresets(data)
    } catch (error) {
      console.error("[v0] Failed to load presets:", error)
    }
  }

  const calculatePresetStats = () => {
    const stats: PresetStats[] = []

    const filteredPresets = presets

    for (const preset of filteredPresets) {
      // Mock: In production, filter positions by preset_id from database
      // For now, randomly assign positions to presets for demonstration
      const presetPositions = positions.filter(() => Math.random() > 0.7)

      if (presetPositions.length === 0) continue

      const closedPositions = presetPositions.filter((p) => p.status === "closed")
      const winningTrades = closedPositions.filter((p) => (p.profit_loss || 0) > 0)
      const losingTrades = closedPositions.filter((p) => (p.profit_loss || 0) <= 0)

      const totalPnl = closedPositions.reduce((sum, p) => sum + (p.profit_loss || 0), 0)
      const totalProfit = winningTrades.reduce((sum, p) => sum + (p.profit_loss || 0), 0)
      const totalLoss = Math.abs(losingTrades.reduce((sum, p) => sum + (p.profit_loss || 0), 0))

      const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Number.POSITIVE_INFINITY : 0

      // Calculate max drawdown
      let cumulativePnl = 0
      let peak = 0
      let maxDrawdown = 0

      for (const pos of closedPositions.sort(
        (a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime(),
      )) {
        cumulativePnl += pos.profit_loss || 0
        if (cumulativePnl > peak) {
          peak = cumulativePnl
        } else {
          const drawdown = ((peak - cumulativePnl) / peak) * 100
          if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown
          }
        }
      }

      // Calculate average duration
      const avgDuration =
        closedPositions.length > 0
          ? closedPositions.reduce((sum, p) => {
              const duration = p.closed_at
                ? (new Date(p.closed_at).getTime() - new Date(p.opened_at).getTime()) / (1000 * 60)
                : 0
              return sum + duration
            }, 0) / closedPositions.length
          : 0

      // Find best and worst symbols
      const symbolPnl = new Map<string, number>()
      for (const pos of closedPositions) {
        const current = symbolPnl.get(pos.symbol) || 0
        symbolPnl.set(pos.symbol, current + (pos.profit_loss || 0))
      }

      const sortedSymbols = Array.from(symbolPnl.entries()).sort((a, b) => b[1] - a[1])
      const bestSymbol = sortedSymbols[0]?.[0] || "N/A"
      const worstSymbol = sortedSymbols[sortedSymbols.length - 1]?.[0] || "N/A"

      stats.push({
        preset_id: preset.id,
        preset_name: preset.name,
        total_trades: closedPositions.length,
        winning_trades: winningTrades.length,
        losing_trades: losingTrades.length,
        win_rate: closedPositions.length > 0 ? (winningTrades.length / closedPositions.length) * 100 : 0,
        total_pnl: totalPnl,
        avg_pnl: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
        profit_factor: profitFactor,
        max_drawdown: maxDrawdown,
        avg_duration_minutes: avgDuration,
        best_symbol: bestSymbol,
        worst_symbol: worstSymbol,
      })
    }

    // Sort by profit factor
    stats.sort((a, b) => b.profit_factor - a.profit_factor)
    setPresetStats(stats)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  const totalTrades = presetStats.reduce((sum, s) => sum + s.total_trades, 0)
  const totalStats = {
    total_trades: totalTrades,
    total_pnl: presetStats.reduce((sum, s) => sum + s.total_pnl, 0),
    avg_win_rate: presetStats.length > 0 ? presetStats.reduce((sum, s) => sum + s.win_rate, 0) / presetStats.length : 0,
    avg_profit_factor: totalTrades > 0 ? presetStats.reduce((sum, s) => sum + s.profit_factor, 0) / presetStats.length : 0,
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Preset Performance Overview</CardTitle>
          <CardDescription>Trading statistics grouped by preset configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{totalStats.total_trades}</div>
                <div className="text-sm text-muted-foreground">Total Trades</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign className={`h-5 w-5 ${totalStats.total_pnl >= 0 ? "text-green-500" : "text-red-500"}`} />
              <div>
                <div className={`text-2xl font-bold ${totalStats.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(totalStats.total_pnl)}
                </div>
                <div className="text-sm text-muted-foreground">Total P&L</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-2xl font-bold">{totalStats.avg_win_rate.toFixed(1)}%</div>
                <div className="text-sm text-muted-foreground">Avg Win Rate</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{formatSampledMetric(totalStats.avg_profit_factor, totalStats.total_trades)}</div>
                <div className="text-sm text-muted-foreground">Avg PF</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profit Factor by Preset</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={presetStats}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="preset_name" angle={-45} textAnchor="end" height={100} />
                <YAxis />
                <Tooltip formatter={(value: number) => [formatSampledMetric(value, 1), "PF"]} />
                <Bar dataKey="profit_factor" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win Rate by Preset</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={presetStats}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="preset_name" angle={-45} textAnchor="end" height={100} />
                <YAxis />
                <Tooltip formatter={(value: number) => [`${value.toFixed(1)}%`, "Win Rate"]} />
                <Bar dataKey="win_rate" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Detailed Preset Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {presetStats.map((stat) => (
              <Card key={stat.preset_id}>
                <CardContent className="p-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-lg">{stat.preset_name}</h3>
                      <Badge variant={stat.profit_factor >= 1 ? "default" : "destructive"} title={grossProfitFactorTitle(stat.profit_factor, stat.total_trades)}>
                        PF: {formatSampledMetric(stat.profit_factor, stat.total_trades)}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div>
                        <div className="text-muted-foreground">Total Trades</div>
                        <div className="font-medium flex items-center gap-1">
                          <Activity className="h-3 w-3" />
                          {stat.total_trades}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Win Rate</div>
                        <div className="font-medium flex items-center gap-1">
                          <Target className="h-3 w-3" />
                          {stat.win_rate.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Total P&L</div>
                        <div
                          className={`font-medium flex items-center gap-1 ${stat.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {stat.total_pnl >= 0 ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          )}
                          {formatCurrency(stat.total_pnl)}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Avg P&L</div>
                        <div className="font-medium">{formatCurrency(stat.avg_pnl)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Max Drawdown</div>
                        <div className="font-medium text-red-600">{stat.max_drawdown.toFixed(1)}%</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Avg Duration</div>
                        <div className="font-medium flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {stat.avg_duration_minutes.toFixed(0)}m
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Best Symbol</div>
                        <div className="font-medium text-green-600">{stat.best_symbol}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Worst Symbol</div>
                        <div className="font-medium text-red-600">{stat.worst_symbol}</div>
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2 border-t">
                      <Badge variant="outline" className="text-green-600">
                        {stat.winning_trades} wins
                      </Badge>
                      <Badge variant="outline" className="text-red-600">
                        {stat.losing_trades} losses
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}

            {presetStats.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Target className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No preset statistics available</p>
                <p className="text-sm">Select presets from the filters to view their performance</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
