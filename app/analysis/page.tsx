"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PositionBreakdown } from "@/components/analysis/position-breakdown"
import { PositionCalculator } from "@/lib/position-calculator"
import type { SymbolAnalysis } from "@/lib/position-calculator"
import { CalculationDemo } from "@/components/analysis/calculation-demo"
import { TrendingUp, TrendingDown, Activity, DollarSign, Clock, Target } from "lucide-react"
import { PageHeader } from "@/components/page-header"

interface ActivePosition {
  id: string
  symbol: string
  direction: "long" | "short"
  entry_price: number
  current_price: number
  quantity: number
  leverage: number
  unrealized_pnl: number
  unrealized_pnl_percent: number
  status: string
  created_at: string
  connection_id: string
}

interface PositionStats {
  total_positions: number
  active_positions: number
  closed_positions: number
  total_pnl: number
  win_rate: number
  avg_profit: number
  avg_loss: number
}

export default function AnalysisPage() {
  const [calculator] = useState(new PositionCalculator())
  const [selectedSymbol, setSelectedSymbol] = useState("XRPUSDT")
  const [symbolAnalysis, setSymbolAnalysis] = useState<SymbolAnalysis | null>(null)
  const [activePositions, setActivePositions] = useState<ActivePosition[]>([])
  const [positionStats, setPositionStats] = useState<PositionStats | null>(null)
  const [connections, setConnections] = useState<any[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>("all")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchConnections()
  }, [])

  useEffect(() => {
    fetchActivePositions()
    fetchPositionStats()
    const interval = setInterval(() => {
      fetchActivePositions()
      fetchPositionStats()
    }, 5000) // Update every 5 seconds
    return () => clearInterval(interval)
  }, [selectedConnection])

  useEffect(() => {
    const analysis = calculator.calculateSymbolPositions(selectedSymbol)
    setSymbolAnalysis(analysis)
  }, [selectedSymbol, calculator])

  const fetchConnections = async () => {
    try {
      const res = await fetch("/api/settings/connections")
      if (res.ok) {
        const data = await res.json()
        setConnections(data.connections || [])
      }
    } catch (error) {
      console.error("[v0] Failed to fetch connections:", error)
    }
  }

  const fetchActivePositions = async () => {
    try {
      const url = selectedConnection === "all" ? "/api/positions" : `/api/positions/${selectedConnection}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setActivePositions(data.positions || [])
      }
    } catch (error) {
      console.error("[v0] Failed to fetch positions:", error)
    } finally {
      setLoading(false)
    }
  }

  const fetchPositionStats = async () => {
    try {
      const url = selectedConnection === "all" ? "/api/positions/stats" : `/api/positions/${selectedConnection}/stats`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setPositionStats(data.stats)
      }
    } catch (error) {
      console.error("[v0] Failed to fetch stats:", error)
    }
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  const formatCurrency = (num: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)
  }

  const formatPercent = (num: number) => {
    return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`
  }

  /*
   * Modernized the Analysis page shell to align with the rest of the
   * sidebar:
   *   - PageHeader (consistent typography) instead of a bespoke `<h1>`.
   *   - Compact stats row (`grid-cols-2 md:grid-cols-4`, icon-pill pattern)
   *     in place of the previous 4 large Cards.
   *   - Active-position row rewritten as a single responsive flex layout
   *     that wraps cleanly on narrow widths rather than overflowing.
   *   - Semantic design-token colors for hover/border; accent status
   *     colors (green/red) kept only for P&L sign where that carries
   *     meaning.
   */
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader
          title="Position Analysis"
          description="Real-time position tracking and theoretical calculations"
        />
        <Badge variant="outline" className="gap-1 h-7">
          <Activity className="w-3.5 h-3.5" />
          Live Data
        </Badge>
      </div>

      {/* Connection filter — slim single-line select */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-muted/40 rounded-md border border-border text-xs">
        <span className="text-muted-foreground">Filter by connection:</span>
        <Select value={selectedConnection} onValueChange={setSelectedConnection}>
          <SelectTrigger className="h-7 w-[220px] text-xs">
            <SelectValue placeholder="Select connection" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Connections</SelectItem>
            {connections.map((conn) => (
              <SelectItem key={conn.id} value={conn.id}>
                {conn.name} ({conn.exchange})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Compact stats row — 4 columns, icon-pill pattern */}
      {positionStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            {
              icon: Activity,
              label: "Active",
              value: formatNumber(positionStats.active_positions),
              sub: `${formatNumber(positionStats.total_positions)} total`,
              tint: "text-primary",
            },
            {
              icon: DollarSign,
              label: "Total P&L",
              value: formatCurrency(positionStats.total_pnl),
              sub: "Unrealized",
              tint: positionStats.total_pnl >= 0 ? "text-green-500" : "text-red-500",
            },
            {
              icon: Target,
              label: "Win Rate",
              value: `${positionStats.win_rate.toFixed(1)}%`,
              sub: "Closed positions",
              tint: "text-indigo-500",
            },
            {
              icon: Clock,
              label: "Avg P/L",
              value: `${formatCurrency(positionStats.avg_profit)}`,
              sub: `Loss ${formatCurrency(positionStats.avg_loss)}`,
              tint: "text-amber-500",
            },
          ].map((stat) => (
            <Card key={stat.label} className="border-border bg-card">
              <CardContent className="p-2.5 flex items-center gap-2.5">
                <div className={`rounded bg-muted/60 p-1.5 ${stat.tint}`}>
                  <stat.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-lg font-bold tabular-nums ${stat.tint}`}>{stat.value}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">
                    {stat.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{stat.sub}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Tabs defaultValue="active" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 h-9">
          <TabsTrigger value="active" className="text-xs">
            Active Positions
          </TabsTrigger>
          <TabsTrigger value="theoretical" className="text-xs">
            Theoretical Analysis
          </TabsTrigger>
          <TabsTrigger value="demo" className="text-xs">
            Calculation Demo
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Active Positions ({activePositions.length})</CardTitle>
              <CardDescription className="text-xs">Real-time position tracking with P&L updates</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading positions&hellip;</div>
              ) : activePositions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No active positions</div>
              ) : (
                <div className="space-y-2">
                  {activePositions.map((position) => {
                    const isLong = position.direction === "long"
                    const pnlPositive = position.unrealized_pnl >= 0
                    return (
                      <div
                        key={position.id}
                        className="flex items-center gap-3 p-3 border border-border rounded-lg hover:bg-muted/30 transition-colors flex-wrap"
                      >
                        <div
                          className={`p-1.5 rounded ${
                            isLong
                              ? "bg-green-500/15 text-green-500"
                              : "bg-red-500/15 text-red-500"
                          }`}
                        >
                          {isLong ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-sm">{position.symbol}</div>
                          <div className="text-[11px] text-muted-foreground uppercase">
                            {position.direction} &bull; {position.leverage}x
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-xs ml-auto flex-wrap">
                          <div>
                            <div className="text-muted-foreground">Entry</div>
                            <div className="font-medium tabular-nums">${position.entry_price.toFixed(4)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Current</div>
                            <div className="font-medium tabular-nums">${position.current_price.toFixed(4)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Qty</div>
                            <div className="font-medium tabular-nums">{position.quantity}</div>
                          </div>
                          <div className="text-right">
                            <div
                              className={`text-sm font-bold tabular-nums ${
                                pnlPositive ? "text-green-500" : "text-red-500"
                              }`}
                            >
                              {formatCurrency(position.unrealized_pnl)}
                            </div>
                            <div
                              className={`text-[11px] tabular-nums ${
                                pnlPositive ? "text-green-500" : "text-red-500"
                              }`}
                            >
                              {formatPercent(position.unrealized_pnl_percent)}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="theoretical" className="space-y-4">
          {symbolAnalysis && <PositionBreakdown analysis={symbolAnalysis} />}
        </TabsContent>

        <TabsContent value="demo" className="space-y-4">
          <CalculationDemo />
        </TabsContent>
      </Tabs>
    </div>
  )
}
