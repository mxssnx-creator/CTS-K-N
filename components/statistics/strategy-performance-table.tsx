"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowUpDown, ArrowUp, ArrowDown, BarChart3 } from "lucide-react"
import type { StrategyAnalytics } from "@/lib/analytics"
import { formatSampledMetric, grossProfitFactorTitle } from "@/lib/metric-formatting"

interface StrategyPerformanceTableProps {
  strategies: StrategyAnalytics[]
  onStrategyClick?: (strategy: StrategyAnalytics) => void
}

type SortField = keyof StrategyAnalytics
type SortDirection = "asc" | "desc"

export function StrategyPerformanceTable({ strategies, onStrategyClick }: StrategyPerformanceTableProps) {
  const [sortField, setSortField] = useState<SortField>("profit_factor")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDirection("desc")
    }
  }

  const sortedStrategies = [...strategies].sort((a, b) => {
    const aValue = a[sortField]
    const bValue = b[sortField]

    if (typeof aValue === "number" && typeof bValue === "number") {
      return sortDirection === "asc" ? aValue - bValue : bValue - aValue
    }

    if (typeof aValue === "string" && typeof bValue === "string") {
      return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue)
    }

    return 0
  })

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${Math.floor(minutes)}m`
    const hours = Math.floor(minutes / 60)
    const mins = Math.floor(minutes % 60)
    return `${hours}h ${mins}m`
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4" />
    return sortDirection === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Strategy Performance Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("strategy_name")}
                    className="h-auto p-0 font-semibold"
                  >
                    Strategy Name
                    <SortIcon field="strategy_name" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("profit_factor")}
                    className="h-auto p-0 font-semibold"
                  >
                    PF
                    <SortIcon field="profit_factor" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("profit_factor_last_50")}
                    className="h-auto p-0 font-semibold"
                  >
                    PF (Last 50)
                    <SortIcon field="profit_factor_last_50" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("trades_per_day")}
                    className="h-auto p-0 font-semibold"
                  >
                    Trades/Day
                    <SortIcon field="trades_per_day" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("drawdown_time")}
                    className="h-auto p-0 font-semibold"
                  >
                    Drawdown
                    <SortIcon field="drawdown_time" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("takeprofit_factor")}
                    className="h-auto p-0 font-semibold"
                  >
                    TP Factor
                    <SortIcon field="takeprofit_factor" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("tp_sl_ratio")}
                    className="h-auto p-0 font-semibold"
                  >
                    TP/SL Ratio
                    <SortIcon field="tp_sl_ratio" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("average_hold_time")}
                    className="h-auto p-0 font-semibold"
                  >
                    Avg Hold
                    <SortIcon field="average_hold_time" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("volume_factor")}
                    className="h-auto p-0 font-semibold"
                  >
                    Volume
                    <SortIcon field="volume_factor" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button variant="ghost" onClick={() => handleSort("total_pnl")} className="h-auto p-0 font-semibold">
                    Total P&L
                    <SortIcon field="total_pnl" />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStrategies.map((strategy, index) => (
                <TableRow
                  key={index}
                  className={`cursor-pointer hover:bg-muted/50 ${onStrategyClick ? "cursor-pointer" : ""}`}
                  onClick={() => onStrategyClick?.(strategy)}
                >
                  <TableCell className="font-medium">
                    <div className="space-y-1">
                      <div>{strategy.strategy_name}</div>
                      <div className="flex gap-1">
                        <Badge variant="outline" className="text-xs">
                          {strategy.strategy_type}
                        </Badge>
                        {strategy.trailing_info.enabled && (
                          <Badge variant="outline" className="text-xs bg-blue-50">
                            Trail
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      title={grossProfitFactorTitle(strategy.profit_factor, strategy.total_trades)}
                      className={`font-semibold ${
                        strategy.profit_factor >= 1.2
                          ? "text-green-600"
                          : strategy.profit_factor >= 0.8
                            ? "text-yellow-600"
                            : "text-red-600"
                      }`}
                    >
                      {formatSampledMetric(strategy.profit_factor, strategy.total_trades)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      title={grossProfitFactorTitle(strategy.profit_factor_last_50, Math.min(strategy.total_trades, 50))}
                      className={`font-semibold ${
                        strategy.profit_factor_last_50 >= 1.2
                          ? "text-green-600"
                          : strategy.profit_factor_last_50 >= 0.8
                            ? "text-yellow-600"
                            : "text-red-600"
                      }`}
                    >
                      {formatSampledMetric(strategy.profit_factor_last_50, Math.min(strategy.total_trades, 50))}
                    </span>
                  </TableCell>
                  <TableCell>{strategy.trades_per_day.toFixed(1)}</TableCell>
                  <TableCell>{strategy.drawdown_time.toFixed(1)}h</TableCell>
                  <TableCell>{strategy.takeprofit_factor.toFixed(2)}x</TableCell>
                  <TableCell>{strategy.tp_sl_ratio.toFixed(1)}:1</TableCell>
                  <TableCell>{formatTime(strategy.average_hold_time)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{strategy.volume_factor}x</Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`font-semibold ${strategy.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatCurrency(strategy.total_pnl)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {sortedStrategies.length === 0 && (
          <div className="text-center py-8">
            <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Strategy Data</h3>
            <p className="text-muted-foreground">No strategies match the current filter criteria.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
