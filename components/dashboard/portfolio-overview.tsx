"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrendingUp, TrendingDown, PieChart } from "lucide-react"

interface Portfolio {
  id: number
  name: string
  total_value: number
  initial_value: number
  open_positions: number
  daily_pnl: number
  total_return: number
}

interface PortfolioOverviewProps {
  portfolios: Portfolio[]
  onSelectPortfolio: (id: number) => void
}

export function PortfolioOverview({ portfolios, onSelectPortfolio }: PortfolioOverviewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Portfolios</h3>
        <Button size="sm">Create Portfolio</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {portfolios.map((portfolio) => {
          const returnPercent =
            portfolio.initial_value > 0
              ? ((portfolio.total_value - portfolio.initial_value) / portfolio.initial_value) * 100
              : 0
          const isProfit = returnPercent >= 0

          return (
            <Card
              key={portfolio.id}
              className="cursor-pointer hover:shadow-lg transition-shadow"
              onClick={() => onSelectPortfolio(portfolio.id)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{portfolio.name}</CardTitle>
                  <Badge variant={isProfit ? "default" : "destructive"}>
                    {isProfit ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                    {returnPercent.toFixed(2)}%
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Total Value</span>
                  <span className="text-lg font-bold">${portfolio.total_value.toFixed(2)}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Daily P&L</span>
                  <span
                    className={`text-sm font-semibold ${portfolio.daily_pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {portfolio.daily_pnl >= 0 ? "+" : ""}
                    {portfolio.daily_pnl.toFixed(2)}
                  </span>
                </div>

                <div className="flex items-center justify-between pt-2 border-t">
                  <div className="flex items-center gap-2">
                    <PieChart className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Open Positions</span>
                  </div>
                  <span className="text-sm font-medium">{portfolio.open_positions}</span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
