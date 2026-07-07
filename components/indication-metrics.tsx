"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { TrendingUp, TrendingDown, Minus, BarChart3, Clock, AlertTriangle } from "lucide-react"

interface IndicationMetricsProps {
  connectionId: string
  metrics: {
    type: string
    evaluations: number
    passed: number
    passRate: number
    avgConfidence: number
    avgStrength: number
  }[]
  totalEvaluations: number
  overallPassRate: number
}

export function IndicationMetrics({ metrics, totalEvaluations, overallPassRate }: IndicationMetricsProps) {
  const getSignalIcon = (passRate: number) => {
    if (passRate >= 70) return <TrendingUp className="h-4 w-4 text-green-500" />
    if (passRate <= 30) return <TrendingDown className="h-4 w-4 text-red-500" />
    return <Minus className="h-4 w-4 text-yellow-500" />
  }

  const getPassRateColor = (passRate: number) => {
    if (passRate >= 70) return "text-green-600"
    if (passRate <= 30) return "text-red-600"
    return "text-yellow-600"
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Indication Metrics
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Overall Summary */}
        <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Total</div>
            <div className="font-bold text-lg">{totalEvaluations}</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Pass Rate</div>
            <div className={`font-bold text-lg ${getPassRateColor(overallPassRate)}`}>
              {Math.round(overallPassRate)}%
            </div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-muted-foreground">Types</div>
            <div className="font-bold text-lg">{metrics.length}</div>
          </div>
        </div>

        {/* Type Breakdown */}
        <div className="space-y-2">
          {metrics.map((m) => (
            <div key={m.type} className="border rounded-lg p-2">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {getSignalIcon(m.passRate)}
                  <span className="font-medium text-sm uppercase">{m.type}</span>
                </div>
                <Badge variant={m.passRate >= 70 ? "default" : m.passRate <= 30 ? "destructive" : "secondary"}>
                  {Math.round(m.passRate)}%
                </Badge>
              </div>
              
              <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
                <div>
                  <span className="block">Evaluations</span>
                  <span className="font-medium text-foreground">{m.evaluations}</span>
                </div>
                <div>
                  <span className="block">Passed</span>
                  <span className="font-medium text-green-600">{m.passed}</span>
                </div>
                <div>
                  <span className="block">Confidence</span>
                  <span className="font-medium">{(m.avgConfidence * 100).toFixed(1)}%</span>
                </div>
                <div>
                  <span className="block">Strength</span>
                  <span className="font-medium">{(m.avgStrength * 100).toFixed(1)}%</span>
                </div>
              </div>

              <Progress value={m.passRate} className="h-1 mt-2" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
