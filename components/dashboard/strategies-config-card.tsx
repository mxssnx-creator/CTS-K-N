"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  GitBranch,
  RotateCcw,
  Eye,
  EyeOff,
  TrendingUp,
  Target,
  Zap,
  BarChart3,
} from "lucide-react"

interface Strategy {
  id: string
  name: string
  enabled: boolean
  category: "base" | "main" | "preset" | "advanced"
  parameters: Record<string, any>
  performance?: {
    winRate: number
    avgReturn: number
    maxDrawdown: number
  }
}

interface StrategiesConfigCardProps {
  strategies: Strategy[]
  onToggleStrategy?: (id: string) => void
  onUpdateParameters?: (id: string, parameters: Record<string, any>) => void
  onResetStrategy?: (id: string) => void
}

const STRATEGY_TYPES = {
  base: {
    label: "Base Strategies",
    icon: GitBranch,
    color: "text-blue-500",
    items: [
      {
        id: "trailing",
        name: "Trailing Strategy",
        shortName: "Trail",
        params: [
          { name: "Trail Distance", type: "slider", min: 0.1, max: 5, unit: "%" },
          { name: "Trail Timeout", type: "slider", min: 1, max: 60, unit: "min" },
        ],
      },
      {
        id: "block",
        name: "Block Strategy",
        shortName: "Block",
        params: [
          { name: "Block Size", type: "slider", min: 1, max: 50, unit: "%" },
          { name: "Block Duration", type: "slider", min: 1, max: 120, unit: "min" },
        ],
      },
      {
        id: "dca",
        name: "DCA Strategy",
        shortName: "DCA",
        params: [
          { name: "DCA Interval", type: "slider", min: 1, max: 60, unit: "min" },
          { name: "Max Purchases", type: "slider", min: 2, max: 20, unit: "" },
        ],
      },
    ],
  },
  main: {
    label: "Main Trade Strategies",
    icon: Target,
    color: "text-green-500",
    items: [
      {
        id: "momentum",
        name: "Momentum Strategy",
        shortName: "Mom",
        params: [
          { name: "Threshold", type: "slider", min: 0.1, max: 10, unit: "%" },
          { name: "Confirmation Count", type: "slider", min: 1, max: 5, unit: "" },
        ],
      },
      {
        id: "reversal",
        name: "Reversal Strategy",
        shortName: "Rev",
        params: [
          { name: "Pattern Detection", type: "text" },
          { name: "Reversal %", type: "slider", min: 0.5, max: 5, unit: "%" },
        ],
      },
      {
        id: "support_resistance",
        name: "Support/Resistance",
        shortName: "S/R",
        params: [
          { name: "Level Calculation", type: "text" },
          { name: "Break Confirmation", type: "slider", min: 1, max: 5, unit: "%" },
        ],
      },
      {
        id: "trend_following",
        name: "Trend Following",
        shortName: "Trend",
        params: [
          { name: "Trend Definition", type: "text" },
          { name: "Entry Criteria", type: "text" },
        ],
      },
    ],
  },
  preset: {
    label: "Preset Trade Strategies",
    icon: Zap,
    color: "text-orange-500",
    items: [
      {
        id: "auto_optimal",
        name: "Auto-Optimal",
        shortName: "Auto",
        params: [
          { name: "Optimization Method", type: "text" },
          { name: "Performance Threshold", type: "slider", min: 50, max: 100, unit: "%" },
        ],
      },
      {
        id: "coordination",
        name: "Coordination Strategy",
        shortName: "Coord",
        params: [
          { name: "Multi-Symbol Handling", type: "text" },
          { name: "Sync Interval", type: "slider", min: 1, max: 60, unit: "sec" },
        ],
      },
      {
        id: "risk_adjusted",
        name: "Risk-Adjusted",
        shortName: "Risk",
        params: [
          { name: "Stop-Loss %", type: "slider", min: 0.5, max: 10, unit: "%" },
          { name: "Take-Profit %", type: "slider", min: 1, max: 20, unit: "%" },
        ],
      },
      {
        id: "portfolio",
        name: "Portfolio Strategy",
        shortName: "Port",
        params: [
          { name: "Rebalancing Period", type: "text" },
          { name: "Allocation Rules", type: "text" },
        ],
      },
    ],
  },
  advanced: {
    label: "Advanced Strategies",
    icon: BarChart3,
    color: "text-red-500",
    items: [
      {
        id: "hedge",
        name: "Hedging Strategy",
        shortName: "Hedge",
        params: [
          { name: "Hedge Ratio", type: "slider", min: 0.1, max: 1, unit: "" },
          { name: "Hedge Duration", type: "slider", min: 1, max: 120, unit: "min" },
        ],
      },
      {
        id: "arbitrage",
        name: "Arbitrage Detection",
        shortName: "Arb",
        params: [
          { name: "Price Difference Threshold", type: "slider", min: 0.1, max: 5, unit: "%" },
        ],
      },
    ],
  },
}

