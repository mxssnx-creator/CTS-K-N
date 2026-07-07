"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Power, Trash2, Settings, ChevronDown, Loader2, AlertCircle, CheckCircle2, Edit2, Lock, Eye, EyeOff } from "lucide-react"
import { useState, useEffect } from "react"
import { toast } from "@/lib/simple-toast"
import { isHTMLResponse, parseHTMLResponse, parseCloudflareError } from "@/lib/html-response-parser"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ExchangeConnection } from "@/lib/types"

export type { ExchangeConnection }
import {
  EXCHANGE_CONNECTION_METHODS,
  CONNECTION_METHODS,
  EXCHANGE_LIBRARY_PACKAGES,
} from "@/lib/connection-predefinitions"

interface ConnectionCardProps {
  connection: ExchangeConnection
  onToggle: () => void
  onActivate: () => void
  onDelete: () => void
  onEdit?: (settings: Partial<ExchangeConnection>) => void
  onShowDetails?: () => void
  onShowLogs?: () => void
  onTestConnection?: (logs: string[]) => void
  isNewlyAdded?: boolean
}

export function ConnectionCard({
  connection,
  onToggle,
  onActivate,
  onDelete,
  onEdit,
  onShowDetails,
  onShowLogs,
  onTestConnection,
  isNewlyAdded = false,
}: ConnectionCardProps) {
  const exchange = (connection.exchange || "").toLowerCase().trim()
  const isInserted = Boolean(connection.is_inserted)
  const isEnabled = Boolean(connection.is_enabled)
  const [testingConnection, setTestingConnection] = useState(false)
  const [workingStatus, setWorkingStatus] = useState<"idle" | "testing" | "success" | "error">("idle")
  const [testLogs, setTestLogs] = useState<string[]>([])
  const [showTestLogInstant, setShowTestLogInstant] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editDialogTab, setEditDialogTab] = useState("basic")
  const [engineError, setEngineError] = useState<string>("")
  const [savingSettings, setSavingSettings] = useState(false)
  const [editFormData, setEditFormData] = useState({
    api_key: connection.api_key,
    api_secret: connection.api_secret,
    name: connection.name,
    api_type: connection.api_type,
    api_subtype: connection.api_subtype,
    connection_method: connection.connection_method,
    connection_library: connection.connection_library || "native",
    margin_type: connection.margin_type,
    position_mode: connection.position_mode,
    is_testnet: false, // ALWAYS MAINNET - force to false
    api_passphrase: connection.api_passphrase || "",
    order_type: "market",
    order_volume_usdt: 100,
  })

  // Auto-set connection library based on connection method when editFormData changes
  useEffect(() => {
    let defaultLibrary = "native"
    if (editFormData.connection_method === "rest") {
      defaultLibrary = "native"
    } else if (editFormData.connection_method === "websocket") {
      defaultLibrary = "native"
    } else if (editFormData.connection_method === "library") {
      defaultLibrary = "original"
    }

    if (editFormData.connection_library !== defaultLibrary) {
      setEditFormData(prev => ({ ...prev, connection_library: defaultLibrary }))
    }
  }, [editFormData.connection_method])



  // Define handleTestConnection first so it can be used in useEffect
  const handleTestConnection = async () => {
    setTestingConnection(true)
    setWorkingStatus("testing")

    console.log("[v0] [Test Connection] Testing with EDITED form values (not stored connection):", {
      exchange: connection.exchange,
      api_type: editFormData.api_type,
      api_subtype: editFormData.api_subtype,
      connection_method: editFormData.connection_method,
      connection_library: editFormData.connection_library,
      is_testnet: editFormData.is_testnet,
    })
    console.log("[v0] [Test Connection] Stored connection values (for comparison):", {
      api_type: connection.api_type,
      api_subtype: connection.api_subtype,
    })

    try {
      // Get connection ID from props
      const connId = connection?.id
      if (!connId) {
        toast.error("Connection ID not found")
        console.log("[v0] Connection object:", connection)
        return
      }

      console.log("[v0] Testing connection with ID:", connId)

      const response = await fetch(`/api/settings/connections/${connId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: connection.exchange,
          api_type: editFormData.api_type || "perpetual_futures",
          api_subtype: editFormData.api_subtype,
          connection_method: editFormData.connection_method || "rest",
          connection_library: editFormData.connection_library || "native",
          api_key: editFormData.api_key || "",
          api_secret: editFormData.api_secret || "",
          api_passphrase: editFormData.api_passphrase || "",
          is_testnet: editFormData.is_testnet || false,
        }),
      })

      const contentType = response.headers.get("content-type") || ""
      let data
      const responseText = await response.text()

      // Try to parse response
      if (contentType.includes("application/json")) {
        try {
          data = JSON.parse(responseText)
        } catch (parseError) {
          console.error("[v0] Failed to parse JSON response:", parseError)
          throw new Error("Server returned invalid response. Check API status.")
        }
      } else if (isHTMLResponse(contentType, responseText)) {
        // Server returned HTML error page
        console.error("[v0] Server returned HTML error response. Status:", response.status)
        
        let errorMsg = `Server Error (HTTP ${response.status})`
        if (responseText.includes("Cloudflare") || responseText.includes("cf-error")) {
          const cfError = parseCloudflareError(responseText)
          errorMsg = `Cloudflare (${cfError.code}): ${cfError.message}`
        } else {
          const parsed = parseHTMLResponse(responseText)
          errorMsg = parsed.message
        }
        
        setWorkingStatus("error")
        toast.error("Connection Error", {
          description: errorMsg,
        })
        setLogsExpanded(true)
        setTestingConnection(false)
        return
      } else {
        throw new Error("Unexpected response format from server")
      }

      if (data.error) {
        setWorkingStatus("error")
        toast.error("Connection Test Failed", {
          description: data.error || "Failed to test connection",
        })
        setTestLogs(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
        setShowTestLogInstant(true)
        setLogsExpanded(true)
        onTestConnection?.(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
        return
      }

      if (!response.ok || !data.success) {
        setWorkingStatus("error")
        toast.error("Connection Test Failed", {
          description: data.error || data.message || "Failed to test connection",
        })
        setTestLogs(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
        setShowTestLogInstant(true)
        setLogsExpanded(true)
        onTestConnection?.(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
        return
      }

      setWorkingStatus("success")
      toast.success("Connection Test Successful", {
        description: `Balance: ${data.balance?.toFixed(2) || "N/A"} USDT | API Type: ${data.apiType}${data.apiSubtype ? ` (${data.apiSubtype})` : ""}`,
      })
      setTestLogs(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
      setShowTestLogInstant(true)
      setLogsExpanded(true)
      onTestConnection?.(Array.isArray(data.log) ? data.log : (data.log ? [data.log] : []))
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      setWorkingStatus("error")
      toast.error("Test Connection Error", {
        description: errorMsg,
      })
      setTestLogs([errorMsg])
      setShowTestLogInstant(true)
      setLogsExpanded(true)
    } finally {
      setTestingConnection(false)
    }
  }

  // Auto-test disabled - users should manually click "Test Connection"
  // This prevents infinite loops when connection tests fail repeatedly

  const handleSaveSettings = async () => {
    if (!editFormData.api_key || !editFormData.api_secret) {
      toast.error("Validation Error", {
        description: "API key and secret are required",
      })
      return
    }

    setSavingSettings(true)
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: editFormData.api_key,
          api_secret: editFormData.api_secret,
          api_passphrase: editFormData.api_passphrase,
          name: editFormData.name,
          api_type: editFormData.api_type,
          ...(editFormData.api_type === "unified" && { api_subtype: editFormData.api_subtype }),
          connection_method: editFormData.connection_method,
          connection_library: editFormData.connection_library,
          margin_type: editFormData.margin_type,
          position_mode: editFormData.position_mode,
          is_testnet: editFormData.is_testnet,
          order_type: editFormData.order_type,
          order_volume_usdt: editFormData.order_volume_usdt,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to update connection settings")
      }

      toast.success("Settings Updated", {
        description: "Connection settings have been saved successfully",
      })

      onEdit?.(editFormData)
      setEditDialogOpen(false)
    } catch (error) {
      toast.error("Update Failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const getStatusColor = (status?: string) => {
    switch (status) {
      case "success":
        return "bg-green-50 border-green-200 text-green-900"
      case "failed":
        return "bg-red-50 border-red-200 text-red-900"
      case "warning":
        return "bg-yellow-50 border-yellow-200 text-yellow-900"
      default:
        return "bg-gray-50 border-gray-200 text-gray-900"
    }
  }

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "failed":
        return <AlertCircle className="h-4 w-4 text-red-600" />
      case "warning":
        return <AlertCircle className="h-4 w-4 text-yellow-600" />
      default:
        return null
    }
  }

  const credentialsConfigured =
    connection.api_key && connection.api_key !== "" && !connection.api_key.includes("PLACEHOLDER")

  return (
    <>
      <Card className="border border-border p-6">
        {/* Main Content - Horizontal Layout */}
        <div className="space-y-4">
          {/* Header Row */}
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-bold text-base">{connection.name}</h3>
                <Badge variant="secondary" className="text-xs">
                  {connection.exchange.toUpperCase()}
                </Badge>
                {connection.is_testnet && (
                  <Badge className="text-xs bg-blue-100 text-blue-900">Testnet</Badge>
                )}
                {/* Status Badge */}
                <Badge 
                  className={`text-xs ${
                    isEnabled
                      ? "bg-green-100 text-green-900 border-green-200" 
                      : "bg-gray-100 text-gray-600 border-gray-200"
                  }`}
                >
                  {isEnabled ? "Active" : "Inactive"}
                </Badge>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">
                  API Type: <span className="text-foreground font-medium">
                    {connection.api_type}
                    {connection.api_type === "unified" && connection.api_subtype && ` (${connection.api_subtype})`}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Margin: <span className="text-foreground font-medium">{connection.margin_type}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditDialogOpen(true)}
                className="flex items-center gap-2"
              >
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </Button>
              <div className="flex items-center justify-end gap-3">
                <span className="text-sm text-muted-foreground">
                  {isEnabled ? "Enabled" : "Disabled"}
                </span>
                <Button
                  size="sm"
                  variant={isEnabled ? "default" : "outline"}
                  onClick={onToggle}
                  className="w-14"
                  title={isEnabled ? "Disable" : "Enable"}
                >
                  <Power className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Info Row */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Method: </span>
              <span className="font-medium">{connection.connection_method}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Position: </span>
              <span className="font-medium">{connection.position_mode}</span>
            </div>
          </div>

          {/* Credentials Warning */}
          {!credentialsConfigured && (
            <div className="text-xs p-3 bg-yellow-50 text-yellow-800 rounded border border-yellow-200">
              API credentials not configured. Please add your API key and secret to test this connection.
            </div>
          )}

          {/* Test Result */}
          {connection.last_test_status && (
            <div className={`p-3 rounded border flex items-start gap-3 ${getStatusColor(connection.last_test_status)}`}>
              <div className="flex-shrink-0 mt-0.5">{getStatusIcon(connection.last_test_status)}</div>
              <div className="flex-1">
                <div className="font-medium text-sm">
                  {connection.last_test_status === "success" ? "Connection Active" : "Connection Failed"}
                </div>
                {connection.last_test_balance !== undefined && (
                  <div className="text-xs mt-1">Balance: ${Number(connection.last_test_balance).toFixed(4)} USDT</div>
                )}
                {connection.last_test_btc_price !== undefined && Number(connection.last_test_btc_price) > 0 && (
                  <div className="text-xs mt-1">BTC Price: ${Number(connection.last_test_btc_price).toFixed(2)}</div>
                )}
                {connection.last_test_at && (
                  <div className="text-xs mt-1">
                    Last tested: {new Date(connection.last_test_at).toLocaleDateString()} at{" "}
                    {new Date(connection.last_test_at).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action Buttons Row */}
          <div className="flex items-center justify-between pt-2 border-t">
            <Button
              size="sm"
              variant="outline"
              onClick={handleTestConnection}
              disabled={!credentialsConfigured || testingConnection}
              className="flex items-center gap-2"
            >
              {testingConnection ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <span>Test Connection</span>
                </>
              )}
            </Button>

            <div className="flex items-center gap-2">
              {(showTestLogInstant || testLogs.length > 0 || (connection.last_test_log && connection.last_test_log.length > 0)) && (
                <Button
                  size="sm"
                  variant={logsExpanded ? "default" : "outline"}
                  onClick={() => setLogsExpanded(!logsExpanded)}
                  className="flex items-center gap-2 text-xs h-8"
                  title={logsExpanded ? "Hide test logs" : "Show test logs"}
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${logsExpanded ? "rotate-180" : ""}`} />
                  <span className="font-medium">Logs ({testLogs.length > 0 ? testLogs.length : (Array.isArray(connection.last_test_log) ? connection.last_test_log.length : 0)} lines)</span>
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm(`Are you sure you want to delete ${connection.name}? This action cannot be undone.`)) {
                    onDelete()
                  }
                }}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 h-8"
                title="Delete this connection"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Logs Section */}
          {(testLogs.length > 0 || (connection.last_test_log && connection.last_test_log.length > 0)) && (
            <div className="space-y-2 border-t pt-3 mt-3">
              {logsExpanded && (
                <div className="bg-muted p-3 rounded-md text-xs font-mono max-h-64 overflow-y-auto space-y-0.5 border border-border">
                  {(testLogs.length > 0 
                    ? testLogs 
                    : (connection.last_test_log || [])
                  ).map((line: string, i: number) => (
                    <div key={i} className="text-muted-foreground font-mono text-xs leading-relaxed">
                      {line || '\u00A0'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Edit Settings Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Connection Settings</DialogTitle>
            <DialogDescription>Update configuration for {connection.name}</DialogDescription>
          </DialogHeader>

          <Tabs value={editDialogTab} onValueChange={setEditDialogTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="api">API Credentials</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            {/* Basic Info Tab */}
            <TabsContent value="basic" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-name" className="font-medium text-xs">Connection Name</Label>
                  <Input
                    id="edit-name"
                    value={editFormData.name}
                    onChange={(e) => setEditFormData((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., My Bybit Connection"
                    className="bg-white h-8 text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-api-type" className="font-medium text-xs">API Type</Label>
                  <Select value={editFormData.api_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, api_type: value }))}>
                    <SelectTrigger id="edit-api-type" className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="spot">Spot</SelectItem>
                      <SelectItem value="perpetual_futures">Perpetual Futures</SelectItem>
                      <SelectItem value="linear_swap">Linear Swap</SelectItem>
                      <SelectItem value="unified">Unified</SelectItem>
                    </SelectContent>
                  </Select>
                  {(connection.exchange === "bingx" || connection.exchange === "pionex" || connection.exchange === "orangex") && editFormData.api_type === "spot" && (
                    <p className="text-xs text-amber-600 mt-1">
                      ⚠️ Warning: Spot API will show 0 balance if you have Perpetual Futures positions. Use "perpetual_futures" for futures trading.
                    </p>
                  )}
                </div>

                {editFormData.api_type === "unified" && (
                  <div className="space-y-2">
                    <Label htmlFor="edit-api-subtype" className="font-medium text-xs">Trading Type (Unified Account)</Label>
                    <Select value={editFormData.api_subtype || "perpetual"} onValueChange={(value) => setEditFormData(prev => ({ ...prev, api_subtype: value }))}>
                      <SelectTrigger id="edit-api-subtype" className="bg-white h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="spot">Spot</SelectItem>
                        <SelectItem value="perpetual">Perpetual</SelectItem>
                        <SelectItem value="derivatives">Derivatives</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="edit-connection-method" className="font-medium text-xs">Connection Method</Label>
                  <Select value={editFormData.connection_method} onValueChange={(value) => setEditFormData(prev => ({ ...prev, connection_method: value }))}>
                    <SelectTrigger id="edit-connection-method" className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(EXCHANGE_CONNECTION_METHODS[connection.exchange] || ["rest"]).map((method) => {
                        const methodInfo = CONNECTION_METHODS[method as keyof typeof CONNECTION_METHODS]
                        return (
                          <SelectItem key={method} value={method}>
                            <span className="text-sm">{methodInfo?.label || method.toUpperCase()}</span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-connection-library" className="font-medium text-xs">Library</Label>
                  <Select value={editFormData.connection_library || "native"} onValueChange={(value) => setEditFormData(prev => ({ ...prev, connection_library: value }))}>
                    <SelectTrigger id="edit-connection-library" className="bg-white h-8 text-sm">
                      <SelectValue placeholder="Select library..." />
                    </SelectTrigger>
                    <SelectContent>
                      {editFormData.connection_method === "rest" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                      {editFormData.connection_method === "library" && (
                        <>
                          <SelectItem value="original"><span className="text-sm">Original - {EXCHANGE_LIBRARY_PACKAGES[connection.exchange] || "Exchange SDK"}</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                      {editFormData.connection_method === "websocket" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                        </>
                      )}
                      {editFormData.connection_method === "hybrid" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {editFormData.connection_library === "native" && "Built-in native implementation"}
                    {editFormData.connection_library === "original" && `Official ${connection.exchange.toUpperCase()} SDK`}
                    {editFormData.connection_library === "ccxt" && "Universal CCXT library (cross-exchange)"}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-margin" className="font-medium text-xs">Margin Type</Label>
                  <Select value={editFormData.margin_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, margin_type: value }))}>
                    <SelectTrigger id="edit-margin" className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cross">Cross Margin</SelectItem>
                      <SelectItem value="isolated">Isolated Margin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-position" className="font-medium text-xs">Position Mode</Label>
                  <Select value={editFormData.position_mode} onValueChange={(value) => setEditFormData(prev => ({ ...prev, position_mode: value }))}>
                    <SelectTrigger id="edit-position" className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hedge">Hedge Mode (Bidirectional)</SelectItem>
                      <SelectItem value="one_way">One Way Mode</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-order-type" className="font-medium text-xs">Order Type (Default)</Label>
                  <Select value={editFormData.order_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, order_type: value }))}>
                    <SelectTrigger id="edit-order-type" className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="market">Market (Immediate)</SelectItem>
                      <SelectItem value="limit">Limit (Price-Based)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-order-volume" className="font-medium text-xs">Order Volume (USD)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="edit-order-volume"
                      type="number"
                      min="10"
                      max="100000"
                      step="10"
                      value={editFormData.order_volume_usdt}
                      onChange={(e) => setEditFormData(prev => ({ ...prev, order_volume_usdt: Math.max(10, Number(e.target.value)) }))}
                      className="bg-white h-8 text-sm flex-1"
                    />
                    <span className="text-xs font-medium text-muted-foreground">USDT</span>
                  </div>
                </div>
              </div>

              {/* Testnet Toggle */}
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <Label className="font-medium text-xs">Use Testnet</Label>
                  <p className="text-xs text-muted-foreground">Test connections on testnet before live trading</p>
                </div>
                <Switch
                  id="edit-testnet"
                  checked={editFormData.is_testnet}
                  onCheckedChange={(checked) => setEditFormData(prev => ({ ...prev, is_testnet: checked }))}
                />
              </div>
            </TabsContent>

            {/* API Credentials Tab */}
            <TabsContent value="api" className="space-y-4 mt-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-900 mt-0.5" />
                <div className="text-sm text-amber-900">
                  <p className="font-semibold mb-1">Secure Your Credentials</p>
                  <p className="text-xs">Your API credentials are encrypted and never shared. Never paste credentials in untrusted environments.</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-api-key" className="font-medium flex items-center gap-2">
                    <Lock className="h-4 w-4" />
                    API Key
                  </Label>
                  <div className="relative">
                    <Input
                      id="edit-api-key"
                      type={showSecrets ? "text" : "password"}
                      value={editFormData.api_key}
                      onChange={(e) => setEditFormData((prev) => ({ ...prev, api_key: e.target.value }))}
                      placeholder="Enter your API key"
                      className="pr-10 bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecrets(!showSecrets)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-api-secret" className="font-medium flex items-center gap-2">
                    <Lock className="h-4 w-4" />
                    API Secret
                  </Label>
                  <Input
                    id="edit-api-secret"
                    type={showSecrets ? "text" : "password"}
                    value={editFormData.api_secret}
                    onChange={(e) => setEditFormData((prev) => ({ ...prev, api_secret: e.target.value }))}
                    placeholder="Enter your API secret"
                    className="bg-white"
                  />
                </div>

                {connection.exchange === "okx" && (
                  <div className="space-y-2">
                    <Label htmlFor="edit-passphrase" className="font-medium">API Passphrase (OKX only)</Label>
                    <Input
                      id="edit-passphrase"
                      type={showSecrets ? "text" : "password"}
                      value={editFormData.api_passphrase}
                      onChange={(e) => setEditFormData((prev) => ({ ...prev, api_passphrase: e.target.value }))}
                      placeholder="Enter your API passphrase"
                      className="bg-white"
                    />
                  </div>
                )}

                <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs text-blue-900">
                  ℹ️ Your API credentials are encrypted and only used for secure connections to {connection.exchange}.
                </div>
              </div>
            </TabsContent>

            {/* Advanced Tab */}
            <TabsContent value="advanced" className="space-y-4 mt-4">
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded p-3 text-xs">
                <div className="font-semibold text-blue-900 dark:text-blue-200 mb-2">
                  Rate Limits ({editFormData.connection_method === "rest" ? "REST API" : editFormData.connection_method === "websocket" ? "WebSocket" : "Library"})
                </div>
                <div className="text-blue-800 dark:text-blue-300 space-y-1">
                  {editFormData.connection_method === "rest" ? (
                    <>
                      <div>• Public requests: 1000 per 10 seconds</div>
                      <div>• Private requests: 100 per 10 seconds</div>
                      <div>• Recommended delay: 10-50ms between requests</div>
                      <div>• Check exchange docs for tier-specific limits</div>
                    </>
                  ) : editFormData.connection_method === "websocket" ? (
                    <>
                      <div>• Unlimited message rate on WebSocket</div>
                      <div>• Max 10 concurrent connections</div>
                      <div>• Best for real-time market data</div>
                      <div>• Lower latency than REST polling</div>
                    </>
                  ) : (
                    <>
                      <div>• Depends on selected library</div>
                      <div>• {editFormData.connection_library === "original" ? "Official SDK rate limits" : "Universal CCXT limits"}</div>
                      <div>• Contact {connection.exchange.toUpperCase()} for tier limits</div>
                    </>
                  )}
                </div>
              </div>

              <div className="bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800 rounded p-3 text-xs">
                <div className="font-semibold text-purple-900 dark:text-purple-200 mb-2">
                  Library: {editFormData.connection_library === "native" ? "Native" : editFormData.connection_library === "ccxt" ? "CCXT" : "Original SDK"}
                </div>
                <div className="text-purple-800 dark:text-purple-300 space-y-1">
                  {editFormData.connection_library === "native" ? (
                    <>
                      <div>• Built-in implementation</div>
                      <div>• Optimized for this exchange</div>
                      <div>• No external dependencies</div>
                      <div>• Fast and reliable</div>
                    </>
                  ) : editFormData.connection_library === "ccxt" ? (
                    <>
                      <div>• Universal cross-exchange library</div>
                      <div>• Unified API across exchanges</div>
                      <div>• Community maintained</div>
                      <div>• Good for multi-exchange setups</div>
                    </>
                  ) : (
                    <>
                      <div>• Official exchange SDK</div>
                      <div>• Complete feature support</div>
                      <div>• Latest exchange features</div>
                      <div>• Direct vendor support</div>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveSettings} disabled={savingSettings}>
              {savingSettings ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Settings"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
