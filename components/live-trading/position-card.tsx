"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { TradingPosition } from "@/lib/trading"
import { TrendingUp, TrendingDown, Clock, DollarSign, X, Activity } from "lucide-react"
import { cn } from "@/lib/utils"

interface PositionCardProps {
  position: TradingPosition
  onClose?: (id: string) => void
  showCloseButton?: boolean
}

export function PositionCard({ position, onClose, showCloseButton = true }: PositionCardProps) {
  const isProfit = position.profit_loss > 0
  const profitPercentage = ((position.current_price - position.entry_price) / position.entry_price) * 100

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }

  return (
    <Card className={cn("transition-all duration-200", isProfit ? "border-green-200" : "border-red-200")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold">{position.symbol}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={position.status === "open" ? "default" : "secondary"}>
              {position.status.toUpperCase()}
            </Badge>
            {showCloseButton && position.status === "open" && onClose && (
              <Button variant="outline" size="sm" onClick={() => onClose(position.id)}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {position.strategy_type}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {position.position_side?.toUpperCase() || "LONG"}
          </Badge>
          {position.volume_factor && position.volume_factor !== 1 ? (
            <Badge variant="secondary" className="text-xs">
              Vol: {position.volume.toFixed(4)} ({position.volume_factor}x)
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              Vol: {position.volume.toFixed(4)}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Price Information */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-muted-foreground">Entry Price</div>
            <div className="font-semibold">{formatCurrency(position.entry_price)}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Current Price</div>
            <div className="font-semibold">{formatCurrency(position.current_price)}</div>
          </div>
        </div>

        {/* P&L Information */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">P&L</span>
            <div className="flex items-center gap-2">
              {isProfit ? (
                <TrendingUp className="h-4 w-4 text-green-500" />
              ) : (
                <TrendingDown className="h-4 w-4 text-red-500" />
              )}
              <span className={cn("font-semibold", isProfit ? "text-green-600" : "text-red-600")}>
                {formatCurrency(position.profit_loss)}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Percentage</span>
            <span className={cn("font-semibold", isProfit ? "text-green-600" : "text-red-600")}>
              {profitPercentage > 0 ? "+" : ""}
              {profitPercentage.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Progress Bar for P&L */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Max Loss: {formatCurrency(position.max_loss)}</span>
            <span>Max Profit: {formatCurrency(position.max_profit)}</span>
          </div>
          <Progress
            value={50 + profitPercentage} // Center at 50%
            className={cn("h-2", isProfit ? "bg-green-100" : "bg-red-100")}
          />
        </div>

        {/* Take Profit / Stop Loss */}
        {(position.takeprofit || position.stoploss) && (
          <div className="grid grid-cols-2 gap-4">
            {position.takeprofit && (
              <div>
                <div className="text-sm text-muted-foreground">Take Profit</div>
                <div className="font-semibold text-green-600">{formatCurrency(position.takeprofit)}</div>
              </div>
            )}
            {position.stoploss && (
              <div>
                <div className="text-sm text-muted-foreground">Stop Loss</div>
                <div className="font-semibold text-red-600">{formatCurrency(position.stoploss)}</div>
              </div>
            )}
          </div>
        )}

        {position.volume_factor && position.volume_factor !== 1 && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Volume Calculation</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Base</div>
                <div className="font-medium">{position.base_volume?.toFixed(4) || "N/A"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Factor</div>
                <div className="font-medium">{position.volume_factor}x</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Adjusted</div>
                <div className="font-medium">{position.adjusted_volume?.toFixed(4) || position.volume.toFixed(4)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Additional Information */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span>{formatTime(position.hold_time)}</span>
          </div>
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span>Fees: {formatCurrency(position.fees_paid)}</span>
          </div>
        </div>

        {/* Margin Information */}
        <div className="pt-2 border-t">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Margin Used</span>
            <span className="font-medium">{formatCurrency(position.margin_used)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
