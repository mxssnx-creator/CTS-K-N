"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { BacktestResult, Preset } from "@/lib/types"
import { Play, TrendingUp, TrendingDown, Activity, Clock, AlertTriangle } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { formatSampledMetric, grossProfitFactorTitle } from "@/lib/metric-formatting"

interface BacktestViewProps {
  preset: Preset
}

export function BacktestView({ preset }: BacktestViewProps) {
  const [results, setResults] = useState<BacktestResult[]>([])
  const [selectedResult, setSelectedResult] = useState<BacktestResult | null>(null)
  const [connections, setConnections] = useState<any[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>("")
  const [isRunning, setIsRunning] = useState(false)

  useEffect(() => {
    loadConnections()
    loadResults()
  }, [preset.id])

  const loadConnections = async () => {
    try {
      const response = await fetch("/api/connections")
      const data = await response.json()
      setConnections(data)
      if (data.length > 0) {
        setSelectedConnection(data[0].id)
      }
    } catch (error) {
      console.error("[v0] Failed to load connections:", error)
    }
  }

  const loadResults = async () => {
    try {
      const response = await fetch(`/api/backtest-results?presetId=${preset.id}`)
      const data = await response.json()
      setResults(data)
      if (data.length > 0) {
        setSelectedResult(data[0])
      }
    } catch (error) {
      console.error("[v0] Failed to load backtest results:", error)
    }
  }

  const handleRunBacktest = async () => {
    if (!selectedConnection) {
      toast.error("Please select a connection")
      return
    }

    try {
      setIsRunning(true)
      const response = await fetch(`/api/presets/${preset.id}/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection_id: selectedConnection,
          period_days: preset.backtest_period_days,
        }),
      })

      const data = await response.json()
      toast.success("Backtest started successfully")

      // Poll for results
      setTimeout(() => loadResults(), 2000)
    } catch (error) {
      console.error("[v0] Failed to run backtest:", error)
      toast.error("Failed to run backtest")
    } finally {
      setIsRunning(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-500"
      case "running":
        return "text-blue-500"
      case "failed":
        return "text-red-500"
      default:
        return "text-gray-500"
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Run Backtest</CardTitle>
          <CardDescription>Test preset strategies against historical data</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <Select value={selectedConnection} onValueChange={setSelectedConnection}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id}>
                    {conn.name} ({conn.exchange})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleRunBacktest} disabled={isRunning || !selectedConnection}>
              <Play className={`h-4 w-4 mr-2 ${isRunning ? "animate-spin" : ""}`} />
              {isRunning ? "Running..." : "Run Backtest"}
            </Button>
          </div>
          <div className="text-sm text-muted-foreground">
            Period: {preset.backtest_period_days} days • Symbols: {preset.indication_types.length} types
          </div>
        </CardContent>
      </Card>

      {results.length > 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Backtest Results</CardTitle>
              <CardDescription>Historical performance metrics</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {results.slice(0, 5).map((result) => (
                  <div
                    key={result.id}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedResult?.id === result.id ? "border-primary bg-primary/5" : "hover:bg-muted"
                    }`}
                    onClick={() => setSelectedResult(result)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">
                          {new Date(result.created_at).toLocaleDateString()} - {result.symbols.length} symbols
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {result.total_trades} trades • {result.win_rate.toFixed(1)}% win rate
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge
                          variant={result.status === "completed" ? "default" : "outline"}
                          className={getStatusColor(result.status)}
                        >
                          {result.status}
                        </Badge>
                        {result.status === "completed" && (
                          <div
                            className={`text-sm font-medium ${result.net_profit >= 0 ? "text-green-500" : "text-red-500"}`}
                          >
                            {result.net_profit >= 0 ? "+" : ""}
                            {result.net_profit.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {selectedResult && selectedResult.status === "completed" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-blue-500" />
                    <div>
                      <div className="text-2xl font-bold" title={grossProfitFactorTitle(selectedResult.profit_factor, selectedResult.total_trades)}>{formatSampledMetric(selectedResult.profit_factor, selectedResult.total_trades)}</div>
                      <div className="text-sm text-muted-foreground">PF</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-5 w-5 text-red-500" />
                    <div>
                      <div className="text-2xl font-bold">{selectedResult.max_drawdown.toFixed(1)}%</div>
                      <div className="text-sm text-muted-foreground">Max Drawdown</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Activity className="h-5 w-5 text-green-500" />
                    <div>
                      <div className="text-2xl font-bold">{selectedResult.win_rate.toFixed(1)}%</div>
                      <div className="text-sm text-muted-foreground">Win Rate</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-purple-500" />
                    <div>
                      <div className="text-2xl font-bold">{selectedResult.avg_trade_duration_minutes.toFixed(0)}m</div>
                      <div className="text-sm text-muted-foreground">Avg Duration</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Trade Statistics</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Trades:</span>
                    <span className="font-medium">{selectedResult.total_trades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Winning Trades:</span>
                    <span className="font-medium text-green-500">{selectedResult.winning_trades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Losing Trades:</span>
                    <span className="font-medium text-red-500">{selectedResult.losing_trades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Avg Win:</span>
                    <span className="font-medium text-green-500">+{selectedResult.avg_win.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Avg Loss:</span>
                    <span className="font-medium text-red-500">-{selectedResult.avg_loss.toFixed(2)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Risk Metrics</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Net Profit:</span>
                    <span
                      className={`font-medium ${selectedResult.net_profit >= 0 ? "text-green-500" : "text-red-500"}`}
                    >
                      {selectedResult.net_profit >= 0 ? "+" : ""}
                      {selectedResult.net_profit.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Max Drawdown Duration:</span>
                    <span className="font-medium">{selectedResult.max_drawdown_duration_hours.toFixed(0)}h</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Avg Drawdown:</span>
                    <span className="font-medium">{selectedResult.avg_drawdown.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sharpe Ratio:</span>
                    <span className="font-medium">{selectedResult.sharpe_ratio.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sortino Ratio:</span>
                    <span className="font-medium">{selectedResult.sortino_ratio.toFixed(2)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      {results.length === 0 && (
        <Card>
          <CardContent className="p-12 text-center">
            <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No backtest results yet</h3>
            <p className="text-muted-foreground">Run a backtest to evaluate this preset's performance</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
