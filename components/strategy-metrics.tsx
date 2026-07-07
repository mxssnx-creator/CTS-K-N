"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Layers, TrendingUp, Clock, AlertTriangle } from "lucide-react"

interface StrategyMetricsProps {
  stages: {
    stage: string
    setsCount: number
    evaluated: number
    passed: number
    failed: number
    passRate: number
    avgProfitFactor: number
    avgDrawdownTime: number
  }[]
  totalEvaluated: number
  overallPassRate: number
  avgProfitFactor: number
  avgDrawdownTime: number
}

export function StrategyMetrics({ stages, totalEvaluated, overallPassRate, avgProfitFactor, avgDrawdownTime }: StrategyMetricsProps) {
  const getStageColor = (stage: string) => {
    switch (stage) {
      case "base": return "bg-blue-500"
      case "main": return "bg-purple-500"
      case "real": return "bg-green-500"
      default: return "bg-gray-500"
    }
  }

  const getStageIcon = (stage: string) => {
    switch (stage) {
      case "base": return "🔵"
      case "main": return "🟣"
      case "real": return "🟢"
      default: return "⚪"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Layers className="h-4 w-4" />
          Strategy Metrics
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Overall Summary */}
        <div className="grid grid-cols-4 gap-2 mb-4 text-xs">
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Total</div>
            <div className="font-bold text-lg">{totalEvaluated}</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Pass Rate</div>
            <div className="font-bold text-lg text-green-600">{Math.round(overallPassRate)}%</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Avg R</div>
            <div className="font-bold text-lg">{totalEvaluated > 0 ? avgProfitFactor.toFixed(2) : "—"}</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Avg DDT</div>
            <div className="font-bold text-lg">{Math.round(avgDrawdownTime)}m</div>
          </div>
        </div>

        {/* Stage Breakdown */}
        <div className="space-y-3">
          {stages.map((stage) => (
            <div key={stage.stage} className="border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{getStageIcon(stage.stage)}</span>
                  <span className="font-medium text-sm uppercase">{stage.stage}</span>
                  <Badge variant="secondary" className="text-xs">
                    {stage.setsCount} sets
                  </Badge>
                </div>
                <Badge variant={stage.passRate >= 70 ? "default" : stage.passRate <= 30 ? "destructive" : "secondary"}>
                  {Math.round(stage.passRate)}%
                </Badge>
              </div>

              <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground block">Evaluated</span>
                  <span className="font-medium">{stage.evaluated}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Passed</span>
                  <span className="font-medium text-green-600">{stage.passed}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Avg R</span>
                  <span className="font-medium">{stage.evaluated > 0 ? stage.avgProfitFactor.toFixed(2) : "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Drawdown Time</span>
                  <span className="font-medium">{Math.round(stage.avgDrawdownTime)}m</span>
                </div>
              </div>

              <Progress value={stage.passRate} className="h-1 mt-2" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
