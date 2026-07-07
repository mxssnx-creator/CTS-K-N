"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, TrendingUp } from "lucide-react"

interface CompactTradingOverviewProps {
  stats?: {
    balance?: number
    equity?: number
    totalPnL?: number
    openPositions?: number
    margin?: number
    winRate?: number
  }
}

export function CompactTradingOverview({ stats = {} }: CompactTradingOverviewProps) {
  const formatCurrency = (amount: number = 0) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  const balance = stats.balance || 0
  const equity = stats.equity || 0
  const totalPnL = stats.totalPnL || 0
  const openPositions = stats.openPositions || 0

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* Account Health Box */}
      <Card className="hover:shadow-lg transition-shadow border-l-4 border-l-blue-500">
        <CardContent className="pt-3 pb-3 px-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-blue-600" />
                <span className="text-xs font-semibold text-foreground">Account Status</span>
              </div>
              <Badge className="text-xs bg-blue-500/15 text-blue-600 hover:bg-blue-500/15">Active</Badge>
            </div>
            <div className="space-y-1.5 pt-1">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-muted-foreground">Balance</span>
                <span className="text-base font-bold">{formatCurrency(balance)}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-muted-foreground">Equity</span>
                <span className="text-base font-semibold text-blue-600">{formatCurrency(equity)}</span>
              </div>
              <div className="flex justify-between items-baseline pt-1 border-t border-dashed">
                <span className="text-xs text-muted-foreground">P&L</span>
                <span className={`font-bold text-base ${totalPnL >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {totalPnL >= 0 ? "+" : ""}{formatCurrency(totalPnL)}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Trading Performance Box */}
      <Card className="hover:shadow-lg transition-shadow border-l-4 border-l-green-500">
        <CardContent className="pt-3 pb-3 px-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-600" />
                <span className="text-xs font-semibold text-foreground">Trading Performance</span>
              </div>
              <Badge className="text-xs bg-green-500/15 text-green-600 hover:bg-green-500/15">{openPositions} open</Badge>
            </div>
            <div className="space-y-1.5 pt-1">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-muted-foreground">Positions</span>
                <span className="text-base font-bold">{openPositions}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-muted-foreground">Win Rate</span>
                <span className="text-base font-semibold text-green-600">{(stats.winRate || 0).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-baseline pt-1 border-t border-dashed">
                <span className="text-xs text-muted-foreground">Margin Used</span>
                <span className="text-base font-semibold text-orange-600">{formatCurrency(stats.margin || 0)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
