"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { X } from "lucide-react"

interface Position {
  id: number
  symbol: string
  position_type: "long" | "short"
  entry_price: number
  current_price: number
  quantity: number
  leverage: number
  unrealized_pnl: number
  stop_loss?: number
  take_profit?: number
  opened_at: string
}

interface PositionsTableProps {
  positions: Position[]
  onClosePosition: (id: number) => void
}

export function PositionsTable({ positions, onClosePosition }: PositionsTableProps) {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString()
  }

  const calculatePnLPercent = (position: Position) => {
    const priceDiff = position.current_price - position.entry_price
    return (priceDiff / position.entry_price) * 100 * (position.position_type === "long" ? 1 : -1)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Open Positions</CardTitle>
          <Badge variant="outline">{positions.length} Active</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Entry Price</TableHead>
                <TableHead>Current Price</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Leverage</TableHead>
                <TableHead>P&L</TableHead>
                <TableHead>Stop Loss</TableHead>
                <TableHead>Take Profit</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No open positions
                  </TableCell>
                </TableRow>
              ) : (
                positions.map((position) => {
                  const pnlPercent = calculatePnLPercent(position)
                  const isProfit = position.unrealized_pnl >= 0

                  return (
                    <TableRow key={position.id}>
                      <TableCell className="font-medium">{position.symbol}</TableCell>
                      <TableCell>
                        <Badge variant={position.position_type === "long" ? "default" : "secondary"}>
                          {position.position_type.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell>${position.entry_price.toFixed(2)}</TableCell>
                      <TableCell>${position.current_price.toFixed(2)}</TableCell>
                      <TableCell>{position.quantity.toFixed(4)}</TableCell>
                      <TableCell>{position.leverage}x</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className={`font-semibold ${isProfit ? "text-green-600" : "text-red-600"}`}>
                            {isProfit ? "+" : ""}
                            {position.unrealized_pnl.toFixed(2)}
                          </span>
                          <span className={`text-xs ${isProfit ? "text-green-600" : "text-red-600"}`}>
                            ({pnlPercent >= 0 ? "+" : ""}
                            {pnlPercent.toFixed(2)}%)
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{position.stop_loss ? `$${position.stop_loss.toFixed(2)}` : "-"}</TableCell>
                      <TableCell>{position.take_profit ? `$${position.take_profit.toFixed(2)}` : "-"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(position.opened_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => onClosePosition(position.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
