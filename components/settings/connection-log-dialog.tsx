"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface ConnectionLogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
}

type LogSummary = {
  total?: number
  errors?: number
  warnings?: number
  info?: number
  debug?: number
  phases?: Record<string, number>
  latestTimestamp?: string | null
  oldestTimestamp?: string | null
  
  // Enhanced summary for detailed logging
  prehistoricData?: {
    cyclesCompleted: number
    symbolsProcessed: number
    candlesProcessed: number
    phaseActive: boolean
    lastUpdate: string | null
  }
  
  indicationsCounts?: {
    direction: number
    move: number
    active: number
    optimal: number
    auto: number
  }
  
  strategyCounts?: {
    base: {
      total: number
      evaluated: number
      pending: number
    }
    main: {
      total: number
      evaluated: number
      pending: number
    }
    real: {
      total: number
      evaluated: number
      pending: number
    }
  }
  
  enginePerformance?: {
    cycleTimeMs: number
    cyclesCompleted: number
    successfulCycles: number
    failedCycles: number
    cycleSuccessRate: number
    totalTrades: number
    successfulTrades: number
    tradeSuccessRate: number
    totalProfit: number
    lastCycleTime: string | null
    intervalsProcessed: number
    indicationsCount: number
    strategiesCount: number
  }
}

