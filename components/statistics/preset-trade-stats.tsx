"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { AnalyticsFilter } from "@/lib/analytics"
import { AnalyticsEngine } from "@/lib/analytics"
import type { TradingPosition } from "@/lib/trading"
import { TrendingUp, TrendingDown, Activity, Target, Clock, DollarSign } from "lucide-react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { formatSampledMetric, grossProfitFactorTitle } from "@/lib/metric-formatting"

interface PresetTradeStatsProps {
  filter: AnalyticsFilter
  positions: TradingPosition[]
  connectionId?: string | null
}

interface PresetStats {
  preset_id: string
  preset_name: string
  total_trades: number
  winning_trades: number
  losing_trades: number
  flat_trades: number
  win_rate: number
  total_pnl: number
  avg_pnl: number
  profit_factor: number
  gross_profit: number
  gross_loss: number
  max_drawdown_usd: number
  drawdown_time_hours: number
  avg_duration_minutes: number
  best_symbol: string
  worst_symbol: string
}

export function PresetTradeStats({ filter, positions, connectionId }: PresetTradeStatsProps) {
  const [presets, setPresets] = useState<any[]>([])
  const [presetStats, setPresetStats] = useState<PresetStats[]>([])

  useEffect(() => {
    if (!connectionId) {
      setPresets([])
      return
    }
    setPresets([])
    const controller = new AbortController()
    void fetch(`/api/presets?connectionId=${encodeURIComponent(connectionId)}`, {
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : [])
      .then((data) => {
        if (!controller.signal.aborted) setPresets(Array.isArray(data) ? data : [])
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error("[v0] Failed to load presets:", error)
      })
    return () => controller.abort()
  }, [connectionId])

  useEffect(() => {
    if (presets.length > 0) {
      calculatePresetStats()
    } else {
      setPresetStats([])
    }
  }, [presets, filter, positions])

  const calculatePresetStats = () => {
    const stats: PresetStats[] = []
    // Position-level filters use the same close-time semantics as the main
    // AnalyticsEngine. Aggregate PF/DDT limits are applied to each preset row
    // below, after its exact closed-trade metrics exist.
    const filteredPositions = new AnalyticsEngine(positions).filterPositions({
      ...filter,
      minProfitFactor: undefined,
      maxDrawdown: undefined,
    })

    for (const preset of presets) {
      // Attribution must be durable and exact. Never fabricate preset
      // performance by randomly assigning unrelated Main/Signal positions.
      const presetPositions = filteredPositions.filter((position) =>
        String(position.preset_id || "") === String(preset.id),
      )

      if (presetPositions.length === 0) continue

      const closedPositions = presetPositions
        .filter((p) => p.status === "closed")
        .sort((left, right) =>
          new Date(left.closed_at || left.opened_at).getTime() -
          new Date(right.closed_at || right.opened_at).getTime() ||
          left.id.localeCompare(right.id),
        )
      const winningTrades = closedPositions.filter((p) => (p.profit_loss || 0) > 0)
      const losingTrades = closedPositions.filter((p) => (p.profit_loss || 0) < 0)
      const flatTrades = closedPositions.filter((p) => (p.profit_loss || 0) === 0)

      const totalPnl = closedPositions.reduce((sum, p) => sum + (p.profit_loss || 0), 0)
      const totalProfit = winningTrades.reduce((sum, p) => sum + (p.profit_loss || 0), 0)
      const totalLoss = Math.abs(losingTrades.reduce((sum, p) => sum + (p.profit_loss || 0), 0))

      const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Number.POSITIVE_INFINITY : 0

      // Exact realised USD drawdown and total drawdown duration. A percentage
      // cannot be derived from this zero-baseline P&L series without inventing
      // an account balance.
      let cumulativePnl = 0
      let peak = 0
      let maxDrawdownUsd = 0
      let drawdownStartMs: number | null = null
      let drawdownTimeHours = 0
      for (const pos of closedPositions) {
        const eventMs = new Date(pos.closed_at || pos.opened_at).getTime()
        cumulativePnl += pos.profit_loss || 0
        if (cumulativePnl >= peak) {
          peak = cumulativePnl
          if (drawdownStartMs !== null && Number.isFinite(eventMs)) {
            drawdownTimeHours += Math.max(0, eventMs - drawdownStartMs) / 3_600_000
            drawdownStartMs = null
          }
        } else {
          maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cumulativePnl)
          if (drawdownStartMs === null && Number.isFinite(eventMs)) drawdownStartMs = eventMs
        }
      }
      if (drawdownStartMs !== null && closedPositions.length > 0) {
        const lastMs = new Date(
          closedPositions[closedPositions.length - 1].closed_at ||
          closedPositions[closedPositions.length - 1].opened_at,
        ).getTime()
        if (Number.isFinite(lastMs)) {
          drawdownTimeHours += Math.max(0, lastMs - drawdownStartMs) / 3_600_000
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
        flat_trades: flatTrades.length,
        win_rate: winningTrades.length + losingTrades.length > 0
          ? (winningTrades.length / (winningTrades.length + losingTrades.length)) * 100
          : 0,
        total_pnl: totalPnl,
        avg_pnl: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
        profit_factor: profitFactor,
        gross_profit: totalProfit,
        gross_loss: totalLoss,
        max_drawdown_usd: maxDrawdownUsd,
        drawdown_time_hours: drawdownTimeHours,
        avg_duration_minutes: avgDuration,
        best_symbol: bestSymbol,
        worst_symbol: worstSymbol,
      })
    }

    const minimumProfitFactor = Number(filter.minProfitFactor)
    const maximumDrawdownHours = Number(filter.maxDrawdown)
    const filteredStats = stats.filter((row) =>
      (!Number.isFinite(minimumProfitFactor) || minimumProfitFactor <= 0 ||
        row.profit_factor >= minimumProfitFactor) &&
      (!Number.isFinite(maximumDrawdownHours) || maximumDrawdownHours <= 0 ||
        row.drawdown_time_hours <= maximumDrawdownHours),
    )

    // Sort by profit factor (Infinity sorts higher than any finite value)
    filteredStats.sort((a, b) => {
      const infA = !Number.isFinite(a.profit_factor)
      const infB = !Number.isFinite(b.profit_factor)
      if (infA && infB) return 0
      if (infA) return -1
      if (infB) return 1
      return b.profit_factor - a.profit_factor
    })
    setPresetStats(filteredStats)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  const totalTrades = presetStats.reduce((sum, s) => sum + s.total_trades, 0)
  const totalWins = presetStats.reduce((sum, s) => sum + s.winning_trades, 0)
  const totalLosses = presetStats.reduce((sum, s) => sum + s.losing_trades, 0)
  const totalGrossProfit = presetStats.reduce((sum, s) => sum + s.gross_profit, 0)
  const totalGrossLoss = presetStats.reduce((sum, s) => sum + s.gross_loss, 0)
  const totalStats = {
    total_trades: totalTrades,
    total_pnl: presetStats.reduce((sum, s) => sum + s.total_pnl, 0),
    win_rate: totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
    profit_factor: totalGrossLoss > 0
      ? totalGrossProfit / totalGrossLoss
      : totalGrossProfit > 0
        ? Number.POSITIVE_INFINITY
        : 0,
  }
  const finitePresetPfChart = presetStats.filter((row) => Number.isFinite(row.profit_factor))

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
                <div className="text-2xl font-bold">{totalStats.win_rate.toFixed(1)}%</div>
                <div className="text-sm text-muted-foreground">Win Rate</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{formatSampledMetric(totalStats.profit_factor, totalStats.total_trades)}</div>
                <div className="text-sm text-muted-foreground">Combined PF</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profit Factor by Preset</CardTitle>
            <CardDescription>Finite classic realised PF values; loss-free presets remain visible as ∞ in the detail list.</CardDescription>
          </CardHeader>
          <CardContent>
            {finitePresetPfChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={finitePresetPfChart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="preset_name" angle={-45} textAnchor="end" height={100} />
                  <YAxis />
                  <Tooltip formatter={(value: number) => [formatSampledMetric(value, 1), "PF"]} />
                  <Bar dataKey="profit_factor" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
                No finite classic-PF values in the selected sample.
              </div>
            )}
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
                        <div className="font-medium text-red-600">{formatCurrency(stat.max_drawdown_usd)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Total DDT</div>
                        <div className="font-medium text-red-600">{stat.drawdown_time_hours.toFixed(1)}h</div>
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
                      {stat.flat_trades > 0 && (
                        <Badge variant="outline" className="text-muted-foreground">
                          {stat.flat_trades} flat
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}

            {presetStats.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Target className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No preset statistics available</p>
                <p className="text-sm">No preset-attributed closed trades match the current filters.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
