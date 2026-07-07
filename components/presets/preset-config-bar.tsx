"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Activity,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react"
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

interface PresetConfigBarProps {
  config: any
  onToggle: (configId: string, enabled: boolean) => void
  executionStatus?: "pending" | "running" | "success" | "error" // Added execution status prop
}

export function PresetConfigBar({ config, onToggle, executionStatus }: PresetConfigBarProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const indicatorType = config.indicator_type || "unknown"
  const symbol = config.symbol || "N/A"
  const timeframe = config.timeframe || "N/A"
  const profitFactor = config.profit_factor || 0
  const winRate = config.win_rate || 0
  const totalTrades = config.total_trades || 0
  const takeprofitFactor = config.takeprofit_factor || 0
  const stoplossRatio = config.stoploss_ratio || 0
  const trailingEnabled = config.trailing_enabled ?? false
  const isActive = config.is_active ?? false
  const configId = config.config_id || config.id || ""
  const indicatorParams = config.indicator_params || {}
  const maxDrawdown = config.max_drawdown || 0
  const drawdownHours = config.drawdown_hours || 0
  const sharpeRatio = config.sharpe_ratio || 0
  const winningTrades = config.winning_trades || 0
  const losingTrades = config.losing_trades || 0
  const trailStart = config.trail_start || 0
  const trailStop = config.trail_stop || 0

  // Mock chart data for last 10 days
  const chartData = Array.from({ length: 10 }, (_, i) => ({
    day: i + 1,
    balance: 10000 + Math.random() * 2000 - 1000,
    equity: 10000 + Math.random() * 2000 - 1000,
  }))

  const indicatorColorMap: Record<string, string> = {
    rsi: "bg-blue-500",
    macd: "bg-purple-500",
    bollinger: "bg-green-500",
    sar: "bg-orange-500",
    ema: "bg-pink-500",
    sma: "bg-cyan-500",
    stochastic: "bg-yellow-500",
  }

  const indicatorColor = indicatorColorMap[indicatorType] || "bg-gray-500"

  const renderExecutionStatus = () => {
    if (!executionStatus) return null

    switch (executionStatus) {
      case "pending":
        return (
          <Badge variant="outline" className="ml-2">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        )
      case "running":
        return (
          <Badge variant="default" className="ml-2 bg-blue-500">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Running
          </Badge>
        )
      case "success":
        return (
          <Badge variant="default" className="ml-2 bg-green-500">
            <CheckCircle className="h-3 w-3 mr-1" />
            Success
          </Badge>
        )
      case "error":
        return (
          <Badge variant="destructive" className="ml-2">
            <XCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        )
    }
  }

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          {/* Left: Toggle switch */}
          <Switch checked={isActive} onCheckedChange={(checked) => onToggle && onToggle(configId, checked)} />

          {/* Middle: Configuration summary */}
          <div className="flex-1 grid grid-cols-6 gap-3 text-sm">
            <div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${indicatorColor}`} />
                <span className="font-medium">{indicatorType.toUpperCase()}</span>
                {renderExecutionStatus()}
              </div>
              <div className="text-xs text-muted-foreground">{symbol}</div>
            </div>

            <div>
              <div className="font-medium">{timeframe}</div>
              <div className="text-xs text-muted-foreground">Timeframe</div>
            </div>

            <div>
              <div className="font-medium text-green-600">{profitFactor.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground">Profit Factor</div>
            </div>

            <div>
              <div className="font-medium">{(winRate * 100).toFixed(1)}%</div>
              <div className="text-xs text-muted-foreground">Win Rate</div>
            </div>

            <div>
              <div className="font-medium">{totalTrades}</div>
              <div className="text-xs text-muted-foreground">Trades</div>
            </div>

            <div className="flex items-center gap-2">
              {trailingEnabled && (
                <Badge variant="outline" className="text-xs">
                  Trail
                </Badge>
              )}
              <Badge variant="secondary" className="text-xs">
                TP: {takeprofitFactor}x
              </Badge>
            </div>
          </div>

          {/* Right: Expand button */}
          <Button variant="ghost" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>

        {isExpanded && (
          <div className="mt-4 pt-4 border-t space-y-4">
            {/* Configuration details */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Indicator Params</div>
                <div className="font-mono text-xs mt-1">{JSON.stringify(indicatorParams, null, 2)}</div>
              </div>

              <div>
                <div className="text-muted-foreground">Take Profit</div>
                <div className="font-medium">{takeprofitFactor}x (0.1% cost)</div>
                <div className="text-xs text-muted-foreground mt-1">{(takeprofitFactor * 0.1).toFixed(2)}% target</div>
              </div>

              <div>
                <div className="text-muted-foreground">Stop Loss</div>
                <div className="font-medium">{stoplossRatio}x ratio</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {(stoplossRatio * takeprofitFactor * 0.1).toFixed(2)}% risk
                </div>
              </div>

              <div>
                <div className="text-muted-foreground">Trailing</div>
                {trailingEnabled ? (
                  <>
                    <div className="font-medium">Enabled</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Start: {trailStart}x, Stop: {trailStop}x
                    </div>
                  </>
                ) : (
                  <div className="font-medium">Disabled</div>
                )}
              </div>
            </div>

            {/* Performance metrics */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Max Drawdown</div>
                <div className="font-medium text-red-600">{maxDrawdown.toFixed(2)}%</div>
              </div>

              <div>
                <div className="text-muted-foreground">Drawdown Time</div>
                <div className="font-medium">{drawdownHours.toFixed(1)}h</div>
              </div>

              <div>
                <div className="text-muted-foreground">Sharpe Ratio</div>
                <div className="font-medium">{sharpeRatio.toFixed(2)}</div>
              </div>

              <div>
                <div className="text-muted-foreground">Winning Trades</div>
                <div className="font-medium text-green-600">{winningTrades}</div>
              </div>

              <div>
                <div className="text-muted-foreground">Losing Trades</div>
                <div className="font-medium text-red-600">{losingTrades}</div>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Last 10 Days Performance</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData}>
                  <XAxis dataKey="day" stroke="#888888" fontSize={12} />
                  <YAxis stroke="#888888" fontSize={12} />
                  <Tooltip />
                  <Line type="monotone" dataKey="balance" stroke="#10b981" strokeWidth={2} dot={false} name="Balance" />
                  <Line type="monotone" dataKey="equity" stroke="#3b82f6" strokeWidth={2} dot={false} name="Equity" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Status badges */}
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                <Activity className="h-3 w-3 mr-1" />
                Active
              </Badge>
              {profitFactor > 1 && (
                <Badge variant="default" className="bg-green-500">
                  <TrendingUp className="h-3 w-3 mr-1" />
                  Profitable
                </Badge>
              )}
              {profitFactor < 0.6 && (
                <Badge variant="destructive">
                  <TrendingDown className="h-3 w-3 mr-1" />
                  Underperforming
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
