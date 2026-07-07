"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Zap } from "lucide-react"

interface StrategyData {
  name: string
  type: "base" | "main" | "real" | "live"
  exchange: string
  active: boolean
  positions: number
  winRate: number
  profit: number
  drawdown: number
}

interface StrategiesOverviewProps {
  strategies: StrategyData[]
}

export function StrategiesOverview({ strategies }: StrategiesOverviewProps) {
  const getTypeColor = (type: string) => {
    switch (type) {
      case "base":
        return "bg-blue-500"
      case "main":
        return "bg-purple-500"
      case "real":
        return "bg-orange-500"
      case "live":
        return "bg-green-500"
      default:
        return "bg-gray-500"
    }
  }

  const getTypeBadge = (type: string) => {
    switch (type) {
      case "base":
        return "default"
      case "main":
        return "secondary"
      case "real":
        return "outline"
      case "live":
        return "default"
      default:
        return "outline"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4" />
          Strategies
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1">
          {strategies.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              No active strategies. Enable connections to start.
            </p>
          ) : (
            strategies.map((strategy, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div
                    className={`h-2 w-2 rounded-full ${getTypeColor(strategy.type)} ${strategy.active ? "animate-pulse" : ""}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0">
                      <span className="font-medium text-xs truncate">{strategy.name}</span>
                      <Badge variant={getTypeBadge(strategy.type)} className="text-xs px-1 py-0 h-4">
                        {strategy.type.charAt(0).toUpperCase()}
                      </Badge>
                      <Badge variant="outline" className="text-xs px-1 py-0 h-4">
                        {strategy.exchange}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>P:{strategy.positions}</span>
                      <span>W:{strategy.winRate}%</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="text-right">
                    <div
                      className={`text-xs font-semibold ${strategy.profit >= 0 ? "text-green-600" : "text-red-600"}`}
                    >
                      {strategy.profit >= 0 ? "+" : ""}
                      {strategy.profit.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground">DD:{strategy.drawdown.toFixed(0)}%</div>
                  </div>
                  {strategy.profit >= 0 ? (
                    <TrendingUp className="h-3 w-3 text-green-600" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-600" />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