export function ConnectionLogDialog({ open, onOpenChange, connectionId, connectionName }: ConnectionLogDialogProps) {
  const [loading, setLoading] = useState(true)
  const [logs, setLogs] = useState<any[]>([])
  const [summary, setSummary] = useState<LogSummary | null>(null)

  useEffect(() => {
    if (open) {
      loadLogs()
    }
  }, [open, connectionId])

  const loadLogs = async () => {
    try {
      setLoading(true)

      const response = await fetch(`/api/connections/progression/${connectionId}/logs`)
      if (!response.ok) throw new Error("Failed to load logs")

      const data = await response.json()
      setLogs(data.logs || [])
      
      // Map the actual API response to the expected summary format
      setSummary({
        total: data.logsCount || 0,
        errors: data.logs?.filter((l: any) => l.level === "error").length || 0,
        warnings: data.logs?.filter((l: any) => l.level === "warn").length || 0,
        info: data.logs?.filter((l: any) => l.level === "info").length || 0,
        debug: data.logs?.filter((l: any) => l.level === "debug").length || 0,
        latestTimestamp: data.logs?.[0]?.timestamp || null,
        oldestTimestamp: data.logs?.[data.logs.length - 1]?.timestamp || null,
        
        prehistoricData: {
          cyclesCompleted: data.progressionState?.prehistoricCyclesCompleted || 0,
          symbolsProcessed: data.progressionState?.prehistoricSymbolsProcessed || 0,
          candlesProcessed: data.progressionState?.prehistoricCandlesProcessed || 0,
          phaseActive: data.progressionState?.prehistoricPhaseActive || false,
          lastUpdate: data.progressionState?.lastCycleTime || null
        },
        
        indicationsCounts: {
          direction: data.progressionState?.indicationEvaluatedDirection || 0,
          move: data.progressionState?.indicationEvaluatedMove || 0,
          active: data.progressionState?.indicationEvaluatedActive || 0,
          optimal: data.progressionState?.indicationEvaluatedOptimal || 0,
          auto: data.progressionState?.indicationsCount || 0
        },
        
        strategyCounts: {
          base: {
            total: data.progressionState?.setsBaseCount || 0,
            evaluated: data.progressionState?.strategyEvaluatedBase || 0,
            pending: Math.max(0, (data.progressionState?.setsBaseCount || 0) - (data.progressionState?.strategyEvaluatedBase || 0))
          },
          main: {
            total: data.progressionState?.setsMainCount || 0,
            evaluated: data.progressionState?.strategyEvaluatedMain || 0,
            pending: Math.max(0, (data.progressionState?.setsMainCount || 0) - (data.progressionState?.strategyEvaluatedMain || 0))
          },
          real: {
            total: data.progressionState?.setsRealCount || 0,
            evaluated: data.progressionState?.strategyEvaluatedReal || 0,
            pending: Math.max(0, (data.progressionState?.setsRealCount || 0) - (data.progressionState?.strategyEvaluatedReal || 0))
          }
        },
        
        enginePerformance: {
          cycleTimeMs: data.progressionState?.cycleTimeMs || 0,
          cyclesCompleted: data.progressionState?.cyclesCompleted || 0,
          successfulCycles: data.progressionState?.successfulCycles || 0,
          failedCycles: data.progressionState?.failedCycles || 0,
          cycleSuccessRate: data.progressionState?.cycleSuccessRate || 0,
          totalTrades: data.progressionState?.totalTrades || 0,
          successfulTrades: data.progressionState?.successfulTrades || 0,
          tradeSuccessRate: data.progressionState?.tradeSuccessRate || 0,
          totalProfit: data.progressionState?.totalProfit || 0,
          lastCycleTime: data.progressionState?.lastCycleTime || null,
          intervalsProcessed: data.progressionState?.intervalsProcessed || 0,
          indicationsCount: data.progressionState?.indicationsCount || 0,
          strategiesCount: data.progressionState?.strategiesCount || 0
        }
      })
    } catch (error) {
      console.error("[v0] Failed to load connection logs:", error)
      toast.error("Error loading logs", {
        description: error instanceof Error ? error.message : "Failed to load logs",
      })
    } finally {
      setLoading(false)
    }
  }

  const getLevelBadge = (level: string) => {
    switch (level) {
      case "error":
        return <Badge variant="destructive">Error</Badge>
      case "warn":
        return <Badge variant="secondary">Warning</Badge>
      case "info":
        return <Badge variant="outline">Info</Badge>
      default:
        return <Badge variant="outline">{level}</Badge>
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[78vh]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>Connection Logs - {connectionName}</DialogTitle>
              <DialogDescription>View recent activity and error logs for this connection</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">Manual refresh only</Badge>
              <Button variant="outline" size="sm" onClick={loadLogs} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
{summary && (
               <>
                 {/* Enhanced Summary Cards */}
                 <div className="grid grid-cols-4 gap-4 mb-4">
                   <div className="p-3 border rounded-lg text-center">
                     <div className="text-2xl font-bold">{summary.total || 0}</div>
                     <div className="text-sm text-muted-foreground">Total Logs</div>
                   </div>
                   <div className="p-3 border rounded-lg text-center">
                     <div className="text-2xl font-bold text-red-500">{summary.errors || 0}</div>
                     <div className="text-sm text-muted-foreground">Errors</div>
                   </div>
                   <div className="p-3 border rounded-lg text-center">
                     <div className="text-2xl font-bold text-yellow-500">{summary.warnings || 0}</div>
                     <div className="text-sm text-muted-foreground">Warnings</div>
                   </div>
                   <div className="p-3 border rounded-lg text-center">
                     <div className="text-2xl font-bold text-blue-500">{summary.info || 0}</div>
                     <div className="text-sm text-muted-foreground">Info</div>
                   </div>
                 </div>
                 
                  {/* Prehistoric Data Processing */}
                  {summary.prehistoricData && (
                    <div className="bg-blue-50 rounded-lg p-4 mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium">Prehistoric Data Processing</div>
                        <div className="text-xs text-blue-600">
                          {summary.prehistoricData.phaseActive ? "Active" : "Completed"}
                        </div>
                      </div>

                      {/* Detailed Prehistoric Progress Bar */}
                      <div className="mb-3">
                        <div className="flex justify-between text-xs mb-1">
                          <span>Progress</span>
                          <span>
                            {summary.prehistoricData.symbolsProcessed} / {Math.max(summary.prehistoricData.symbolsProcessed, summary.prehistoricData.cyclesCompleted > 0 ? 128 : 0)} symbols
                          </span>
                        </div>
                        <Progress
                          value={
                            summary.prehistoricData.cyclesCompleted > 0
                              ? Math.min((summary.prehistoricData.symbolsProcessed / Math.max(summary.prehistoricData.symbolsProcessed, 128)) * 100, 100)
                              : 0
                          }
                          className="h-2"
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                          <span>Cycles: {summary.prehistoricData.cyclesCompleted}</span>
                          <span>Candles: {summary.prehistoricData.candlesProcessed.toLocaleString()}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                          <div className="font-semibold">{summary.prehistoricData.cyclesCompleted}</div>
                          <div className="text-xs text-muted-foreground">Cycles</div>
                        </div>
                        <div>
                          <div className="font-semibold">{summary.prehistoricData.symbolsProcessed}</div>
                          <div className="text-xs text-muted-foreground">Symbols</div>
                        </div>
                        <div>
                          <div className="font-semibold">{summary.prehistoricData.candlesProcessed}</div>
                          <div className="text-xs text-muted-foreground">Candles</div>
                        </div>
                      </div>
                    </div>
                  )}
                 
                 {/* Indications by Type */}
                 {summary.indicationsCounts && (
                   <div className="bg-green-50 rounded-lg p-4 mb-4">
                     <div className="font-medium mb-2">Indications by Type</div>
                     <div className="grid grid-cols-2 gap-3 text-sm">
                       <div>
                         <div className="font-semibold">{summary.indicationsCounts.direction}</div>
                         <div className="text-xs text-muted-foreground">Direction</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.indicationsCounts.move}</div>
                         <div className="text-xs text-muted-foreground">Move</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.indicationsCounts.active}</div>
                         <div className="text-xs text-muted-foreground">Active</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.indicationsCounts.optimal}</div>
                         <div className="text-xs text-muted-foreground">Optimal</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.indicationsCounts.auto}</div>
                         <div className="text-xs text-muted-foreground">Auto</div>
                       </div>
                     </div>
                   </div>
                 )}
                 
                 {/* Strategy Counts */}
                 {summary.strategyCounts && (
                   <div className="bg-purple-50 rounded-lg p-4 mb-4">
                     <div className="font-medium mb-2">Strategy Evaluation</div>
                     <div className="grid grid-cols-3 gap-3 text-sm">
                       <div>
                         <div className="font-semibold">{summary.strategyCounts.base.evaluated}</div>
                         <div className="text-xs text-muted-foreground">Base Evaluated</div>
                         <div className="text-xs">/{summary.strategyCounts.base.total}</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.strategyCounts.main.evaluated}</div>
                         <div className="text-xs text-muted-foreground">Main Evaluated</div>
                         <div className="text-xs">/{summary.strategyCounts.main.total}</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.strategyCounts.real.evaluated}</div>
                         <div className="text-xs text-muted-foreground">Real Evaluated</div>
                         <div className="text-xs">/{summary.strategyCounts.real.total}</div>
                       </div>
                     </div>
                   </div>
                 )}
                 
                 {/* Engine Performance */}
                 {summary.enginePerformance && (
                   <div className="bg-indigo-50 rounded-lg p-4 mb-4">
                     <div className="font-medium mb-2">Engine Performance</div>
                     <div className="grid grid-cols-4 gap-3 text-sm">
                       <div>
                         <div className="font-semibold">{summary.enginePerformance.cycleTimeMs}ms</div>
                         <div className="text-xs text-muted-foreground">Cycle Time</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.enginePerformance.cyclesCompleted}</div>
                         <div className="text-xs text-muted-foreground">Cycles</div>
                       </div>
                       <div>
                         <div className="font-semibold text-green-600">{summary.enginePerformance.successfulCycles}</div>
                         <div className="text-xs text-muted-foreground">Successful</div>
                       </div>
                       <div>
                         <div className="font-semibold text-red-600">{summary.enginePerformance.failedCycles}</div>
                         <div className="text-xs text-muted-foreground">Failed</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.enginePerformance.cycleSuccessRate.toFixed(1)}%</div>
                         <div className="text-xs text-muted-foreground">Success Rate</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.enginePerformance.totalTrades}</div>
                         <div className="text-xs text-muted-foreground">Trades</div>
                       </div>
                       <div>
                         <div className="font-semibold text-green-600">{summary.enginePerformance.successfulTrades}</div>
                         <div className="text-xs text-muted-foreground">Winning</div>
                       </div>
                       <div>
                         <div className="font-semibold">{summary.enginePerformance.tradeSuccessRate.toFixed(1)}%</div>
                         <div className="text-xs text-muted-foreground">Trade Success</div>
                       </div>
                     </div>
                   </div>
                 )}
               </>
             )}

            <Separator />

            {/* Logs */}
            <ScrollArea className="h-[420px] border rounded-lg p-4 bg-slate-50/60">
              {logs.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No logs available</p>
              ) : (
                <div className="space-y-2">
                  {logs.map((log, index) => (
                    <div key={index} className="p-3 border rounded-lg space-y-1 bg-white/90">
                      <div className="flex items-center gap-2 justify-between">
                        {getLevelBadge(log.level)}
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm font-medium leading-relaxed">{log.message}</p>
                      <div className="text-xs text-muted-foreground">Phase: {log.phase || "unknown"} • Source: {log.source || "runtime"}</div>
                      {log.details && (
                        <pre className="text-xs text-muted-foreground bg-muted p-2 rounded overflow-x-auto">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            {!!summary?.phases && Object.keys(summary.phases).length > 0 && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-sm font-medium">Detailed Breakdown</div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">By Phase</div>
                    <div className="space-y-1">
                      {Object.entries(summary.phases)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([phase, count]) => (
                          <div key={phase} className="flex items-center justify-between text-xs">
                            <span className="truncate pr-2">{phase}</span>
                            <Badge variant="outline">{count}</Badge>
                          </div>
                        ))}
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">Newest event:</span>{" "}
                      {summary.latestTimestamp ? new Date(summary.latestTimestamp).toLocaleString() : "N/A"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Oldest event:</span>{" "}
                      {summary.oldestTimestamp ? new Date(summary.oldestTimestamp).toLocaleString() : "N/A"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Connection:</span> {connectionName}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-4">
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
