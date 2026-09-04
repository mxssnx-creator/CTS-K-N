"use client"

import { useEffect, useMemo, useState } from "react"
import { ExchangeStatistics } from "@/components/dashboard/exchange-statistics"
import { MarginCallPanel } from "@/components/settings/margin-call-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Waves } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useExchange } from "@/lib/exchange-context"
import { PageLoading, PageState } from "@/components/page-scaffold"

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
      <div className="page-section">
        <PageLoading label="Loading active exchange connections…" />
      </div>
    )
  }

  if (activeConnections.length === 0) {
    return (
      <div className="page-section">
        <PageState
          icon={AlertCircle}
          title="No active exchange connection"
          description="Enable a dashboard connection or start Quick Start before opening exchange-specific prehistoric data and statistics."
        />
      </div>
    )
  }

  return (
    <div className="page-section space-y-5">
      {!runningConnections.length && (
        <Alert>
          <Waves className="h-4 w-4" />
          <AlertDescription>
            No selected exchange is currently enabled and running. Start Quick Start or enable a dashboard connection to activate progression and statistics.
          </AlertDescription>
        </Alert>
      )}

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

      {effectiveConnection ? (
        <MarginCallPanel key={`margin-${effectiveConnection.id}`} connectionId={effectiveConnection.id} />
      ) : null}
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
