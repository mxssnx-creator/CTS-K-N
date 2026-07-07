"use client"

import { useEffect, useMemo, useState } from "react"
import { ExchangeStatistics } from "@/components/dashboard/exchange-statistics"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Waves } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useExchange } from "@/lib/exchange-context"

export const dynamic = 'force-dynamic'

export default function ActiveExchangePage() {
  const { activeConnections, selectedConnectionId, setSelectedConnectionId, loadActiveConnections, selectedConnection } = useExchange()
  const [loading, setLoading] = useState(true)
  const [engineStatus, setEngineStatus] = useState<any>(null)

  useEffect(() => {
    const loadConnections = async () => {
      try {
        setLoading(true)
        await loadActiveConnections()
      } catch (err) {
        console.error("Failed to load connections:", err)
      } finally {
        setLoading(false)
      }
    }

    loadConnections()
  }, [loadActiveConnections])

  useEffect(() => {
    const loadEngineStatus = async () => {
      try {
        const res = await fetch("/api/trade-engine/status", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()
        setEngineStatus(data)
      } catch (error) {
        console.error("Failed to load engine status:", error)
      }
    }

    loadEngineStatus()
    const interval = setInterval(loadEngineStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const runningConnections = useMemo(() => {
    const statusConnections = engineStatus?.connections || []
    return activeConnections.filter((connection: any) => {
      const statusMatch = statusConnections.find((statusConnection: any) => statusConnection.id === connection.id)
      return Boolean(statusMatch && statusMatch.status === "running")
    })
  }, [activeConnections, engineStatus])

  const effectiveConnection = selectedConnection || runningConnections[0] || activeConnections[0] || null

  useEffect(() => {
    if (!selectedConnectionId && effectiveConnection?.id) {
      setSelectedConnectionId(effectiveConnection.id)
    }
  }, [selectedConnectionId, effectiveConnection, setSelectedConnectionId])

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Active Exchange Statistics</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">Loading active connections...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (activeConnections.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Active Exchange Statistics</h1>
        </div>
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No active dashboard connection is enabled and running. Use Quick Start or enable a connection on the dashboard first.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Active Exchange Statistics</h1>
          <p className="text-muted-foreground mt-1">
          View detailed prehistoric analysis, market data, and trading metrics for the selected active running connection
          </p>
        </div>

        {!runningConnections.length && (
          <Alert>
            <Waves className="h-4 w-4" />
            <AlertDescription>
              No selected exchange is currently enabled and running. Start Quick Start or enable a dashboard connection to activate progression and statistics.
            </AlertDescription>
          </Alert>
        )}

      {/* Connection Selector */}
      <Card>
        <CardHeader>
          <CardTitle>Select Active Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={selectedConnectionId || undefined} onValueChange={setSelectedConnectionId}>
            <SelectTrigger className="w-full md:w-72">
              <SelectValue placeholder="Select a connection..." />
            </SelectTrigger>
            <SelectContent>
              {activeConnections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  <div className="flex items-center gap-2">
                      <span>{conn.name || conn.exchange}</span>
                      <Badge variant="outline" className="text-xs">
                        {conn.exchange}
                      </Badge>
                      {runningConnections.some((runningConn) => runningConn.id === conn.id) && (
                        <Badge className="text-xs">Running</Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-2">
            {activeConnections.length} active connection{activeConnections.length !== 1 ? "s" : ""} available
          </p>
        </CardContent>
      </Card>

      {/* Statistics Component */}
      {effectiveConnection ? (
        <ExchangeStatistics
          key={effectiveConnection.id}
          connectionId={effectiveConnection.id}
          connectionName={effectiveConnection.name || effectiveConnection.exchange}
        />
      ) : null}
    </div>
  )
}