export function StrategiesConfigCard({
  strategies = [],
  onToggleStrategy,
  onUpdateParameters,
  onResetStrategy,
}: StrategiesConfigCardProps) {
  const [expandedStrategyId, setExpandedStrategyId] = useState<string | null>(null)

  const renderStrategyItem = (
    categoryKey: string,
    item: any,
    strategy?: Strategy
  ) => {
    const isExpanded = expandedStrategyId === item.id
    const isEnabled = strategy?.enabled ?? true

    return (
      <div
        key={item.id}
        className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3 flex-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => onToggleStrategy?.(item.id)}
            >
              {isEnabled ? (
                <Eye className="h-4 w-4 text-green-600" />
              ) : (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
            <div>
              <p className="text-sm font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">{item.shortName}</p>
            </div>
          </div>
          {strategy?.performance && (
            <div className="flex gap-2">
              <Badge variant="secondary" className="text-xs">
                {strategy.performance.winRate}%
              </Badge>
              <Badge
                variant="secondary"
                className={`text-xs ${strategy.performance.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}
              >
                {strategy.performance.avgReturn >= 0 ? "+" : ""}{strategy.performance.avgReturn.toFixed(2)}%
              </Badge>
            </div>
          )}
        </div>

        {/* Expandable Content */}
        {isExpanded && (
          <div className="mt-3 space-y-3 border-t pt-3">
            <div className="space-y-2">
              <Label className="text-xs font-medium">Parameters</Label>
              {item.params.map((param: any, idx: number) => (
                <div key={param.name} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{param.name}</span>
                  </div>
                  {param.type === "slider" ? (
                    <div className="flex items-center gap-2">
                      <Slider
                        value={[strategy?.parameters?.[param.name.toLowerCase()] || param.min]}
                        onValueChange={(value) => {
                          const params = {
                            ...strategy?.parameters,
                            [param.name.toLowerCase()]: value[0],
                          }
                          onUpdateParameters?.(item.id, params)
                        }}
                        min={param.min}
                        max={param.max}
                        step={0.1}
                        className="flex-1"
                      />
                      <span className="text-xs font-medium w-12 text-right">
                        {strategy?.parameters?.[param.name.toLowerCase()] || param.min}
                        {param.unit}
                      </span>
                    </div>
                  ) : (
                    <Input
                      type="text"
                      placeholder="Value"
                      className="h-7 text-xs"
                      defaultValue={strategy?.parameters?.[param.name.toLowerCase()] || ""}
                      onChange={(e) => {
                        const params = {
                          ...strategy?.parameters,
                          [param.name.toLowerCase()]: e.target.value,
                        }
                        onUpdateParameters?.(item.id, params)
                      }}
                    />
                  )}
                </div>
              ))}
            </div>

            {strategy?.performance && (
              <>
                <Separator />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Max Drawdown: {strategy.performance.maxDrawdown.toFixed(2)}%</p>
                  <p>Backtest Score: {(strategy.performance.winRate * 0.4 + (strategy.performance.avgReturn + 100) * 0.6).toFixed(1)} pts</p>
                </div>
              </>
            )}

            <Separator />

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs flex-1"
                onClick={() => onResetStrategy?.(item.id)}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset
              </Button>
              <Button
                size="sm"
                className="text-xs flex-1"
                onClick={() => setExpandedStrategyId(null)}
              >
                Save
              </Button>
            </div>
          </div>
        )}

        {/* Expand Button */}
        {!isExpanded && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground hover:text-foreground mt-2"
            onClick={() => setExpandedStrategyId(item.id)}
          >
            Configure
          </Button>
        )}
      </div>
    )
  }

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-blue-500" />
          Strategies Configuration
        </CardTitle>
        <CardDescription>
          Configure trading strategies and algorithms
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="base" className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-4">
            <TabsTrigger value="base" className="text-xs">
              Base
            </TabsTrigger>
            <TabsTrigger value="main" className="text-xs">
              Main Trade
            </TabsTrigger>
            <TabsTrigger value="preset" className="text-xs">
              Preset Trade
            </TabsTrigger>
            <TabsTrigger value="advanced" className="text-xs">
              Advanced
            </TabsTrigger>
          </TabsList>

          {Object.entries(STRATEGY_TYPES).map(([categoryKey, category]: [string, any]) => (
            <TabsContent key={categoryKey} value={categoryKey} className="space-y-3 mt-4">
              <p className="text-xs text-muted-foreground mb-3">
                {category.label} - Configure strategy parameters and thresholds
              </p>
              {category.items.map((item: any) => {
                const strategy = strategies.find((strat) => strat.id === item.id)
                return renderStrategyItem(categoryKey, item, strategy)
              })}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
