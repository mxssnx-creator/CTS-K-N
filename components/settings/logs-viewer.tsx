"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ExternalLink, RefreshCw, Download } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface LogEntry {
  id: number
  level: string
  category: string
  message: string
  details?: string
  timestamp: string
}

export function LogsViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [level, setLevel] = useState("all")
  const [category, setCategory] = useState("all")
  const [limit, setLimit] = useState("100")

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        level: level !== "all" ? level : "",
        category: category !== "all" ? category : "",
        limit,
      })
      const response = await fetch(`/api/monitoring/logs?${params}`)
      const data = await response.json()
      setLogs(Array.isArray(data.logs) ? data.logs : (data.logs || []))
    } catch (error) {
      console.error("Failed to fetch logs:", error)
      setLogs([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [level, category, limit])

  const getJsonEndpoint = () => {
    const params = new URLSearchParams({
      level: level !== "all" ? level : "",
      category: category !== "all" ? category : "",
      limit,
    })
    return `/api/monitoring/logs?${params}`
  }

  const getLevelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case "error":
        return "destructive"
      case "warn":
        return "secondary" // Changed from "warning" to "secondary"
      case "info":
        return "default"
      case "debug":
        return "outline"
      default:
        return "outline"
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>System Logs</CardTitle>
            <CardDescription>View and export system logs for debugging and monitoring</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={getJsonEndpoint()} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" />
                JSON Endpoint
              </a>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Level</label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="warn">Warning</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="debug">Debug</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Category</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="trade">Trade</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="api">API</SelectItem>
                <SelectItem value="database">Database</SelectItem>
                <SelectItem value="connection">Connection</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Limit</label>
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50 logs</SelectItem>
                <SelectItem value="100">100 logs</SelectItem>
                <SelectItem value="500">500 logs</SelectItem>
                <SelectItem value="1000">1000 logs</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* JSON Endpoint Info */}
        <div className="p-4 bg-muted rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">JSON Endpoint URL:</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(window.location.origin + getJsonEndpoint())
              }}
            >
              Copy URL
            </Button>
          </div>
          <code className="text-xs block p-2 bg-background rounded border break-all">
            {typeof window !== "undefined" ? window.location.origin : ""}
            {getJsonEndpoint()}
          </code>
          <p className="text-xs text-muted-foreground">
            Use this endpoint to fetch logs programmatically or integrate with external monitoring tools
          </p>
        </div>

        {/* Logs List */}
        <div className="border rounded-lg">
          <div className="max-h-[400px] overflow-y-auto">
            {logs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {loading ? "Loading logs..." : "No logs found"}
              </div>
            ) : (
              <div className="divide-y">
                {logs.map((log) => (
                  <div key={log.id} className="p-3 hover:bg-muted/50 transition-colors">
                    <div className="flex items-start gap-3">
                      <Badge variant={getLevelColor(log.level)} className="mt-0.5">
                        {log.level}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground">{log.category}</span>
                          <span className="text-xs font-medium text-muted-foreground">
                            {new Date(log.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm break-words">{log.message}</p>
                        {log.details && (
                          <details className="mt-2">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              View details
                            </summary>
                            <pre className="mt-2 text-xs p-2 bg-muted rounded overflow-x-auto">
                              {typeof log.details === "string" ? log.details : JSON.stringify(log.details, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {logs.length} log entries</span>
          <Button variant="outline" size="sm" asChild>
            <a href={getJsonEndpoint()} download="logs.json">
              <Download className="w-4 h-4 mr-2" />
              Download JSON
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
