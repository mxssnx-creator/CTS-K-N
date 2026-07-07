"use client"

import React, { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrendingUp, AlertCircle, CheckCircle2, Zap } from "lucide-react"

interface VolatilityScreenResult {
  success: boolean
  timestamp: string
  screened: number
  highVolatile: number
  results: Array<{
    symbol: string
    volatility: string
    score: number
    range: string
    isHighVolatility: boolean
  }>
  selectedSymbols: string[]
}

export function VolatilityScreenerCard() {
  const [screening, setScreening] = useState(false)
  const [results, setResults] = useState<VolatilityScreenResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [liveTradeEnabled, setLiveTradeEnabled] = useState<{ [key: string]: boolean }>({})
  const [enabling, setEnabling] = useState(false)

  const screenSymbols = async () => {
    setScreening(true)
    setError(null)
    try {
      const response = await fetch("/api/symbols/screen-volatility", { cache: "no-store" })
      if (!response.ok) throw new Error("Failed to screen symbols")
      const data = await response.json()
      
      // Get top 3 highest volatility symbols
      const top3Symbols = data.results
        .filter((r: any) => r.isHighVolatility)
        .slice(0, 3)
        .map((r: any) => r.symbol)
      
      setResults({
        ...data,
        selectedSymbols: top3Symbols,
      })

      // Auto-enable live trading for top 3
      if (top3Symbols.length > 0) {
        await enableLiveTrading(top3Symbols)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setScreening(false)
    }
  }

  const enableLiveTrading = async (symbols: string[]) => {
    setEnabling(true)
    try {
      const response = await fetch("/api/trade-engine/enable-symbols", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ symbols }),
      })

      if (response.ok) {
        const statusMap: { [key: string]: boolean } = {}
        symbols.forEach(s => {
          statusMap[s] = true
        })
        setLiveTradeEnabled(prev => ({ ...prev, ...statusMap }))
      }
    } catch {
      // non-critical
    } finally {
      setEnabling(false)
    }
  }

  const toggleLiveTrading = async (symbol: string) => {
    const newStatus = !liveTradeEnabled[symbol]
    try {
      const response = await fetch("/api/trade-engine/toggle-symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ symbol, enabled: newStatus }),
      })

      if (response.ok) {
        setLiveTradeEnabled(prev => ({
          ...prev,
          [symbol]: newStatus,
        }))
      }
    } catch { /* non-critical */ }
  }

  useEffect(() => {
    screenSymbols()
  }, [])

  // Top 3 symbols
  const topThree = results?.results.slice(0, 3) || []
  const otherSymbols = results?.results.slice(3) || []

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              High Volatility Screener
            </CardTitle>
            <CardDescription>
              Top 3 highest volatility symbols - Auto-selected for live trading
            </CardDescription>
          </div>
          <Button
            onClick={screenSymbols}
            disabled={screening || enabling}
            variant="outline"
            size="sm"
          >
            {screening ? "Scanning..." : enabling ? "Enabling..." : "Rescan"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {results && (
          <>
            {/* Summary Stats */}
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg bg-blue-50 p-2">
                <div className="text-xs text-blue-600">Total Screened</div>
                <div className="text-lg font-semibold text-blue-700">{results.screened}</div>
              </div>
              <div className="rounded-lg bg-green-50 p-2">
                <div className="text-xs text-green-600">High Volatility</div>
                <div className="text-lg font-semibold text-green-700">{results.highVolatile}</div>
              </div>
              <div className="rounded-lg bg-purple-50 p-2">
                <div className="text-xs text-purple-600">Live Trading</div>
                <div className="text-lg font-semibold text-purple-700">
                  {Object.values(liveTradeEnabled).filter(Boolean).length}
                </div>
              </div>
            </div>

            {/* Top 3 Symbols - Highlighted for Live Trading */}
            {topThree.length > 0 && (
              <div className="space-y-2 border-2 border-green-200 rounded-lg p-3 bg-green-50">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="h-4 w-4 text-green-600" />
                  <span className="font-semibold text-green-900">Top 3 for Live Trading</span>
                </div>
                <div className="space-y-2">
                  {topThree.map((result, idx) => (
                    <div
                      key={result.symbol}
                      className="rounded-lg p-3 border-2 border-green-300 bg-white flex items-start justify-between"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-600 text-white text-sm font-bold">
                            {idx + 1}
                          </span>
                          <span className="font-semibold text-lg text-green-900">{result.symbol}</span>
                          <Badge className="bg-green-600 text-white">High Vol</Badge>
                          {liveTradeEnabled[result.symbol] && (
                            <Badge className="bg-emerald-600 text-white flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Live Trading
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm text-gray-600">
                          <div>Range: <span className="font-semibold text-green-700">{result.volatility}</span></div>
                          <div>Score: <span className="font-semibold">{result.score}/100</span></div>
                        </div>
                      </div>
                      <Button
                        onClick={() => toggleLiveTrading(result.symbol)}
                        variant={liveTradeEnabled[result.symbol] ? "default" : "outline"}
                        size="sm"
                        className={liveTradeEnabled[result.symbol] ? "bg-emerald-600 hover:bg-emerald-700" : ""}
                      >
                        {liveTradeEnabled[result.symbol] ? "Trading ON" : "Enable"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Selected Symbols Summary */}
            {results.selectedSymbols.length > 0 && (
              <div className="flex gap-2 flex-wrap p-3 bg-blue-50 rounded-lg">
                <span className="text-sm text-blue-700 font-semibold">Selected:</span>
                {results.selectedSymbols.map((symbol) => (
                  <Badge key={symbol} variant="secondary" className="bg-blue-200 text-blue-900">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {symbol}
                  </Badge>
                ))}
              </div>
            )}

            {/* Other High Volatility Symbols */}
            {otherSymbols.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-gray-700">Other High Volatility Symbols</div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {otherSymbols.map((result) => (
                    <div
                      key={result.symbol}
                      className="rounded-lg p-2 border border-gray-200 bg-gray-50 flex items-center justify-between"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-800">{result.symbol}</span>
                          <Badge variant="outline" className="text-xs">{result.volatility}</Badge>
                        </div>
                        <div className="text-xs text-gray-500">Score: {result.score}/100</div>
                      </div>
                      <Button
                        onClick={() => toggleLiveTrading(result.symbol)}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                      >
                        {liveTradeEnabled[result.symbol] ? "ON" : "Enable"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Last Updated */}
            <div className="text-xs text-gray-500 text-center pt-2 border-t">
              Updated: {new Date(results.timestamp).toLocaleTimeString()}
            </div>
          </>
        )}

        {!results && !error && (
          <div className="text-center py-4">
            <div className="text-sm text-gray-500">Initializing volatility screener...</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
