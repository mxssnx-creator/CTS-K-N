"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus, Loader2 } from 'lucide-react'
import { toast } from "@/lib/simple-toast"
import type { Connection } from "@/lib/db-types"
import { AddConnectionDialog } from "@/components/settings/add-connection-dialog"
import { ConnectionCard } from "@/components/settings/connection-card"
import { BingXCredentialsDialog } from "@/components/settings/bingx-credentials-dialog"
import { useDashboardEvents, type DashboardEventPayload } from "@/lib/dashboard-events"
import { normalizeMarketType } from "@/lib/market-types"
import { isForexBridgeSelected } from "@/lib/forex-market"

const toBooleanFlag = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true"

export default function ExchangeConnectionManager() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [recentlyInsertedBase, setRecentlyInsertedBase] = useState<Set<string>>(new Set())
  const [showBingXCredentialsDialog, setShowBingXCredentialsDialog] = useState(false)
  const connectionLoadSequenceRef = useRef(0)

  // Default exchanges to display
  const DEFAULT_EXCHANGES = ["bybit", "bingx", "pionex", "orangex"]
  // Separate predefined (templates) from user-created connections
  const predefinedConnections = connections.filter((c: any) => c.is_predefined === true || c.is_predefined === "1")
  const userConnections = connections.filter((c: any) => !(c.is_predefined === true || c.is_predefined === "1"))

  // For display: show user-created connections + base inserted connections
  const displayedConnections = connections.filter((c: any) => {
    const exch = (c.exchange || "").toLowerCase()
    // Show if user-created OR any base exchange connection (keep all 4 base visible consistently)
    const isUserCreated = !(c.is_predefined === true || c.is_predefined === "1")
    const isBase = exch === "bybit" || exch === "bingx" || exch === "pionex" || exch === "orangex"
    return isUserCreated || isBase
  })

  const loadConnections = useCallback(async () => {
    const requestSequence = ++connectionLoadSequenceRef.current
    try {
      setLoading(true)
      setError(null)

      const response = await fetch(`/api/settings/connections?t=${Date.now()}`, { cache: "no-store" })
      if (!response.ok) throw new Error("Failed to load connections")

      const data = await response.json()
      if (requestSequence !== connectionLoadSequenceRef.current) return

      // Handle both array and object response formats
      let connectionsArray = Array.isArray(data) ? data : (data?.connections || [])

      if (!Array.isArray(connectionsArray)) {
        console.warn("Invalid connections format:", typeof connectionsArray)
        setConnections([])
        return
      }

      // Validate and normalize connections
      const validConnections = connectionsArray
        .filter((c: any) => {
          if (!c || typeof c !== "object") return false
          if (typeof c.id !== "string" || !c.id) return false
          if (typeof c.name !== "string" || !c.name) return false
          if (typeof c.exchange !== "string" || !c.exchange) return false
          return true
        })
        .map((c: any) => {
          const marketType = normalizeMarketType(c.market_type || c.asset_class, c.exchange)
          const forexBridgeSelected = marketType === "forex" && isForexBridgeSelected(c)
          return {
            ...c,
            market_type: marketType,
            asset_class: marketType,
            is_enabled: toBooleanFlag(c.is_enabled),
            is_inserted: toBooleanFlag(c.is_inserted),
            is_active_inserted: toBooleanFlag(c.is_active_inserted),
            is_enabled_dashboard: toBooleanFlag(c.is_enabled_dashboard),
            is_testnet: toBooleanFlag(c.is_testnet),
            is_live_trade: toBooleanFlag(c.is_live_trade),
            is_preset_trade: toBooleanFlag(c.is_preset_trade),
            is_active: toBooleanFlag(c.is_active),
            is_predefined: toBooleanFlag(c.is_predefined),
            volume_factor: MIN_VOLUME_FACTOR,
            margin_type: c.margin_type || "cross",
            position_mode: c.position_mode || "hedge",
            api_type: marketType === "forex" ? "forex" : c.api_type || "perpetual_futures",
            connection_method: marketType === "forex"
              ? (forexBridgeSelected ? "bridge" : "rest")
              : c.connection_method || (String(c.exchange).toLowerCase() === "bingx" ? "library" : "rest"),
            connection_library: marketType === "forex"
              ? (forexBridgeSelected ? "mt5-bridge" : "native-http")
              : c.connection_library || (String(c.exchange).toLowerCase() === "bingx" ? "sdk" : "native"),
          } as Connection
        })

      setConnections(validConnections)
    } catch (err) {
      console.error("[v0] Error loading connections:", err)
      if (requestSequence === connectionLoadSequenceRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load connections")
        setConnections([])
      }
    } finally {
      if (requestSequence === connectionLoadSequenceRef.current) setLoading(false)
    }
  }, [])

  const loadConnectionsEventRef = useRef(loadConnections)
  loadConnectionsEventRef.current = loadConnections
  const dashboardEventHandlers = useMemo(() => {
    const refresh = (payload: DashboardEventPayload) => {
      const canonicalType = String(payload.canonicalType || "")
      if (["strategy.stageChanged", "processing.progress", "position.updated", "indication.updated"].includes(canonicalType)) return
      void loadConnectionsEventRef.current()
    }
    return {
      "connection.updated": refresh,
      "settings.recoordinated": refresh,
    }
  }, [])
  useDashboardEvents("*", dashboardEventHandlers)

  useEffect(() => {
    void loadConnections()
    return () => { connectionLoadSequenceRef.current++ }
  }, [loadConnections])

  const testConnection = async (id: string) => {
    setTestingId(id)
    try {
      console.log("[v0] Testing connection:", id)
      
      const response = await fetch(`/api/settings/connections/${id}/test`, {
        method: "POST",
      })

      const data = await response.json()

      console.log("[v0] Test response status:", response.status, "data:", data)

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Test failed"
        console.error("[v0] Test API error:", errorMsg)
        throw new Error(errorMsg)
      }

      // Update connection with test results
      setConnections((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                last_test_status: data.success ? "success" : "failed",
                last_test_balance: data.balance,
                last_test_log: data.log || [],
              }
            : c
        )
      )

      toast.success(`Connection test successful! Balance: $${data.balance?.toFixed(2) || "0.00"}`)
    } catch (error) {
      console.error("[v0] Test error:", error)
      toast.error(error instanceof Error ? error.message : "Test failed")
    } finally {
      setTestingId(null)
    }
  }

  const handleDeleteConnection = async (id: string) => {
    try {
      const response = await fetch(`/api/settings/connections/${id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to delete")
      }

      // Refresh the connections list
      setConnections((prev) => prev.filter((c) => c.id !== id))
      await loadConnections()
      toast.success("Connection deleted")
    } catch (error) {
      console.error("[v0] Delete error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to delete connection")
    }
  }

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      // Find the connection to get current state
      const connection = connections.find(c => c.id === id)
      if (!connection) {
        toast.error("Connection not found")
        return
      }

      console.log("[v0] Toggling connection:", id, "enabled:", enabled)

      const response = await fetch(`/api/settings/connections/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled: enabled }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Failed to toggle connection"
        console.error("[v0] Toggle failed:", errorMsg)
        throw new Error(errorMsg)
      }

      dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
        connectionId: id,
        connection: { id, name: connection.name, exchange: connection.exchange },
        engine: { action: enabled ? "base-enable" : "base-disable" },
        source: "exchange-connection-manager.toggleConnection",
      }))

      // Update local state immediately
      setConnections((prev) =>
        prev.map((c) => 
          c.id === id 
            ? { ...c, is_enabled: enabled }
            : c
        )
      )

      toast.success(enabled ? "Connection enabled in Settings" : "Connection disabled in Settings")
      console.log("[v0] Base Settings toggle successful for:", id, "enabled:", enabled)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to toggle connection"
      console.error("[v0] Toggle error:", errorMsg)
      toast.error(errorMsg)
    }
  }

  const toggleDashboard = async (id: string, enabled: boolean) => {
    try {
      // Find the connection to get current state
      const connection = connections.find(c => c.id === id)
      if (!connection) {
        toast.error("Connection not found")
        return
      }

      console.log("[v0] [Dashboard] Toggling dashboard visibility for:", id, "visible:", enabled)

      const response = await fetch(`/api/settings/connections/${id}/toggle-dashboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled_dashboard: enabled }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Failed to toggle dashboard visibility"
        console.error("[v0] Dashboard toggle failed:", errorMsg)
        throw new Error(errorMsg)
      }

      dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
        connectionId: id,
        connection: { id, name: connection.name, exchange: connection.exchange },
        engine: { action: enabled ? "start" : "stop", status: data.engine?.status },
        source: "exchange-connection-manager.toggleDashboard",
      }))

      // Update local state immediately
      setConnections((prev) =>
        prev.map((c) => 
          c.id === id 
            ? { ...c, is_enabled_dashboard: enabled } 
            : c
        )
      )

      const t = data.changed ? (enabled ? "Connection now enabled in Main Connections" : "Connection disabled in Main Connections") : (enabled ? "Already enabled in Main Connections" : "Already disabled")
      toast.success(t)
      
      console.log("[v0] [Dashboard] Toggle successful for:", id, "is_enabled_dashboard:", enabled)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to toggle dashboard visibility"
      console.error("[v0] [Dashboard] Toggle error:", errorMsg)
      toast.error(errorMsg)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Base Connections</h3>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>
        <Card>
          <CardContent className="pt-6 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="ml-2">Loading connections...</span>
          </CardContent>
        </Card>
        <AddConnectionDialog 
          open={showAddDialog} 
          onOpenChange={setShowAddDialog} 
          onConnectionAdded={async (connectionId) => {
            console.log("[v0] Connection added:", connectionId)
            if (connectionId) {
              setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
              setTimeout(() => {
                setRecentlyInsertedBase((prev) => {
                  const next = new Set(prev)
                  next.delete(connectionId)
                  return next
                })
              }, 10000)
            }
            await loadConnections()
          }} 
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Base Connections</h3>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-red-700">{error}</p>
            <Button variant="outline" onClick={loadConnections} className="mt-4">
              Try Again
            </Button>
          </CardContent>
        </Card>
        <AddConnectionDialog 
          open={showAddDialog} 
          onOpenChange={setShowAddDialog} 
          onConnectionAdded={async (connectionId) => {
            console.log("[v0] Connection added:", connectionId)
            if (connectionId) {
              setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
              setTimeout(() => {
                setRecentlyInsertedBase((prev) => {
                  const next = new Set(prev)
                  next.delete(connectionId)
                  return next
                })
              }, 10000)
            }
            await loadConnections()
          }} 
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-lg">Base Connections</h3>
            <p className="text-sm text-muted-foreground">
              Configure API credentials and connection settings. These are base configurations independent of Main Connections (Active Connections).
            </p>
          </div>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>

        {displayedConnections.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground mb-4">No default connections configured yet</p>
              <Button onClick={() => setShowAddDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create First Connection
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {displayedConnections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn as any}
                onToggle={() => toggleEnabled(conn.id, !conn.is_enabled)}
                onActivate={() => toggleDashboard(conn.id, !toBooleanFlag((conn as any).is_enabled_dashboard))}
                onDelete={() => handleDeleteConnection(conn.id)}
                onEdit={(settings) => {
                  // Handle edit
                  loadConnections()
                }}
                onShowDetails={() => {
                  // Show details
                }}
                onShowLogs={() => {
                  // Show logs
                }}
                onTestConnection={(logs) => {
                  // Connection tested
                }}
                isNewlyAdded={recentlyInsertedBase.has(conn.id)}
              />
            ))}
          </div>
        )}
      </div>

      <AddConnectionDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
        onConnectionAdded={async (connectionId) => {
          console.log("[v0] Connection added:", connectionId)
          // Mark as newly added for auto-test
          if (connectionId) {
            setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
            // Clear the flag after 10 seconds
            setTimeout(() => {
              setRecentlyInsertedBase((prev) => {
                const next = new Set(prev)
                next.delete(connectionId)
                return next
              })
            }, 10000)
          }
          await loadConnections()
        }} 
      />

      <BingXCredentialsDialog
        open={showBingXCredentialsDialog}
        onOpenChange={setShowBingXCredentialsDialog}
        onSuccess={() => {
          // Reload connections after credentials are saved
          loadConnections()
        }}
      />
    </div>
  )
}
