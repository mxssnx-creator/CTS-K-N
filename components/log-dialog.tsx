"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ChevronDown, ChevronRight, RefreshCw, Filter, X } from "lucide-react"

interface LogEntry {
  id: string
  timestamp: string
  level: "info" | "warn" | "error" | "debug"
  category: "prehistoric" | "websocket" | "indication" | "strategy" | "realtime" | "system" | "error"
  symbol: string | null
  message: string
  data?: Record<string, any>
  expandable?: boolean
  expandableData?: Record<string, any>
}

interface LogDialogProps {
  connectionId: string
  logs: LogEntry[]
  onRefresh?: () => void
}

export function LogDialog({ connectionId, logs, onRefresh }: LogDialogProps) {
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [filterLevel, setFilterLevel] = useState<string>("all")
  const [filterCategory, setFilterCategory] = useState<string>("all")
  const [filterSymbol, setFilterSymbol] = useState<string>("all")

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
      case "error": return "bg-red-500"
      case "warn": return "bg-yellow-500"
      case "info": return "bg-blue-500"
      case "debug": return "bg-gray-500"
      default: return "bg-gray-500"
    }
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "prehistoric": return "bg-purple-500"
      case "websocket": return "bg-green-500"
      case "indication": return "bg-blue-500"
      case "strategy": return "bg-orange-500"
      case "realtime": return "bg-cyan-500"
      case "system": return "bg-gray-500"
      case "error": return "bg-red-500"
      default: return "bg-gray-500"
    }
  }

  const filteredLogs = logs.filter(log => {
    if (filterLevel !== "all" && log.level !== filterLevel) return false
    if (filterCategory !== "all" && log.category !== filterCategory) return false
    if (filterSymbol !== "all" && log.symbol !== filterSymbol) return false
    return true
  })

  const symbols = Array.from(new Set(logs.map(l => l.symbol).filter(Boolean)))

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Engine Logs</CardTitle>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <div className="flex items-center gap-1">
            <Filter className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Filters:</span>
          </div>
          
          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          >
            <option value="all">All Levels</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
            <option value="debug">Debug</option>
          </select>

          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          >
            <option value="all">All Categories</option>
            <option value="prehistoric">Prehistoric</option>
            <option value="websocket">WebSocket</option>
            <option value="indication">Indication</option>
            <option value="strategy">Strategy</option>
            <option value="realtime">Realtime</option>
            <option value="system">System</option>
            <option value="error">Error</option>
          </select>

          <select
            value={filterSymbol}
            onChange={(e) => setFilterSymbol(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          >
            <option value="all">All Symbols</option>
            {symbols.map(sym => (
              <option key={sym as string} value={sym as string}>{sym as string}</option>
            ))}
          </select>

          {(filterLevel !== "all" || filterCategory !== "all" || filterSymbol !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilterLevel("all")
                setFilterCategory("all")
                setFilterSymbol("all")
              }}
              className="h-6 px-2 text-xs"
            >
              <X className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
        </div>

        {/* Log Count */}
        <div className="text-xs text-muted-foreground mb-2">
          Showing {filteredLogs.length} of {logs.length} logs
        </div>

        {/* Logs */}
        <ScrollArea className="h-[340px] pr-4">
          <div className="space-y-1">
            {filteredLogs.map((log) => (
              <div key={log.id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => log.expandable && toggleLog(log.id)}
                  className={`w-full px-3 py-2 flex items-start gap-2 hover:bg-muted/50 transition-colors text-left ${
                    log.expandable ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  {/* Level Badge */}
                  <Badge className={`${getLevelColor(log.level)} text-white text-xs shrink-0`}>
                    {log.level.toUpperCase()}
                  </Badge>

                  {/* Category Badge */}
                  <Badge className={`${getCategoryColor(log.category)} text-white text-xs shrink-0`}>
                    {log.category}
                  </Badge>

                  {/* Symbol Badge */}
                  {log.symbol && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      {log.symbol}
                    </Badge>
                  )}

                  {/* Message */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{log.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </div>
                  </div>

                  {/* Expand Icon */}
                  {log.expandable && (
                    <div className="shrink-0">
                      {expandedLogs.has(log.id) ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  )}
                </button>

                {/* Expandable Data */}
                {log.expandable && expandedLogs.has(log.id) && log.expandableData && (
                  <div className="px-3 py-2 bg-muted/30 border-t text-xs">
                    <pre className="whitespace-pre-wrap overflow-auto max-h-[200px]">
                      {JSON.stringify(log.expandableData, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
