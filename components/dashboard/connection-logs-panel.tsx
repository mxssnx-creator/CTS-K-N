"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"

interface LogEntry {
  timestamp: string
  level: "info" | "error" | "warning" | "debug"
  message: string
  connectionId?: string
}

interface ConnectionLogsPanelProps {
  connectionId: string
  autoRefresh?: boolean
}

export function ConnectionLogsPanel({ connectionId, autoRefresh = true }: ConnectionLogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const response = await fetch(`/api/connections/${connectionId}/logs`)
        if (response.ok) {
          const data = await response.json()
          setLogs(data.logs || [])
        }
      } catch {
        // non-critical
      } finally {
        setLoading(false)
      }
    }

    fetchLogs()

    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 3000)
      return () => clearInterval(interval)
    }
  }, [connectionId, autoRefresh])

  const getLevelBadgeVariant = (level: string) => {
    switch (level) {
      case "error":
        return "destructive"
      case "warning":
        return "secondary"
      case "debug":
        return "outline"
      default:
        return "default"
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-sm">Live Connection Logs</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading logs...</div>
        ) : logs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No logs available yet</div>
        ) : (
          <ScrollArea className="h-64 w-full border rounded-lg p-4">
            <div className="space-y-2">
              {logs.map((log, idx) => (
                <div key={idx} className="flex gap-2 items-start text-xs font-mono">
                  <Badge variant={getLevelBadgeVariant(log.level)} className="shrink-0 uppercase">
                    {log.level}
                  </Badge>
                  <span className="text-muted-foreground">{log.timestamp}</span>
                  <span className="flex-1 break-words">{log.message}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
