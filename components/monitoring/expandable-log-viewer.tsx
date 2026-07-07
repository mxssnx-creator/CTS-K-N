"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronRight, DollarSign } from "lucide-react"
import { cn } from "@/lib/utils"

interface LogEntry {
  id: string
  level: "info" | "warning" | "error" | "debug"
  category: string
  message: string
  details?: string
  balance?: number
  timestamp: string
}

interface ExpandableLogViewerProps {
  logs: LogEntry[]
  title?: string
  description?: string
}

export function ExpandableLogViewer({ logs, title = "System Logs", description }: ExpandableLogViewerProps) {
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())

  const toggleLog = (id: string) => {
    const newExpanded = new Set(expandedLogs)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedLogs(newExpanded)
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "bg-red-500"
      case "warning":
        return "bg-yellow-500"
      case "info":
        return "bg-blue-500"
      case "debug":
        return "bg-gray-500"
      default:
        return "bg-gray-400"
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No logs available</p>
            </div>
          ) : (
            logs.map((log) => {
              const isExpanded = expandedLogs.has(log.id)
              const hasDetails = Boolean(log.details)
              const hasBalance = typeof log.balance === "number"

              return (
                <div
                  key={log.id}
                  className={cn(
                    "border rounded-lg p-3 transition-colors",
                    isExpanded && "bg-muted/50",
                    hasDetails && "cursor-pointer hover:bg-muted/30",
                  )}
                  onClick={() => hasDetails && toggleLog(log.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      {hasDetails && (
                        <button className="mt-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </button>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge className={cn("text-xs", getLevelColor(log.level))}>{log.level}</Badge>
                          <Badge variant="outline" className="text-xs">
                            {log.category}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(log.timestamp).toLocaleString()}
                          </span>
                        </div>

                        <p className="mt-1 text-sm font-medium break-words">{log.message}</p>

                        {isExpanded && hasDetails && (
                          <div className="mt-3 p-3 bg-muted rounded-md">
                            <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">{log.details}</pre>
                          </div>
                        )}
                      </div>
                    </div>

                    {hasBalance && log.balance !== undefined && (
                      <div className="flex items-center gap-1 flex-shrink-0 text-sm font-semibold text-green-600">
                        <DollarSign className="h-4 w-4" />
                        {log.balance.toFixed(2)}
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
