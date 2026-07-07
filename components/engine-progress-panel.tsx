"use client"

import { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChevronDown, ChevronRight, Activity, Database, Wifi, AlertCircle } from "lucide-react"

interface SymbolData {
  symbol: string
  prehistoricLoaded: boolean
  prehistoricCandles: number
  prehistoricDuration: number
  wsConnected: boolean
  wsMessagesReceived: number
  indicationCycles: number
  strategyCycles: number
  realtimeCycles: number
  totalErrors: number
  lastError: string | null
  lastIndicationTime: string | null
  lastStrategyTime: string | null
  lastRealtimeTime: string | null
}

interface EngineProgressPanelProps {
  connectionId: string
}

export function EngineProgressPanel({ connectionId }: EngineProgressPanelProps) {
  const [progress, setProgress] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchProgress()
    const interval = setInterval(fetchProgress, 5000)
    return () => clearInterval(interval)
  }, [connectionId])

  const fetchProgress = async () => {
    try {
      const res = await fetch(`/api/engine-progress?connectionId=${connectionId}`)
      const data = await res.json()
      setProgress(data.progress)
    } catch (error) {
      console.error("Failed to fetch progress:", error)
    } finally {
      setLoading(false)
    }
  }

  const toggleSymbol = (symbol: string) => {
    const newExpanded = new Set(expandedSymbols)
    if (newExpanded.has(symbol)) {
      newExpanded.delete(symbol)
    } else {
      newExpanded.add(symbol)
    }
    setExpandedSymbols(newExpanded)
  }

  if (loading) {
    return <div className="p-4 text-center">Loading progress...</div>
  }

  if (!progress) {
    return <div className="p-4 text-center">No progress data available</div>
  }

  const symbols = Object.entries(progress.symbols || {}) as [string, SymbolData][]
  const prehistoricPercent = progress.prehistoricTotalSymbols > 0 
    ? (progress.prehistoricLoadedSymbols / progress.prehistoricTotalSymbols) * 100 
    : 0

  return (
    <div className="space-y-4">
      {/* Overall Status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Engine Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <Badge variant={progress.status === "running" ? "default" : progress.status === "error" ? "destructive" : "secondary"}>
                {progress.status}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Symbols:</span> {symbols.length}
            </div>
            <div>
              <span className="text-muted-foreground">Indication Cycles:</span> {progress.totalIndicationCycles}
            </div>
            <div>
              <span className="text-muted-foreground">Strategy Cycles:</span> {progress.totalStrategyCycles}
            </div>
            <div>
              <span className="text-muted-foreground">Realtime Cycles:</span> {progress.totalRealtimeCycles}
            </div>
            <div>
              <span className="text-muted-foreground">Errors:</span>{" "}
              <Badge variant={progress.errors?.length > 0 ? "destructive" : "secondary"}>
                {progress.errors?.length || 0}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Prehistoric Progress */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Prehistoric Data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span>{progress.prehistoricLoadedSymbols}/{progress.prehistoricTotalSymbols} symbols</span>
              <span>{Math.round(prehistoricPercent)}%</span>
            </div>
            <Progress value={prehistoricPercent} className="h-2" />
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span>Candles: {progress.prehistoricTotalCandles}</span>
              <span>Duration: {progress.prehistoricDuration}ms</span>
              <span>Errors: {progress.prehistoricErrors}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* WebSocket Status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wifi className="h-4 w-4" />
            WebSocket Connections
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Connected:</span>{" "}
              <Badge variant={progress.wsSymbolsConnected > 0 ? "default" : "secondary"}>
                {progress.wsSymbolsConnected}/{progress.wsTotalSymbols}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Messages:</span> {progress.wsMessagesTotal}
            </div>
            <div>
              <span className="text-muted-foreground">Errors:</span>{" "}
              <Badge variant={progress.wsErrorsTotal > 0 ? "destructive" : "secondary"}>
                {progress.wsErrorsTotal}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Last Update:</span>{" "}
              {progress.wsLastUpdate ? new Date(progress.wsLastUpdate).toLocaleTimeString() : "N/A"}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Symbol Details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Symbols</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {symbols.map(([symbol, data]) => (
              <div key={symbol} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleSymbol(symbol)}
                  className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {expandedSymbols.has(symbol) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-medium text-sm">{symbol}</span>
                    <Badge variant={data.prehistoricLoaded ? "default" : "secondary"} className="text-xs">
                      {data.prehistoricLoaded ? "Loaded" : "Loading"}
                    </Badge>
                    <Badge variant={data.wsConnected ? "default" : "secondary"} className="text-xs">
                      {data.wsConnected ? "WS" : "No WS"}
                    </Badge>
                    {data.totalErrors > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        {data.totalErrors}
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span>{data.prehistoricCandles} candles</span>
                    <span>{data.indicationCycles} ind</span>
                    <span>{data.strategyCycles} strat</span>
                  </div>
                </button>
                
                {expandedSymbols.has(symbol) && (
                  <div className="px-3 py-2 bg-muted/30 border-t space-y-2 text-xs">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-muted-foreground">Prehistoric:</span>{" "}
                        {data.prehistoricCandles} candles in {data.prehistoricDuration}ms
                      </div>
                      <div>
                        <span className="text-muted-foreground">WebSocket:</span>{" "}
                        {data.wsMessagesReceived} messages
                      </div>
                      <div>
                        <span className="text-muted-foreground">Indications:</span>{" "}
                        {data.indicationCycles} cycles
                      </div>
                      <div>
                        <span className="text-muted-foreground">Strategies:</span>{" "}
                        {data.strategyCycles} cycles
                      </div>
                      <div>
                        <span className="text-muted-foreground">Realtime:</span>{" "}
                        {data.realtimeCycles} cycles
                      </div>
                      <div>
                        <span className="text-muted-foreground">Last Indication:</span>{" "}
                        {data.lastIndicationTime ? new Date(data.lastIndicationTime).toLocaleTimeString() : "N/A"}
                      </div>
                    </div>
                    {data.lastError && (
                      <div className="text-red-500">
                        <AlertCircle className="h-3 w-3 inline mr-1" />
                        {data.lastError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
