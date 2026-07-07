"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Activity, Target, BarChart3 } from 'lucide-react'
import { cn } from "@/lib/utils"
import type { StrategyResult } from "@/lib/strategies"

interface StrategyBarProps {
  strategy: StrategyResult
  onToggle: (id: string, active: boolean) => void
  onVolumeFactorChange: (id: string, factor: number) => void
  minimalProfitFactor: number
}

export function StrategyBar({ strategy, onToggle, onVolumeFactorChange, minimalProfitFactor }: StrategyBarProps) {
  const [expanded, setExpanded] = useState(false)
  const [volumeFactor, setVolumeFactor] = useState(strategy.volume_factor)

  const getStrategyIcon = (name: string) => {
    if (name.includes("Base")) return <Target className="h-4 w-4" />
    if (name.includes("Main")) return <Activity className="h-4 w-4" />
    if (name.includes("Real")) return <BarChart3 className="h-4 w-4" />
    if (name.includes("Block")) return <TrendingUp className="h-4 w-4" />
    if (name.includes("DCA")) return <TrendingDown className="h-4 w-4" />
    return <Activity className="h-4 w-4" />
  }

  const getStrategyColor = (name: string) => {
    if (name.includes("Base")) return "bg-blue-100 text-blue-800"
    if (name.includes("Main")) return "bg-green-100 text-green-800"
    if (name.includes("Real")) return "bg-purple-100 text-purple-800"
    if (name.includes("Block")) return "bg-orange-100 text-orange-800"
    if (name.includes("DCA")) return "bg-red-100 text-red-800"
    return "bg-gray-100 text-gray-800"
  }

  const getValidationColor = (state: string) => {
    switch (state) {
      case "valid":
        return "bg-green-100 text-green-800"
      case "invalid":
        return "bg-red-100 text-red-800"
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const isProfitable = strategy.avg_profit_factor >= minimalProfitFactor
  const barColor = isProfitable ? "bg-green-500" : "bg-gray-400"

  const handleVolumeChange = (value: number[]) => {
    const newFactor = value[0]
    setVolumeFactor(newFactor)
    onVolumeFactorChange(strategy.id, newFactor)
  }

  return (
    <div className="space-y-2">
      <Card
        className={cn(
          "transition-all duration-200 hover:shadow-md",
          strategy.isActive ? "border-primary shadow-sm" : "border-border",
          strategy.validation_state === "valid"
            ? "border-l-4 border-l-green-500"
            : strategy.validation_state === "invalid"
              ? "border-l-4 border-l-red-500"
              : "border-l-4 border-l-yellow-500",
        )}
      >
        <CardContent className="p-4 overflow-x-auto">
          <div className="flex flex-wrap items-center gap-3 min-w-max">
            <Switch checked={strategy.isActive} onCheckedChange={(checked) => onToggle(strategy.id, checked)} />

            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} className="p-1 shrink-0">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>

            <Badge className={`${getStrategyColor(strategy.name)} shrink-0`}>
              {getStrategyIcon(strategy.name)}
              <span className="ml-1">{strategy.name.split(" ")[0]}</span>
            </Badge>

            <Badge className={`${getValidationColor(strategy.validation_state)} shrink-0`}>
              {strategy.validation_state.toUpperCase()}
            </Badge>

            <div className="font-semibold text-sm flex-1 truncate max-w-[200px]">{strategy.name}</div>

            <div className="flex gap-2 shrink-0">
              <Badge variant="outline" className="text-xs">
                TP: {strategy.config.takeprofit_factor}
              </Badge>
              <Badge variant="outline" className="text-xs">
                SL: {strategy.config.stoploss_ratio.toFixed(1)}
              </Badge>
              {strategy.config.trailing_enabled && (
                <Badge variant="outline" className="text-xs bg-blue-50">
                  Trail
                </Badge>
              )}
            </div>

            <div className="w-32 space-y-1 shrink-0">
              <div className="flex justify-between text-xs">
                <span className="truncate">Avg R: {strategy.stats.total_trades > 0 ? strategy.avg_profit_factor.toFixed(3) : "—"}</span>
                <span className={`${isProfitable ? "text-green-600" : "text-gray-500"} ml-1`}>
                  {isProfitable ? "✓" : "✗"}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1">
                <div
                  className={`h-1 rounded-full ${barColor} transition-all duration-300`}
                  style={{ width: `${Math.min(Math.abs(strategy.avg_profit_factor) * 50, 100)}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-5 gap-2 text-xs shrink-0">
              <div className="text-center">
                <div className="font-medium">{strategy.stats.last_8_avg.toFixed(2)}</div>
                <div className="text-muted-foreground">L8</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{strategy.stats.last_20_avg.toFixed(2)}</div>
                <div className="text-muted-foreground">L20</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{strategy.stats.last_50_avg.toFixed(2)}</div>
                <div className="text-muted-foreground">L50</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{strategy.stats.positions_per_day.toFixed(0)}</div>
                <div className="text-muted-foreground">P/D</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{strategy.stats.drawdown_hours.toFixed(1)}h</div>
                <div className="text-muted-foreground">DD</div>
              </div>
            </div>

            <div className="w-24 shrink-0">
              <div className="text-xs text-center mb-1">Vol: {volumeFactor}</div>
              <Slider
                value={[volumeFactor]}
                onValueChange={handleVolumeChange}
                min={1}
                max={5}
                step={1}
                className="w-full"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {expanded && (
        <Card className="ml-8 border-l-4 border-l-primary/30">
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="font-medium">Take Profit</div>
                <div className="text-muted-foreground">{strategy.config.takeprofit_factor}x</div>
              </div>
              <div>
                <div className="font-medium">Stop Loss</div>
                <div className="text-muted-foreground">{strategy.config.stoploss_ratio.toFixed(1)}x</div>
              </div>
              <div>
                <div className="font-medium">Last Positions</div>
                <div className="text-muted-foreground">{strategy.config.last_positions_count}</div>
              </div>
              <div>
                <div className="font-medium">Win Rate</div>
                <div className="text-muted-foreground">{(strategy.stats.win_rate * 100).toFixed(1)}%</div>
              </div>
            </div>

            {strategy.config.trailing_enabled && (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="font-medium">Trail Start</div>
                  <div className="text-muted-foreground">{strategy.config.trail_start}x</div>
                </div>
                <div>
                  <div className="font-medium">Trail Stop</div>
                  <div className="text-muted-foreground">{strategy.config.trail_stop}x</div>
                </div>
                <div>
                  <div className="font-medium">Trail Step</div>
                  <div className="text-muted-foreground">0.3x</div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="font-medium text-sm">Performance Trend</div>
              <div className="flex items-end gap-1 h-16">
                {[
                  strategy.stats.last_50_avg,
                  strategy.stats.last_20_avg,
                  strategy.stats.last_8_avg,
                  strategy.avg_profit_factor,
                ].map((value, index) => (
                  <div
                    key={index}
                    className={cn(
                      "flex-1 rounded-t transition-all duration-300",
                      value >= 0 ? "bg-green-500" : "bg-red-500",
                    )}
                    style={{ height: `${Math.max(Math.abs(value) * 30, 4)}px` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>L50</span>
                <span>L20</span>
                <span>L8</span>
                <span>Current</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
