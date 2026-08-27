"use client"

import { useState, useEffect, memo } from "react"
import { Card, CardContent } from "@/components/ui/card"

interface ExchangeStatisticsProps {
  connectionId: string
  connectionName: string
}

const ExchangeStatisticsComponent = ({ connectionId, connectionName }: ExchangeStatisticsProps) => {
  const [stats, setStats] = useState<any>(null)

  useEffect(() => {
    const loadStats = async () => {
      try {
        const res = await fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" })
        if (res.ok) {
          const data = await res.json()
          setStats(data)
        }
      } catch (err) {
        console.error("[Stats] Error:", err)
      }
    }

    loadStats()
    const interval = setInterval(loadStats, 30000)
    return () => clearInterval(interval)
  }, [connectionId])

  if (!stats) return null

  const historic = stats.historic || {}
  const realtime = stats.realtime || {}
  const strategyDetail = stats.strategyDetail || {}
  const liveExecution = stats.liveExecution || {}
  const liveDetail = strategyDetail.live || {}
  const prehistoric = {
    symbols_analyzed: historic.symbolsProcessed ?? historic.symbolsTotal ?? 0,
    win_rate: liveExecution.winRate ?? null,
    profit_factor: liveDetail.avgProfitFactor ?? strategyDetail.real?.avgProfitFactor ?? strategyDetail.main?.avgProfitFactor ?? 0,
    trades: liveExecution.positionsClosed ?? 0,
    profit: liveExecution.realizedPnl ?? null,
    drawdown: liveDetail.avgDrawdownTime ?? null,
    avg_win: liveExecution.avgWin ?? null,
    avg_loss: liveExecution.avgLoss ?? null,
  }
  const hasSettledResults = Number(liveExecution.settledClosedPositions || 0) > 0
  const showMetric = (value: unknown, decimals: number, suffix = "") =>
    value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(decimals)}${suffix}`

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="grid grid-cols-3 gap-2 text-xs md:grid-cols-6 lg:grid-cols-8">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Symbols</span>
            <span className="font-bold">{prehistoric.symbols_analyzed || 0}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Win%</span>
            <span className={`font-bold ${Number(prehistoric.win_rate) >= 50 ? "text-green-600" : "text-slate-600"}`}>
              {hasSettledResults ? showMetric(prehistoric.win_rate, 0, "%") : "—"}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF</span>
            <span className={`font-bold ${prehistoric.profit_factor >= 1.5 ? "text-green-600" : prehistoric.profit_factor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {hasSettledResults ? showMetric(prehistoric.profit_factor, 1) : "—"}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Trades</span>
            <span className="font-bold text-slate-600">{prehistoric.trades || 0}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Profit</span>
            <span className={`font-bold ${(prehistoric.profit || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
              {prehistoric.profit == null ? "—" : `${showMetric(prehistoric.profit, 2)} USDT`}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">DDT</span>
            <span className={`font-bold ${Math.abs(prehistoric.drawdown || 0) <= 10 ? "text-green-600" : Math.abs(prehistoric.drawdown || 0) <= 25 ? "text-orange-600" : "text-red-600"}`}>
              {showMetric(prehistoric.drawdown, 1, "m")}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Avg W</span>
            <span className="font-bold text-green-600">{prehistoric.avg_win == null ? "—" : `${showMetric(prehistoric.avg_win, 3)} USDT`}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Avg L</span>
            <span className="font-bold text-red-600">{prehistoric.avg_loss == null ? "—" : `${showMetric(prehistoric.avg_loss, 3)} USDT`}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export const ExchangeStatistics = memo(ExchangeStatisticsComponent)
export default ExchangeStatistics
