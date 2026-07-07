"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Activity } from "lucide-react"
import { cn } from "@/lib/utils"

interface IndicationBarProps {
  indication: {
    id: string
    type: "direction" | "move" | "active"
    symbol: string
    range: number
    isActive: boolean
    profitFactor: number
    stats: {
      last8Avg: number
      last20Avg: number
      last50Avg: number
      positionsPerDay: number
      drawdownHours: number
    }
    subConfigurations?: any[]
  }
  onToggle: (id: string, active: boolean) => void
  minimalProfitFactor: number
}

export function IndicationBar({ indication, onToggle, minimalProfitFactor }: IndicationBarProps) {
  const [expanded, setExpanded] = useState(false)

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "direction":
        return <TrendingUp className="h-4 w-4" />
      case "move":
        return <Activity className="h-4 w-4" />
      case "active":
        return <TrendingDown className="h-4 w-4" />
      default:
        return <Activity className="h-4 w-4" />
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case "direction":
        return "bg-blue-100 text-blue-800"
      case "move":
        return "bg-green-100 text-green-800"
      case "active":
        return "bg-orange-100 text-orange-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const isProfitable = indication.profitFactor >= minimalProfitFactor
  const barColor = isProfitable ? "bg-green-500" : "bg-gray-400"

  return (
    <div className="space-y-2">
      <Card
        className={cn(
          "transition-all duration-200 hover:shadow-md",
          indication.isActive ? "border-primary shadow-sm" : "border-border",
        )}
      >
        <CardContent className="p-4 overflow-x-auto">
          <div className="flex flex-wrap items-center gap-3 min-w-max">
            <Switch checked={indication.isActive} onCheckedChange={(checked) => onToggle(indication.id, checked)} />

            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} className="p-1 shrink-0">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>

            <Badge className={getTypeColor(indication.type)}>
              {getTypeIcon(indication.type)}
              <span className="ml-1 capitalize">{indication.type}</span>
            </Badge>

            <div className="font-semibold text-lg truncate max-w-[120px]">{indication.symbol}</div>

            <Badge variant="outline" className="shrink-0">
              Range: {indication.range}
            </Badge>

            <div className="flex-1 space-y-1 min-w-[200px]">
              <div className="flex justify-between text-sm">
                <span className="truncate">Avg R: {indication.profitFactor.toFixed(3)}</span>
                <span className={`${isProfitable ? "text-green-600" : "text-gray-500"} shrink-0 ml-2`}>
                  {isProfitable ? "Profitable" : "Below Threshold"}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${barColor} transition-all duration-300`}
                  style={{ width: `${Math.min(Math.abs(indication.profitFactor) * 100, 100)}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-5 gap-3 text-sm shrink-0">
              <div className="text-center">
                <div className="font-medium">{indication.stats.last8Avg.toFixed(2)}</div>
                <div className="text-muted-foreground text-xs">Last 8</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{indication.stats.last20Avg.toFixed(2)}</div>
                <div className="text-muted-foreground text-xs">Last 20</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{indication.stats.last50Avg.toFixed(2)}</div>
                <div className="text-muted-foreground text-xs">Last 50</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{indication.stats.positionsPerDay}</div>
                <div className="text-muted-foreground text-xs">Pos/Day</div>
              </div>
              <div className="text-center">
                <div className="font-medium">{indication.stats.drawdownHours}h</div>
                <div className="text-muted-foreground text-xs">Drawdown</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {expanded && indication.subConfigurations && (
        <div className="ml-8 space-y-2">
          {indication.subConfigurations.map((subConfig, index) => (
            <Card key={index} className="border-l-4 border-l-primary/30">
              <CardContent className="p-3 overflow-x-auto">
                <div className="flex flex-wrap items-center gap-3 text-sm min-w-max">
                  <Switch
                    checked={subConfig.isActive}
                    onCheckedChange={(checked) => onToggle(subConfig.id, checked)}
                    className="scale-90"
                  />

                  <Badge variant="outline" className="text-xs shrink-0">
                    TP: {subConfig.takeProfitFactor}
                  </Badge>

                  <Badge variant="outline" className="text-xs shrink-0">
                    SL: {subConfig.stopLossRatio}
                  </Badge>

                  {subConfig.trailingEnabled && (
                    <Badge variant="outline" className="text-xs bg-blue-50 shrink-0">
                      Trailing
                    </Badge>
                  )}

                  <div className="flex-1 min-w-[150px]">
                    <Progress value={Math.min(Math.abs(subConfig.profitFactor) * 100, 100)} className="h-1" />
                  </div>

                  <div className="text-right shrink-0">
                    <div className="font-medium">{subConfig.profitFactor.toFixed(3)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
