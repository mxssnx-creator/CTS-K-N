"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RefreshCw, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"

export function SystemHealthCheck() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  const checkHealth = async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/system/verify-apis")
      const data = await response.json()
      setStatus(data)
    } catch (error) {
      setStatus({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkHealth()
  }, [])

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">System Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const { success, results } = status
  const allHealthy = success && results.system.connectionManager && results.system.tradeEngineCoordinator

  return (
    <Card className={allHealthy ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">System Health</CardTitle>
            <CardDescription className="text-xs">API and service status</CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={checkHealth} disabled={loading} className="h-8 w-8 p-0">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-2 text-sm">
        {/* Overall Status */}
        <div className="flex items-center justify-between p-2 bg-white rounded border">
          <span className="font-medium">Overall Status</span>
          <Badge className={allHealthy ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}>
            {allHealthy ? "Healthy" : "Issues Detected"}
          </Badge>
        </div>

        {/* System Components */}
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between p-2 rounded bg-white">
            <span className="flex items-center gap-2">
              {results.system.connectionManager ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-600" />
              )}
              ConnectionManager
            </span>
            <Badge variant="outline" className="text-xs">
              {results.system.connectionManager ? "OK" : "FAILED"}
            </Badge>
          </div>

          <div className="flex items-center justify-between p-2 rounded bg-white">
            <span className="flex items-center gap-2">
              {results.system.tradeEngineCoordinator ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-600" />
              )}
              TradeEngineCoordinator
            </span>
            <Badge variant="outline" className="text-xs">
              {results.system.tradeEngineCoordinator ? "OK" : "FAILED"}
            </Badge>
          </div>

          <div className="flex items-center justify-between p-2 rounded bg-white">
            <span className="flex items-center gap-2">
              {results.system.fileStorage ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-600" />
              )}
              FileStorage
            </span>
            <Badge variant="outline" className="text-xs">
              {results.system.fileStorage ? "OK" : "FAILED"}
            </Badge>
          </div>
        </div>

        {/* Connection Count */}
        {results.connections.count > 0 && (
          <div className="text-xs p-2 bg-white rounded">
            {results.connections.count} connection{results.connections.count !== 1 ? "s" : ""} configured
          </div>
        )}

        {/* Errors */}
        {results.connections.errors.length > 0 && (
          <div className="text-xs p-2 bg-red-100 text-red-900 rounded">
            <strong>Errors:</strong>
            <ul className="mt-1 ml-4 list-disc">
              {results.connections.errors.map((err: string, i: number) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
