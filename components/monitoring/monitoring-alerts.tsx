"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AlertCircle, AlertTriangle, Info, CheckCircle, X, RefreshCw } from "lucide-react"
import { toast } from "sonner"

interface Alert {
  id: string
  level: "critical" | "warning" | "info"
  category: string
  message: string
  timestamp: Date
  acknowledged: boolean
}

export function MonitoringAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const loadAlerts = async () => {
    setIsLoading(true)
    try {
      const response = await fetch("/api/monitoring/alerts")
      if (response.ok) {
        const data = await response.json()
        setAlerts(data.alerts || [])
      }
    } catch (error) {
      console.error("[v0] Failed to load alerts:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const acknowledgeAlert = async (alertId: string) => {
    try {
      const response = await fetch("/api/monitoring/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId }),
      })

      if (response.ok) {
        setAlerts(alerts.filter(a => a.id !== alertId))
        toast.success("Alert acknowledged")
      }
    } catch (error) {
      console.error("[v0] Failed to acknowledge alert:", error)
      toast.error("Failed to acknowledge alert")
    }
  }

  useEffect(() => {
    loadAlerts()
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadAlerts, 30000)
    return () => clearInterval(interval)
  }, [])

  const getAlertIcon = (level: Alert["level"]) => {
    switch (level) {
      case "critical":
        return <AlertCircle className="h-4 w-4 text-destructive" />
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-600" />
      case "info":
        return <Info className="h-4 w-4 text-blue-600" />
    }
  }

  const getAlertBadgeVariant = (level: Alert["level"]) => {
    switch (level) {
      case "critical":
        return "destructive"
      case "warning":
        return "secondary"
      case "info":
        return "default"
    }
  }

  const criticalCount = alerts.filter(a => a.level === "critical").length
  const warningCount = alerts.filter(a => a.level === "warning").length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5" />
              Active Alerts
            </CardTitle>
            <CardDescription>
              {alerts.length === 0 ? "No active alerts" : `${criticalCount} critical, ${warningCount} warnings`}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadAlerts}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle className="h-12 w-12 text-green-500 mb-3" />
            <p className="text-sm text-muted-foreground">All systems operating normally</p>
          </div>
        ) : (
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-start gap-3 p-3 border rounded-lg bg-card"
                >
                  <div className="mt-0.5">{getAlertIcon(alert.level)}</div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={getAlertBadgeVariant(alert.level)} className="text-xs">
                        {alert.level.toUpperCase()}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{alert.category}</span>
                    </div>
                    <p className="text-sm">{alert.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(alert.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => acknowledgeAlert(alert.id)}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
