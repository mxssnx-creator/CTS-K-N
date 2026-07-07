"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface AddActiveConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectionAdded?: (connectionId?: string) => Promise<void> | void
  onSuccess?: (connectionId?: string) => void
}

export function AddActiveConnectionDialog({
  open,
  onOpenChange,
  onConnectionAdded,
  onSuccess,
}: AddActiveConnectionDialogProps) {
  const [selectedConnection, setSelectedConnection] = useState<string>("")
  const [availableConnections, setAvailableConnections] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (open) {
      loadConnections()
    }
  }, [open])

  const loadConnections = async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/settings/connections", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      })
      if (!response.ok) {
        toast.error("Failed to load connections")
        return
      }

      const data = await response.json()
      
      // Handle both array and object response formats
      let allConnections = Array.isArray(data) ? data : (data?.connections || data?.data || [])
      
      if (!Array.isArray(allConnections)) {
        toast.error("Invalid connections format received")
        return
      }

      // Filter to show connections that are:
      // 1. Enabled in Settings (is_enabled=1) — any exchange including user-created
      // 2. Not yet added to Active panel (is_active_inserted=0 AND is_dashboard_inserted=0)
      // This includes base exchange predefined templates AND user-created connections
      const KNOWN_BASE_EXCHANGES = ["bybit", "bingx", "binance", "okx", "pionex", "orangex", "gateio", "kucoin", "mexc", "bitget", "huobi"]
      const availableForAdd = allConnections.filter((c: any) => {
        const exchange = (c.exchange || "").toLowerCase().trim()
        const isKnownExchange = KNOWN_BASE_EXCHANGES.includes(exchange)
        const isUserCreated = c.is_predefined === false || c.is_predefined === "0" || c.is_predefined === "false"
        const isEnabled = c.is_enabled === true || c.is_enabled === "1" || c.is_enabled === "true"
        const alreadyInActivePanel = c.is_active_inserted === true || c.is_active_inserted === "1" ||
                                      c.is_dashboard_inserted === true || c.is_dashboard_inserted === "1"
        
        // Show connections that are enabled, not yet in Active panel, and either known exchange or user-created
        return (isKnownExchange || isUserCreated) && isEnabled && !alreadyInActivePanel
      })

      setAvailableConnections(availableForAdd)

      if (availableForAdd.length > 0 && !selectedConnection) {
        setSelectedConnection(availableForAdd[0].id || "")
      }
    } catch (error) {
      console.error("[AddDialog] Error loading connections:", error)
      toast.error("Failed to load connections")
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async () => {
    if (!selectedConnection) {
      toast.error("Please select a connection")
      return
    }

    const connection = availableConnections.find((c: any) => c.id === selectedConnection)
    if (!connection) {
      toast.error("Connection not found")
      return
    }

    setAdding(true)
    try {
      // Add connection to Active panel (disabled by default — user must toggle Enable)
      // The /active POST route sets is_active_inserted=1, is_dashboard_inserted=1, is_enabled_dashboard=0
      const assignRes = await fetch(`/api/settings/connections/${selectedConnection}/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      if (!assignRes.ok) {
        const errData = await assignRes.json().catch(() => ({}))
        throw new Error(errData.error || "Failed to add connection to active panel")
      }

      toast.success(`${connection.name} added to active list`)
      
      // Wait a moment for backend to update
      await new Promise(resolve => setTimeout(resolve, 500))

      if (onConnectionAdded) await onConnectionAdded(selectedConnection)
      if (onSuccess) onSuccess(selectedConnection)

      onOpenChange(false)
      setSelectedConnection("")
    } catch (error: any) {
      console.error("[AddDialog] Error adding connection:", error)
      toast.error(error.message || "Failed to add connection")
    } finally {
      setAdding(false)
    }
  }

  const selectedConn = availableConnections.find((c: any) => c.id === selectedConnection)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Connection to Active List</DialogTitle>
          <DialogDescription>
            Select an inserted and enabled connection with valid credentials to add to your active trading dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center p-6">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading connections...
            </div>
          ) : availableConnections.length > 0 ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="connection-select" className="font-medium text-sm">
                  Available Connections (Enabled in Settings)
                </Label>
                <Select value={selectedConnection} onValueChange={setSelectedConnection}>
                  <SelectTrigger id="connection-select">
                    <SelectValue placeholder="Select a connection..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableConnections.map((conn: any) => (
                      <SelectItem key={conn.id} value={conn.id || ""}>
                        {conn.name} ({conn.exchange})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedConn && (
                <Card className="border-green-200 bg-green-50/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Connection Details</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs space-y-1">
                    <div><strong>ID:</strong> {selectedConn.id || "—"}</div>
                    <div><strong>Name:</strong> {selectedConn.name || "—"}</div>
                    <div><strong>Exchange:</strong> {selectedConn.exchange || "—"}</div>
                    <div><strong>API Type:</strong> {selectedConn.api_type || "perpetual_futures"}</div>
                    <div><strong>Test Status:</strong> {selectedConn.last_test_status === "success" ? "✓ Passed" : "— Not tested"}</div>
                  </CardContent>
                </Card>
              )}

              <Card className="border-blue-200 bg-blue-50/50">
                <CardContent className="pt-4 text-xs">
                  <p className="text-blue-900 font-semibold mb-2">About Active List:</p>
                  <ul className="text-blue-800 space-y-1">
                    <li>• Added in inactive state (toggle off)</li>
                    <li>• Enable Live Trade toggle to start Main Engine</li>
                    <li>• Enable Preset Trade toggle to start Preset Engine</li>
                  </ul>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card className="border-yellow-200 bg-yellow-50">
              <CardContent className="pt-4">
                <div className="flex gap-2">
                  <AlertCircle className="h-4 w-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-yellow-800">
                    <p className="font-medium mb-2">No Available Connections</p>
                    <p className="text-xs mb-3">
                      You need to add a real exchange connection first. The connections shown in Settings are predefined templates.
                    </p>
                    <div className="text-xs space-y-1">
                      <p className="font-medium">To add a connection:</p>
                      <ol className="list-decimal list-inside space-y-0.5 ml-1">
                        <li>Go to Settings → Overall → Connections</li>
                        <li>Click "Add Connection"</li>
                        <li>Enter your real API credentials</li>
                        <li>Save and test the connection</li>
                        <li>Return here to add it to Active List</li>
                      </ol>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={!selectedConnection || adding || availableConnections.length === 0}
          >
            {adding ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding...
              </>
            ) : (
              "Add to Active List"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
