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
  BarChart3,
  RotateCcw,
  Eye,
  EyeOff,
  TrendingUp,
  Activity,
  Zap,
} from "lucide-react"

interface Indication {
  id: string
  name: string
  enabled: boolean
  category: "direction" | "movement" | "active" | "optimal" | "advanced"
  parameters: Record<string, any>
  performance?: {
    winRate: number
    lastSignal: string
  }
}

interface IndicationsConfigCardProps {
  indications: Indication[]
  onToggleIndication?: (id: string) => void
  onUpdateParameters?: (id: string, parameters: Record<string, any>) => void
  onResetIndication?: (id: string) => void
}

const INDICATION_TYPES = {
  direction: {
    label: "Direction Indications",
    icon: TrendingUp,
    color: "text-blue-500",
    items: [
      { id: "rsi", name: "RSI", shortName: "RSI", params: ["Threshold", "Period"] },
      { id: "macd", name: "MACD", shortName: "MACD", params: ["Signal Line", "Fast Period", "Slow Period"] },
      { id: "stochastic", name: "Stochastic", shortName: "STOCH", params: ["K%", "D%", "Threshold"] },
      { id: "adx", name: "ADX", shortName: "ADX", params: ["Strength Threshold", "Period"] },
    ],
  },
  movement: {
    label: "Movement Indications",
    icon: Activity,
    color: "text-green-500",
    items: [
      { id: "atr", name: "ATR", shortName: "ATR", params: ["Period", "Multiplier"] },
      { id: "bb", name: "Bollinger Bands", shortName: "BB", params: ["Period", "Std Dev", "Band Use"] },
      { id: "kc", name: "Keltner Channels", shortName: "KC", params: ["Period", "Offset Multiplier"] },
      { id: "vp", name: "Volume Profile", shortName: "VP", params: ["Price Levels"] },
    ],
  },
  active: {
    label: "Active (Custom) Indications",
    icon: Zap,
    color: "text-orange-500",
    items: [
      { id: "custom1", name: "Custom Indicator 1", shortName: "Custom", params: ["Loading Logic", "Parameters"] },
      { id: "webhook", name: "Webhook Indicator", shortName: "Webhook", params: ["URL", "Timeout"] },
      { id: "ml", name: "ML Model Indicator", shortName: "ML", params: ["Model Version", "Threshold"] },
    ],
  },
  optimal: {
    label: "Optimal Indicators",
    icon: BarChart3,
    color: "text-purple-500",
    items: [
      { id: "auto_opt", name: "Auto-Tuned", shortName: "Auto", params: ["Optimization Method"] },
      { id: "perf_based", name: "Performance-Based", shortName: "Perf", params: ["Lookback Period"] },
      { id: "backtest", name: "Backtest Results", shortName: "BT", params: ["Test Period"] },
    ],
  },
  advanced: {
    label: "Advanced Analysis",
    icon: Activity,
    color: "text-red-500",
    items: [
      { id: "multi_tf", name: "Multi-Timeframe", shortName: "Multi-TF", params: ["Timeframes", "Correlation Threshold"] },
      { id: "correlation", name: "Correlation Matrix", shortName: "Corr", params: ["Symbol Set", "Period"] },
      { id: "filter", name: "Advanced Filtering", shortName: "Filter", params: ["Filter Type", "Parameters"] },
    ],
  },
}

export function IndicationsConfigCard({
  indications = [],
  onToggleIndication,
  onUpdateParameters,
  onResetIndication,
}: IndicationsConfigCardProps) {
  const [expandedIndicationId, setExpandedIndicationId] = useState<string | null>(null)

  const renderIndicationItem = (
    category: string,
    item: any,
    indication?: Indication
  ) => {
    const isExpanded = expandedIndicationId === item.id
    const isEnabled = indication?.enabled ?? true

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
              onClick={() => onToggleIndication?.(item.id)}
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
          {indication?.performance && (
            <Badge variant="secondary" className="text-xs">
              {indication.performance.winRate}% win rate
            </Badge>
          )}
        </div>

        {/* Expandable Content */}
        {isExpanded && (
          <div className="mt-3 space-y-3 border-t pt-3">
            <div className="space-y-2">
              <Label className="text-xs font-medium">Parameters</Label>
              {item.params.map((param: string, idx: number) => (
                <div key={param} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{param}</span>
                    <Input
                      type="text"
                      placeholder="Value"
                      className="h-7 text-xs w-24"
                      defaultValue={indication?.parameters?.[param.toLowerCase()] || ""}
                      onChange={(e) => {
                        const params = {
                          ...indication?.parameters,
                          [param.toLowerCase()]: e.target.value,
                        }
                        onUpdateParameters?.(item.id, params)
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <Separator />

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs flex-1"
                onClick={() => onResetIndication?.(item.id)}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset
              </Button>
              <Button
                size="sm"
                className="text-xs flex-1"
                onClick={() => setExpandedIndicationId(null)}
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
            onClick={() => setExpandedIndicationId(item.id)}
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
          <BarChart3 className="h-5 w-5 text-blue-500" />
          Indications Configuration
        </CardTitle>
        <CardDescription>
          Configure technical indicators and analysis tools
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="direction" className="w-full">
          <TabsList className="grid w-full grid-cols-5 mb-4">
            <TabsTrigger value="direction" className="text-xs">
              Direction
            </TabsTrigger>
            <TabsTrigger value="movement" className="text-xs">
              Movement
            </TabsTrigger>
            <TabsTrigger value="active" className="text-xs">
              Active
            </TabsTrigger>
            <TabsTrigger value="optimal" className="text-xs">
              Optimal
            </TabsTrigger>
            <TabsTrigger value="advanced" className="text-xs">
              Advanced
            </TabsTrigger>
          </TabsList>

          {Object.entries(INDICATION_TYPES).map(([categoryKey, category]: [string, any]) => (
            <TabsContent key={categoryKey} value={categoryKey} className="space-y-3 mt-4">
              <p className="text-xs text-muted-foreground mb-3">
                {category.label} - Configure parameters and thresholds for each indicator
              </p>
              {category.items.map((item: any) => {
                const indication = indications.find((ind) => ind.id === item.id)
                return renderIndicationItem(categoryKey, item, indication)
              })}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
