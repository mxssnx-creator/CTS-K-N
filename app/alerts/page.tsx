"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Bell,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  Clock,
  DollarSign,
} from "lucide-react"
import { CreateAlertDialog } from "@/components/alerts/create-alert-dialog"
import { AlertHistoryTable } from "@/components/alerts/alert-history-table"
import { NotificationSettings } from "@/components/alerts/notification-settings"
import type { PriceAlert, PositionAlert, SystemAlert, AlertHistory } from "@/lib/types"

export default function AlertsPage() {
  const [activeTab, setActiveTab] = useState("price")
  const [hasRealConnections, setHasRealConnections] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([])
  const [positionAlerts, setPositionAlerts] = useState<PositionAlert[]>([])
  const [systemAlerts, setSystemAlerts] = useState<SystemAlert[]>([])
  const [alertHistory, setAlertHistory] = useState<AlertHistory[]>([])
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  useEffect(() => {
    const checkConnections = async () => {
      try {
        const response = await fetch("/api/settings/connections")
        const data = await response.json()
        const activeConnections = data.connections?.filter((c: any) => c.is_enabled) || []
        setHasRealConnections(activeConnections.length > 0)

        if (activeConnections.length === 0) {
          setPriceAlerts([
            {
              id: "pa-1",
              symbol: "BTCUSDT",
              condition: "above",
              price: 95000,
              current_price: 92450,
              is_enabled: true,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
            {
              id: "pa-2",
              symbol: "ETHUSDT",
              condition: "below",
              price: 3200,
              current_price: 3450,
              is_enabled: true,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
            {
              id: "pa-3",
              symbol: "SOLUSDT",
              condition: "above",
              price: 200,
              current_price: 185,
              is_enabled: false,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
          ])

          setPositionAlerts([
            {
              id: "poa-1",
              position_id: "pos-123",
              symbol: "BTCUSDT",
              alert_type: "profit_target",
              threshold: 5.0,
              current_value: 3.2,
              is_enabled: true,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
            {
              id: "poa-2",
              position_id: "pos-456",
              symbol: "ETHUSDT",
              alert_type: "stop_loss",
              threshold: -2.0,
              current_value: -1.5,
              is_enabled: true,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
            {
              id: "poa-3",
              position_id: "pos-789",
              symbol: "BNBUSDT",
              alert_type: "time_limit",
              threshold: 24,
              current_value: 18,
              is_enabled: true,
              created_at: new Date().toISOString(),
              triggered_at: null,
            },
          ])

          setSystemAlerts([
            {
              id: "sa-1",
              alert_type: "connection_lost",
              exchange: "Bybit",
              connection_id: "bybit-x03",
              severity: "high",
              message: "Connection to Bybit X03 lost",
              is_resolved: false,
              created_at: new Date(Date.now() - 3600000).toISOString(),
              resolved_at: null,
            },
            {
              id: "sa-2",
              alert_type: "high_drawdown",
              exchange: "BingX",
              connection_id: "bingx-x01",
              severity: "medium",
              message: "Portfolio drawdown exceeded 15%",
              is_resolved: true,
              created_at: new Date(Date.now() - 7200000).toISOString(),
              resolved_at: new Date(Date.now() - 3600000).toISOString(),
            },
          ])

          setAlertHistory([
            {
              id: "ah-1",
              alert_type: "price",
              symbol: "BTCUSDT",
              message: "BTC price reached $94,500 (above $94,000)",
              triggered_at: new Date(Date.now() - 1800000).toISOString(),
              acknowledged: true,
            },
            {
              id: "ah-2",
              alert_type: "position",
              symbol: "ETHUSDT",
              message: "Position profit reached 5% target",
              triggered_at: new Date(Date.now() - 3600000).toISOString(),
              acknowledged: true,
            },
            {
              id: "ah-3",
              alert_type: "system",
              symbol: null,
              message: "Trade engine started successfully",
              triggered_at: new Date(Date.now() - 7200000).toISOString(),
              acknowledged: false,
            },
          ])
        }
      } catch (error) {
        console.error("Failed to check connections:", error)
      } finally {
        setIsLoading(false)
      }
    }

    checkConnections()
  }, [])

  const handleTogglePriceAlert = (id: string, enabled: boolean) => {
    setPriceAlerts((prev) => prev.map((alert) => (alert.id === id ? { ...alert, is_enabled: enabled } : alert)))
  }

  const handleDeletePriceAlert = (id: string) => {
    setPriceAlerts((prev) => prev.filter((alert) => alert.id !== id))
  }

  const handleTogglePositionAlert = (id: string, enabled: boolean) => {
    setPositionAlerts((prev) => prev.map((alert) => (alert.id === id ? { ...alert, is_enabled: enabled } : alert)))
  }

  const handleDeletePositionAlert = (id: string) => {
    setPositionAlerts((prev) => prev.filter((alert) => alert.id !== id))
  }

  const handleResolveSystemAlert = (id: string) => {
    setSystemAlerts((prev) =>
      prev.map((alert) =>
        alert.id === id ? { ...alert, is_resolved: true, resolved_at: new Date().toISOString() } : alert,
      ),
    )
  }

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(price)
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "high":
        return "bg-red-500"
      case "medium":
        return "bg-yellow-500"
      case "low":
        return "bg-blue-500"
      default:
        return "bg-gray-500"
    }
  }

  const activeAlertsCount =
    priceAlerts.filter((a) => a.is_enabled).length +
    positionAlerts.filter((a) => a.is_enabled).length +
    systemAlerts.filter((a) => !a.is_resolved).length

  if (isLoading) {
    return (
      <div className="flex flex-col flex-1 overflow-auto">
        <div className="p-6">
          <div className="text-center py-12">
            <div className="text-muted-foreground">Loading alerts...</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-auto">
      <div className="p-6 space-y-6">
        {!hasRealConnections && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <div>
                <div className="font-semibold text-yellow-700 dark:text-yellow-400">Using Mock Data</div>
                <div className="text-sm text-yellow-600 dark:text-yellow-500">
                  No active exchange connections found. Enable a connection in Settings to see real alerts.
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Alert Management
            </h1>
            <p className="text-muted-foreground mt-1">Monitor price movements, positions, and system events</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="text-lg px-4 py-2">
              <Bell className="h-4 w-4 mr-2" />
              {activeAlertsCount} Active
            </Badge>
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Alert
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/10 rounded-lg">
                  <DollarSign className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{priceAlerts.filter((a) => a.is_enabled).length}</div>
                  <div className="text-sm text-muted-foreground">Price Alerts</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-500/10 rounded-lg">
                  <TrendingUp className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{positionAlerts.filter((a) => a.is_enabled).length}</div>
                  <div className="text-sm text-muted-foreground">Position Alerts</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-500/10 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{systemAlerts.filter((a) => !a.is_resolved).length}</div>
                  <div className="text-sm text-muted-foreground">System Alerts</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500/10 rounded-lg">
                  <Clock className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{alertHistory.length}</div>
                  <div className="text-sm text-muted-foreground">Total Triggered</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="price">Price Alerts</TabsTrigger>
            <TabsTrigger value="position">Position Alerts</TabsTrigger>
            <TabsTrigger value="system">System Alerts</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="price" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Price Alerts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {priceAlerts.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Bell className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p>No price alerts configured</p>
                    </div>
                  ) : (
                    priceAlerts.map((alert) => (
                      <Card key={alert.id}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4 flex-1">
                              <div className="flex items-center gap-2">
                                {alert.condition === "above" ? (
                                  <TrendingUp className="h-5 w-5 text-green-500" />
                                ) : (
                                  <TrendingDown className="h-5 w-5 text-red-500" />
                                )}
                                <div>
                                  <div className="font-semibold">{alert.symbol}</div>
                                  <div className="text-sm text-muted-foreground">
                                    Alert when price goes {alert.condition} {formatPrice(alert.price)}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-6 ml-auto">
                                <div>
                                  <div className="text-xs text-muted-foreground">Current Price</div>
                                  <div className="font-medium">{formatPrice(alert.current_price)}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-muted-foreground">Distance</div>
                                  <div className="font-medium">
                                    {(((alert.price - alert.current_price) / alert.current_price) * 100).toFixed(2)}%
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-3 ml-6">
                              <Switch
                                checked={alert.is_enabled}
                                onCheckedChange={(checked) => handleTogglePriceAlert(alert.id, checked)}
                              />
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    <Trash2 className="h-4 w-4 text-red-500" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete Alert</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Are you sure you want to delete this price alert for {alert.symbol}?
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => handleDeletePriceAlert(alert.id)}>
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="position" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Position Alerts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {positionAlerts.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Bell className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p>No position alerts configured</p>
                    </div>
                  ) : (
                    positionAlerts.map((alert) => (
                      <Card key={alert.id}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4 flex-1">
                              <div>
                                <div className="font-semibold">{alert.symbol}</div>
                                <div className="text-sm text-muted-foreground">
                                  {alert.alert_type === "profit_target" && `Profit Target: ${alert.threshold}%`}
                                  {alert.alert_type === "stop_loss" && `Stop Loss: ${alert.threshold}%`}
                                  {alert.alert_type === "time_limit" && `Time Limit: ${alert.threshold}h`}
                                </div>
                              </div>

                              <div className="flex items-center gap-6 ml-auto">
                                <div>
                                  <div className="text-xs text-muted-foreground">Current</div>
                                  <div className="font-medium">
                                    {alert.alert_type === "time_limit"
                                      ? `${alert.current_value}h`
                                      : `${alert.current_value}%`}
                                  </div>
                                </div>
                                <Badge
                                  variant={
                                    alert.alert_type === "profit_target"
                                      ? "default"
                                      : alert.alert_type === "stop_loss"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                >
                                  {alert.alert_type.replace("_", " ")}
                                </Badge>
                              </div>
                            </div>

                            <div className="flex items-center gap-3 ml-6">
                              <Switch
                                checked={alert.is_enabled}
                                onCheckedChange={(checked) => handleTogglePositionAlert(alert.id, checked)}
                              />
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    <Trash2 className="h-4 w-4 text-red-500" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete Alert</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Are you sure you want to delete this position alert?
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => handleDeletePositionAlert(alert.id)}>
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="system" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>System Alerts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {systemAlerts.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <CheckCircle className="h-12 w-12 mx-auto mb-4 opacity-50 text-green-500" />
                      <p>No system alerts - all systems operational</p>
                    </div>
                  ) : (
                    systemAlerts.map((alert) => (
                      <Card key={alert.id}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4 flex-1">
                              <div className={`h-3 w-3 rounded-full ${getSeverityColor(alert.severity)}`} />
                              <div>
                                <div className="font-semibold">
                                  {alert.exchange} - {alert.connection_id}
                                </div>
                                <div className="text-sm text-muted-foreground">{alert.message}</div>
                                <div className="text-xs text-muted-foreground mt-1">
                                  {new Date(alert.created_at).toLocaleString()}
                                </div>
                              </div>

                              <div className="ml-auto">
                                {alert.is_resolved ? (
                                  <Badge variant="outline" className="bg-green-500/10 text-green-600">
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                    Resolved
                                  </Badge>
                                ) : (
                                  <Badge variant="destructive">Active</Badge>
                                )}
                              </div>
                            </div>

                            {!alert.is_resolved && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleResolveSystemAlert(alert.id)}
                                className="ml-6"
                              >
                                Mark Resolved
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history">
            <AlertHistoryTable history={alertHistory} />
          </TabsContent>

          <TabsContent value="settings">
            <NotificationSettings />
          </TabsContent>
        </Tabs>

        <CreateAlertDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
      </div>
    </div>
  )
}
