"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { SymbolAnalysis } from "@/lib/position-calculator"

interface PositionBreakdownProps {
  analysis: SymbolAnalysis
}

export function PositionBreakdown({ analysis }: PositionBreakdownProps) {
  const getProgressColor = (category: string) => {
    switch (category) {
      case "Indications":
        return "bg-blue-500"
      case "Strategies":
        return "bg-green-500"
      case "Active Trading":
        return "bg-orange-500"
      default:
        return "bg-gray-500"
    }
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Configurations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{formatNumber(analysis.total_configurations)}</div>
            <p className="text-xs text-muted-foreground">Unique parameter combinations</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{formatNumber(analysis.total_actual_positions)}</div>
            <p className="text-xs text-muted-foreground">Unlimited generation per config</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">DB Entries/Min</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">
              {formatNumber(analysis.summary.database_entries_per_minute)}
            </div>
            <p className="text-xs text-muted-foreground">Real-time updates</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Storage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {analysis.summary.storage_requirements_mb.toFixed(1)} MB
            </div>
            <p className="text-xs text-muted-foreground">Per symbol data</p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Position Generation Breakdown for {analysis.symbol}</CardTitle>
          <CardDescription>
            Position limits are independent per config AND per direction (LONG/SHORT) - unlimited generation of
            TP/SL/trailing combinations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {analysis.categories.map((category, index) => (
              <div key={index} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={getProgressColor(category.category)}>
                      {category.category}
                    </Badge>
                    <h4 className="font-semibold">{category.subcategory}</h4>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-lg">{formatNumber(category.total_positions)}</div>
                    <div className="text-sm text-muted-foreground">positions</div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Configurations:</span>
                    <div className="font-semibold">{formatNumber(category.configurations)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Limit per config:</span>
                    <div className="font-semibold">{category.limit_applied}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total positions:</span>
                    <div className="font-semibold">{formatNumber(category.total_positions)}</div>
                  </div>
                </div>

                <div className="text-sm text-muted-foreground bg-muted p-3 rounded">
                  <strong>Configuration details:</strong> {category.description}
                </div>

                <Progress value={(category.total_positions / analysis.total_actual_positions) * 100} className="h-2" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Key Insights */}
      <Card>
        <CardHeader>
          <CardTitle>Key Insights</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <h5 className="font-semibold text-blue-600">Position Limits</h5>
              <ul className="space-y-1 text-muted-foreground">
                <li>• Unlimited TP/SL/trailing combinations generated</li>
                <li>• Position limits apply per config AND per direction</li>
                <li>• LONG and SHORT positions counted independently</li>
                <li>• Each config can have maxPositionsPerConfig LONG + maxPositionsPerConfig SHORT</li>
              </ul>
            </div>
            <div className="space-y-2">
              <h5 className="font-semibold text-green-600">Scalability</h5>
              <ul className="space-y-1 text-muted-foreground">
                <li>• Multiply by number of symbols traded</li>
                <li>• Each symbol operates independently</li>
                <li>• Continuous real-time calculations</li>
                <li>• Automatic position management</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
