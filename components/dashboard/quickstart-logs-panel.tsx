"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, RefreshCw, Copy, Download } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface ProgressionLogEntry {
  timestamp: string
  level: "info" | "warning" | "error" | "debug"
  phase: string
  message: string
  details?: Record<string, any>
  connectionId: string
}

interface QuickstartLogsPanelProps {
  connectionId?: string
  className?: string
}

interface ProgressionState {
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  successfulTrades: number
  totalProfit: number
  tradeSuccessRate?: number
  intervalsProcessed?: number
  indicationsCount?: number
  strategiesCount?: number
  strategyEvaluatedBase?: number
  strategyEvaluatedMain?: number
  strategyEvaluatedReal?: number
  prehistoricCyclesCompleted?: number
  prehistoricSymbolsProcessedCount?: number
  prehistoricCandlesProcessed?: number
  prehistoricDataSize?: number
  indicationEvaluatedDirection?: number
  indicationEvaluatedMove?: number
  indicationEvaluatedActive?: number
  indicationEvaluatedOptimal?: number
  setsBaseCount?: number
  setsMainCount?: number
  setsRealCount?: number
  setsTotalCount?: number
  redisDbEntries?: number
  redisDbSizeMb?: number
  processingCompleteness?: {
    prehistoricLoaded?: boolean
    indicationsRunning?: boolean
    strategiesRunning?: boolean
    realtimeRunning?: boolean
    hasErrors?: boolean
  }
}

export function QuickstartLogsPanel({ connectionId, className = "" }: QuickstartLogsPanelProps) {
  const [logs, setLogs] = useState<ProgressionLogEntry[]>([])
  const [progressionState, setProgressionState] = useState<ProgressionState | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchLogs = async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/connections/progression/${connectionId}/logs`)
      const data = await res.json()
      setLogs(Array.isArray(data.logs) ? data.logs : [])
      setProgressionState(data.progressionState || null)
    } catch (error) {
      console.error("Failed to fetch logs:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchLogs()
  }, [connectionId])

  const groupedLogs = useMemo(() => {
    const groups: Record<string, ProgressionLogEntry[]> = {
      overall: [],
      data: [],
      engine: [],
      errors: [],
    }

    for (const log of logs) {
      const phase = String(log.phase || "").toLowerCase()
      if (log.level === "error") {
        groups.errors.push(log)
      }
      if (["initializing", "engine_starting", "live_trading", "system"].some((k) => phase.includes(k))) {
        groups.overall.push(log)
      }
      if (["prehistoric", "realtime", "market"].some((k) => phase.includes(k))) {
        groups.data.push(log)
      }
      if (["indication", "strategy", "database", "interval"].some((k) => phase.includes(k))) {
        groups.engine.push(log)
      }
    }

    return groups
  }, [logs])

  const copyLogs = () => {
    const logText = logs.map((log) => `[${log.timestamp}] ${log.level.toUpperCase()} [${log.phase}] ${log.message}`).join("\n")
    navigator.clipboard.writeText(logText)
    toast.success("Logs copied to clipboard")
  }

  const downloadLogs = () => {
    const logText = logs.map((log) => `[${log.timestamp}] ${log.level.toUpperCase()} [${log.phase}] ${log.message}`).join("\n")
    const blob = new Blob([logText], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `progression-logs-${connectionId}.txt`
    a.click()
  }

  if (!connectionId) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-sm">Progression Logs</CardTitle>
          <CardDescription>Select a connection to view logs</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">Progression Logs</CardTitle>
            <CardDescription>{logs.length} entries</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={fetchLogs} disabled={loading}><RefreshCw className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" onClick={copyLogs} disabled={!logs.length}><Copy className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" onClick={downloadLogs} disabled={!logs.length}><Download className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {progressionState && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 text-xs">
              <Badge variant="outline">Cycles: {progressionState.cyclesCompleted || 0}</Badge>
              <Badge variant="outline">Success: {(progressionState.cycleSuccessRate || 0).toFixed(1)}%</Badge>
              <Badge variant="outline">Prehistoric keys: {progressionState.prehistoricDataSize || 0}</Badge>
              <Badge variant="outline">DB MB: {(progressionState.redisDbSizeMb || 0).toFixed(2)}</Badge>
            </div>

            <div className="rounded border p-2 text-xs space-y-2">
              <div className="font-medium text-muted-foreground">Under indications (cascading)</div>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">Dir {progressionState.indicationEvaluatedDirection || 0}</Badge>
                <Badge variant="secondary">Move {progressionState.indicationEvaluatedMove || 0}</Badge>
                <Badge variant="secondary">Active {progressionState.indicationEvaluatedActive || 0}</Badge>
                <Badge variant="secondary">Optimal {progressionState.indicationEvaluatedOptimal || 0}</Badge>
                <Badge variant="outline">Base/Main/Real sets {progressionState.setsBaseCount || 0}/{progressionState.setsMainCount || 0}/{progressionState.setsRealCount || 0}</Badge>
                {progressionState.processingCompleteness && (
                  <Badge variant={progressionState.processingCompleteness.hasErrors ? "destructive" : "outline"}>
                    phases P/I/S/R: {progressionState.processingCompleteness.prehistoricLoaded ? "1" : "0"}/
                    {progressionState.processingCompleteness.indicationsRunning ? "1" : "0"}/
                    {progressionState.processingCompleteness.strategiesRunning ? "1" : "0"}/
                    {progressionState.processingCompleteness.realtimeRunning ? "1" : "0"}
                  </Badge>
                )}
              </div>
            </div>
          </>
        )}

        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading logs...</div>
        ) : (
          <ScrollArea className="h-[320px] rounded border p-2">
            <div className="space-y-2 text-xs">
              {(["overall", "data", "engine", "errors"] as const).map((section) => (
                <details key={section} open={section === "errors"} className="rounded border bg-muted/20 px-2 py-1">
                  <summary className="cursor-pointer font-medium capitalize">{section} ({groupedLogs[section].length})</summary>
                  <div className="mt-2 space-y-1">
                    {groupedLogs[section].slice(0, 80).map((log, idx) => (
                      <details key={`${section}-${idx}`} className="rounded border bg-background px-2 py-1">
                        <summary className="cursor-pointer truncate">[{new Date(log.timestamp).toLocaleTimeString()}] {log.phase} - {log.message}</summary>
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{JSON.stringify(log.details || {}, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
