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
import { isMaskedOrEmptyConnectionSecret } from "@/lib/connection-secrets"
import { normalizeMarketType } from "@/lib/market-types"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  normalizeForexExecutionMode,
} from "@/lib/forex-market"

export type { ExchangeConnection }
import {
  EXCHANGE_CONNECTION_METHODS,
  CONNECTION_METHODS,
  EXCHANGE_LIBRARY_PACKAGES,
} from "@/lib/connection-predefinitions"

function toBooleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

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
  const marketType = normalizeMarketType(connection.market_type || connection.asset_class, exchange)
  const isForex = marketType === "forex"
  const persistedForexBridgeSelected = isForex && isForexBridgeSelected(connection as unknown as Record<string, unknown>)
  const isProdVst = connection.id === "bingx-x02"
  const isEnabled = toBooleanFlag(connection.is_enabled)
  const isDashboardEnabled = toBooleanFlag((connection as any).is_enabled_dashboard)
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
    account_id: connection.account_id || (isForex ? connection.api_key : ""),
    api_secret: connection.api_secret,
    name: connection.name,
    api_type: connection.api_type,
    api_subtype: connection.api_subtype,
    connection_method: isForex ? (persistedForexBridgeSelected ? "bridge" : "rest") : connection.connection_method,
    connection_library: isForex ? (persistedForexBridgeSelected ? "mt5-bridge" : "native-http") : connection.connection_library || (exchange === "bingx" ? "sdk" : "native"),
    margin_type: connection.margin_type,
    position_mode: connection.position_mode,
    is_testnet: isForex ? false : isProdVst || toBooleanFlag(connection.is_testnet),
    api_passphrase: connection.api_passphrase || "",
    account_password: "",
    account_server: connection.account_server || "",
    bridge_url: connection.bridge_url || "http://127.0.0.1:8765",
    bridge_token: "",
    terminal_path: connection.terminal_path || "",
    forex_execution_mode: isForex && persistedForexBridgeSelected ? "mt5_bridge" : "read_only",
    symbol_suffix: connection.symbol_suffix || "",
    lot_size: String(connection.lot_size || DEFAULT_FOREX_LOT_SIZE),
    position_cost_percent: String(connection.position_cost_percent || "0.1"),
    spread_buffer_pips: String(connection.spread_buffer_pips ?? DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
    spread_multiplier: String(connection.spread_multiplier ?? DEFAULT_FOREX_SPREAD_MULTIPLIER),
    positions_average: String(connection.positions_average || connection.average_count || DEFAULT_FOREX_POSITIONS_AVERAGE),
    max_spread_pips: String(connection.max_spread_pips ?? "3"),
    order_type: "market",
    order_volume_usdt: 100,
  })
  useEffect(() => {
    setEditFormData({
      api_key: connection.api_key || "",
      account_id: connection.account_id || (isForex ? connection.api_key || "" : ""),
      api_secret: connection.api_secret || "",
      name: connection.name,
      api_type: connection.api_type,
      api_subtype: connection.api_subtype,
      connection_method: isForex ? (persistedForexBridgeSelected ? "bridge" : "rest") : connection.connection_method,
      connection_library: isForex ? (persistedForexBridgeSelected ? "mt5-bridge" : "native-http") : connection.connection_library || (exchange === "bingx" ? "sdk" : "native"),
      margin_type: connection.margin_type,
      position_mode: connection.position_mode === "one_way" ? "one-way" : connection.position_mode,
      is_testnet: isForex ? false : isProdVst || toBooleanFlag(connection.is_testnet),
      api_passphrase: connection.api_passphrase || "",
      account_password: "",
      account_server: connection.account_server || "",
      bridge_url: connection.bridge_url || "http://127.0.0.1:8765",
      bridge_token: "",
      terminal_path: connection.terminal_path || "",
      forex_execution_mode: isForex && persistedForexBridgeSelected ? "mt5_bridge" : "read_only",
      symbol_suffix: connection.symbol_suffix || "",
      lot_size: String(connection.lot_size || DEFAULT_FOREX_LOT_SIZE),
      position_cost_percent: String(connection.position_cost_percent || "0.1"),
      spread_buffer_pips: String(connection.spread_buffer_pips ?? DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
      spread_multiplier: String(connection.spread_multiplier ?? DEFAULT_FOREX_SPREAD_MULTIPLIER),
      positions_average: String(connection.positions_average || connection.average_count || DEFAULT_FOREX_POSITIONS_AVERAGE),
      max_spread_pips: String(connection.max_spread_pips ?? "3"),
      order_type: "market",
      order_volume_usdt: Number((connection as any).order_volume_usdt) || 100,
    })
  }, [connection, exchange, isProdVst])

  const forexBridgeSelected = isForex && normalizeForexExecutionMode(editFormData.forex_execution_mode) === "mt5_bridge"
  const storedBridgePassword = Boolean((connection as any).account_password_configured || (connection as any).bridge_configured)
  const connectionReady = !isForex || (
    /^[0-9]{4,12}$/.test(editFormData.account_id.trim()) &&
    (!forexBridgeSelected || ((Boolean(editFormData.account_password.trim()) || storedBridgePassword) && isValidForexBridgeUrl(editFormData.bridge_url)))
  )

  // Auto-set connection library based on connection method when editFormData changes
  useEffect(() => {
    let defaultLibrary = "native"
    if (isForex) {
      defaultLibrary = forexBridgeSelected ? "mt5-bridge" : "native-http"
    } else if (editFormData.connection_method === "rest") {
      defaultLibrary = "native"
    } else if (editFormData.connection_method === "websocket") {
      defaultLibrary = "native"
    } else if (editFormData.connection_method === "library") {
      defaultLibrary = exchange === "bingx" ? "sdk" : "original"
    }

    if (editFormData.connection_library !== defaultLibrary) {
      setEditFormData(prev => ({ ...prev, connection_library: defaultLibrary }))
    }
  }, [editFormData.connection_method, exchange, isForex])



  // Define handleTestConnection first so it can be used in useEffect
  const handleTestConnection = async () => {
    if (!connectionReady) {
      toast.error("Connection cannot be tested", {
        description: isForex
          ? "Enter a valid numeric InstaForex account id/login first."
          : "Enter the required connection credentials first.",
      })
      return
    }
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

      const testPayload = {
        exchange: connection.exchange,
        api_type: isForex ? "forex" : editFormData.api_type || "perpetual_futures",
        api_subtype: editFormData.api_subtype,
        connection_method: isForex ? (forexBridgeSelected ? "bridge" : "rest") : editFormData.connection_method || (exchange === "bingx" ? "library" : "rest"),
        connection_library: isForex ? (forexBridgeSelected ? "mt5-bridge" : "native-http") : editFormData.connection_library || (exchange === "bingx" ? "sdk" : "native"),
        ...(isForex
          ? {
              account_id: editFormData.account_id,
              market_type: "forex",
              api_type: "forex",
              symbol_suffix: editFormData.symbol_suffix,
              lot_size: Number(editFormData.lot_size),
              position_cost_percent: Number(editFormData.position_cost_percent),
              spread_buffer_pips: Number(editFormData.spread_buffer_pips),
              spread_multiplier: Number(editFormData.spread_multiplier),
              positions_average: Number(editFormData.positions_average),
              max_spread_pips: Number(editFormData.max_spread_pips),
              connection_method: forexBridgeSelected ? "bridge" : "rest",
              connection_library: forexBridgeSelected ? "mt5-bridge" : "native-http",
              forex_execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
              execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
              read_only: !forexBridgeSelected,
              execution_supported: forexBridgeSelected,
              account_password: forexBridgeSelected ? editFormData.account_password : undefined,
              account_server: forexBridgeSelected ? editFormData.account_server : undefined,
              bridge_url: forexBridgeSelected ? editFormData.bridge_url : undefined,
              bridge_token: forexBridgeSelected ? editFormData.bridge_token : undefined,
              terminal_path: forexBridgeSelected ? editFormData.terminal_path : undefined,
              is_testnet: false,
            }
          : {}),
        ...(!isForex && !isMaskedOrEmptyConnectionSecret(editFormData.api_key) ? { api_key: editFormData.api_key } : {}),
        ...(!isForex && !isMaskedOrEmptyConnectionSecret(editFormData.api_secret) ? { api_secret: editFormData.api_secret } : {}),
        ...(!isMaskedOrEmptyConnectionSecret(editFormData.api_passphrase) ? { api_passphrase: editFormData.api_passphrase } : {}),
        is_testnet: isForex ? false : isProdVst || editFormData.is_testnet,
      }
      const response = await fetch(`/api/settings/connections/${connId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload),
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
      const balance = Number(data.balance)
      toast.success("Connection Test Successful", {
        description: `${isForex ? "Forex read-only" : data.environment === "prod-vst" ? "Prod-VST virtual funds" : "Prod-Live"} | Balance: ${Number.isFinite(balance) ? balance.toFixed(2) : "N/A"} ${data.settlementAsset || (isForex ? "account currency" : "USDT")} | API Type: ${data.apiType}${data.apiSubtype ? ` (${data.apiSubtype})` : ""}`,
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
    if (isForex && !/^[0-9]{4,12}$/.test(editFormData.account_id.trim())) {
      toast.error("Validation Error", { description: "Enter a valid numeric InstaForex account id/login." })
      return
    }
    if (isForex && forexBridgeSelected && (!isValidForexBridgeUrl(editFormData.bridge_url) || (!editFormData.account_password.trim() && !storedBridgePassword))) {
      toast.error("Validation Error", { description: "Private InstaForex bridge requires a valid HTTP(S) URL and a stored or newly entered trader password." })
      return
    }
    const replacingKey = !isForex && !isMaskedOrEmptyConnectionSecret(editFormData.api_key)
    const replacingSecret = !isForex && !isMaskedOrEmptyConnectionSecret(editFormData.api_secret)
    if (!isForex && replacingKey !== replacingSecret) {
      toast.error("Validation Error", {
        description: "Enter both the API key and secret when replacing credentials.",
      })
      return
    }

    setSavingSettings(true)
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: isForex ? editFormData.account_id : editFormData.api_key,
          api_secret: isForex ? "" : editFormData.api_secret,
          ...(isForex ? {
            account_id: editFormData.account_id,
            market_type: "forex",
            asset_class: "forex",
            symbol_suffix: editFormData.symbol_suffix,
            quantity_unit: "lots",
            lot_size: Number(editFormData.lot_size),
            position_cost_percent: Number(editFormData.position_cost_percent),
            spread_buffer_pips: Number(editFormData.spread_buffer_pips),
            spread_multiplier: Number(editFormData.spread_multiplier),
            positions_average: Number(editFormData.positions_average),
            average_count: Number(editFormData.positions_average),
            max_spread_pips: Number(editFormData.max_spread_pips),
            connection_method: forexBridgeSelected ? "bridge" : "rest",
            connection_library: forexBridgeSelected ? "mt5-bridge" : "native-http",
            forex_execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
            execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
            read_only: !forexBridgeSelected,
            execution_supported: forexBridgeSelected,
            account_password: forexBridgeSelected && editFormData.account_password.trim() ? editFormData.account_password.trim() : undefined,
            account_server: forexBridgeSelected ? editFormData.account_server.trim() : undefined,
            bridge_url: forexBridgeSelected ? editFormData.bridge_url.trim() : undefined,
            bridge_token: forexBridgeSelected && editFormData.bridge_token.trim() ? editFormData.bridge_token.trim() : undefined,
            terminal_path: forexBridgeSelected ? editFormData.terminal_path.trim() : undefined,
          } : {}),
          api_passphrase: editFormData.api_passphrase,
          name: editFormData.name,
          api_type: isForex ? "forex" : editFormData.api_type,
          ...(editFormData.api_type === "unified" && { api_subtype: editFormData.api_subtype }),
          connection_method: isForex ? (forexBridgeSelected ? "bridge" : "rest") : editFormData.connection_method,
          connection_library: isForex ? (forexBridgeSelected ? "mt5-bridge" : "native-http") : editFormData.connection_library,
          margin_type: editFormData.margin_type,
          position_mode: editFormData.position_mode,
          is_testnet: isForex ? false : isProdVst || editFormData.is_testnet,
          order_type: editFormData.order_type,
          order_volume_usdt: editFormData.order_volume_usdt,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success !== true) {
        throw new Error(data?.details || data?.error || "Failed to update connection settings")
      }

      const credentialsMustRemainConfigured = connection.credentials_configured === true || (replacingKey && replacingSecret)
      if (credentialsMustRemainConfigured && data?.connection?.credentials_configured !== true) {
        throw new Error("Connection settings were written, but credential persistence could not be verified")
      }

      toast.success("Settings Updated", {
        description: "Connection settings have been saved successfully",
      })

      onEdit?.(data.connection || editFormData)
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

  const credentialsConfigured = isForex
    ? Boolean((connection as any).credentials_configured === true || (connection as any).account_id_configured || connection.account_id || connection.api_key)
    : connection.credentials_configured === true || (
      Boolean(connection.api_key && connection.api_secret) &&
      !String(connection.api_key).includes("PLACEHOLDER") &&
      !String(connection.api_secret).includes("PLACEHOLDER")
    )

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
                <Badge className={`text-xs ${isForex ? "bg-violet-100 text-violet-900" : ""}`}>
                  {isForex ? "Forex" : "Crypto"}
                </Badge>
                {isForex ? (
                  <Badge className={`text-xs ${persistedForexBridgeSelected ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
                    {persistedForexBridgeSelected ? "Private bridge" : "Read-only"}
                  </Badge>
                ) : isProdVst ? (
                  <>
                    <Badge className="text-xs bg-blue-100 text-blue-900">Prod-VST</Badge>
                    <Badge className="text-xs bg-cyan-100 text-cyan-900">Virtual funds</Badge>
                  </>
                ) : toBooleanFlag(connection.is_testnet) ? (
                  <Badge className="text-xs bg-blue-100 text-blue-900">Testnet</Badge>
                ) : (
                  <Badge className="text-xs bg-emerald-100 text-emerald-900">Prod-Live</Badge>
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
                    {isForex ? "forex" : connection.api_type}
                    {connection.api_type === "unified" && connection.api_subtype && ` (${connection.api_subtype})`}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Margin: <span className="text-foreground font-medium">{connection.margin_type}</span>
                </div>
                {isForex && (
                  <div className="text-sm text-muted-foreground">
                    Account: <span className="text-foreground font-medium">{connection.account_id || "configured"}</span>
                  </div>
                )}
                {isForex && (
                  <div className="text-sm text-muted-foreground">
                    Execution: <span className="text-foreground font-medium">{persistedForexBridgeSelected ? "Private terminal bridge (native orders)" : "Read-only market/account data"}</span>
                  </div>
                )}
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
              <span className="font-medium">{isForex ? (persistedForexBridgeSelected ? "Private terminal bridge" : "REST/HTTP (read-only)") : connection.connection_method}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Position: </span>
              <span className="font-medium">{connection.position_mode}</span>
            </div>
          </div>

          {/* Credentials Warning */}
          {credentialsConfigured && (
            <div className="text-xs p-3 bg-emerald-50 text-emerald-800 rounded border border-emerald-200">
              {isForex ? (persistedForexBridgeSelected ? "InstaForex account and private terminal bridge are configured. Native position-linked protection orders remain required for live entries." : "InstaForex account identifier is stored securely. The official REST/HTTP integration is read-only and cannot place orders.") : "Credentials stored securely. Leave the masked fields unchanged to keep them, or enter both values to replace them."}
            </div>
          )}
          {!credentialsConfigured && (
            <div className="text-xs p-3 bg-yellow-50 text-yellow-800 rounded border border-yellow-200">
              {isForex ? (persistedForexBridgeSelected ? "InstaForex bridge credentials are incomplete. Add the trader password and validate the private bridge before enabling execution." : "InstaForex account id/login is not configured. Add it before testing.") : "API credentials not configured. Please add your API key and secret to test this connection."}
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
                  <div className="text-xs mt-1">Balance: ${Number(connection.last_test_balance).toFixed(4)} {connection.last_test_settlement_asset || (isForex ? "account currency" : "USDT")}</div>
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
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleTestConnection}
                disabled={!connectionReady || testingConnection}
                className="flex items-center gap-2"
              >
                {testingConnection ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <span>Test Connection</span>
                )}
              </Button>
              <Button
                size="sm"
                variant={isDashboardEnabled ? "default" : "outline"}
                onClick={onActivate}
                title={isDashboardEnabled ? "Disable in Main Connections" : "Enable in Main Connections"}
              >
                {isDashboardEnabled ? "In Main" : "Add to Main"}
              </Button>
            </div>

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
                    className="bg-background h-8 text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="font-medium text-xs">Market Type</Label>
                  <div className="flex h-8 items-center">
                    <Badge variant="outline">{isForex ? "Forex" : "Crypto"}</Badge>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-api-type" className="font-medium text-xs">API Type</Label>
                    <Select value={editFormData.api_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, api_type: value }))} disabled={isForex}>
                    <SelectTrigger id="edit-api-type" className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {isForex && <SelectItem value="forex">Forex account and market data (read-only)</SelectItem>}
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
                      <SelectTrigger id="edit-api-subtype" className="bg-background h-8 text-sm">
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
                  <Select
                    value={editFormData.connection_method}
                    onValueChange={(value) => setEditFormData(prev => ({
                      ...prev,
                      connection_method: value,
                      connection_library: isForex ? (value === "bridge" ? "mt5-bridge" : "native-http") : prev.connection_library,
                      forex_execution_mode: isForex && value === "bridge" ? "mt5_bridge" : isForex ? "read_only" : prev.forex_execution_mode,
                    }))}
                  >
                    <SelectTrigger id="edit-connection-method" className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(isForex ? ["rest", "bridge"] : (EXCHANGE_CONNECTION_METHODS[connection.exchange] || ["rest"])).map((method) => {
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
                  <Select
                    value={editFormData.connection_library || "native"}
                    onValueChange={(value) => setEditFormData(prev => ({
                      ...prev,
                      connection_library: value,
                      connection_method: isForex ? (value === "mt5-bridge" ? "bridge" : "rest") : prev.connection_method,
                      forex_execution_mode: isForex && value === "mt5-bridge" ? "mt5_bridge" : isForex ? "read_only" : prev.forex_execution_mode,
                    }))}
                    disabled={false}
                  >
                    <SelectTrigger id="edit-connection-library" className="bg-background h-8 text-sm">
                      <SelectValue placeholder="Select library..." />
                    </SelectTrigger>
                    <SelectContent>
                      {isForex && editFormData.connection_method === "rest" && (
                        <SelectItem value="native-http"><span className="text-sm">Official HTTP (read-only)</span></SelectItem>
                      )}
                      {isForex && editFormData.connection_method === "bridge" && (
                        <SelectItem value="mt5-bridge"><span className="text-sm">Private MT5 terminal bridge</span></SelectItem>
                      )}
                      {!isForex && editFormData.connection_method === "rest" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                      {editFormData.connection_method === "library" && (
                        <>
                          {exchange === "bingx" ? (
                            <SelectItem value="sdk"><span className="text-sm">bingx-api package (Default)</span></SelectItem>
                          ) : (
                            <SelectItem value="original"><span className="text-sm">Original - {EXCHANGE_LIBRARY_PACKAGES[connection.exchange] || "Exchange SDK"}</span></SelectItem>
                          )}
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
                    {editFormData.connection_library === "native-http" && "Official InstaForex HTTP feeds (read-only)"}
                    {editFormData.connection_library === "mt5-bridge" && "Private authenticated terminal bridge with native position-linked SL/TP"}
                    {editFormData.connection_library === "native" && "Built-in native implementation"}
                    {editFormData.connection_library === "sdk" && "Native bingx-api package with signed REST fallback"}
                    {editFormData.connection_library === "original" && `${connection.exchange.toUpperCase()} exchange library`}
                    {editFormData.connection_library === "ccxt" && "Universal CCXT library (cross-exchange)"}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-margin" className="font-medium text-xs">Margin Type</Label>
                  <Select value={editFormData.margin_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, margin_type: value }))} disabled={isForex}>
                    <SelectTrigger id="edit-margin" className="bg-background h-8 text-sm">
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
                  <Select value={editFormData.position_mode} onValueChange={(value) => setEditFormData(prev => ({ ...prev, position_mode: value }))} disabled={isForex}>
                    <SelectTrigger id="edit-position" className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hedge">Hedge Mode (Bidirectional)</SelectItem>
                      <SelectItem value="one-way">One Way Mode</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-order-type" className="font-medium text-xs">Order Type (Default)</Label>
                  <Select value={editFormData.order_type} onValueChange={(value) => setEditFormData(prev => ({ ...prev, order_type: value }))}>
                    <SelectTrigger id="edit-order-type" className="bg-background h-8 text-sm">
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
                      className="bg-background h-8 text-sm flex-1"
                    />
                    <span className="text-xs font-medium text-muted-foreground">USDT</span>
                  </div>
                </div>
              </div>

              {/* Testnet Toggle */}
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <Label className="font-medium text-xs">Environment</Label>
                  <p className="text-xs text-muted-foreground">
                    {isForex ? (forexBridgeSelected ? "InstaForex private terminal bridge · execution enabled only after bridge validation" : "InstaForex official market and account data · read-only") : isProdVst ? "Prod-VST authenticated demo with virtual funds" : editFormData.is_testnet ? "Demo/test environment" : "Prod-Live with real funds"}
                  </p>
                </div>
                <Switch
                  id="edit-testnet"
                  checked={isForex ? false : isProdVst || editFormData.is_testnet}
                  onCheckedChange={(checked) => setEditFormData(prev => ({ ...prev, is_testnet: isProdVst || checked }))}
                  disabled={isProdVst || isForex}
                />
              </div>
            </TabsContent>

            {/* API Credentials Tab */}
            <TabsContent value="api" className="space-y-4 mt-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-900 mt-0.5" />
                <div className="text-sm text-amber-900">
                  <p className="font-semibold mb-1">Secure Your Credentials</p>
                  <p className="text-xs">Stored credentials are masked and are never returned to this dialog. Never paste credentials in untrusted environments.</p>
                </div>
              </div>

              <div className="space-y-4">
                {isForex ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="edit-account-id" className="font-medium flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        InstaForex Account ID / Login
                      </Label>
                      <Input
                        id="edit-account-id"
                        inputMode="numeric"
                        value={editFormData.account_id}
                        onChange={(e) => setEditFormData((prev) => ({ ...prev, account_id: e.target.value.replace(/\D/g, "") }))}
                        placeholder="Numeric account login"
                        className="bg-background"
                      />
                      <p className="text-xs text-muted-foreground">{(connection as any).account_id_configured ? "Account identifier is stored server-side." : "No account identifier is stored."} {forexBridgeSelected ? "The private bridge is selected; credentials remain server-side and native ticket-linked protection is mandatory." : "The official HTTP integration is read-only; order execution is unavailable."}</p>
                    </div>
                    {forexBridgeSelected && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="edit-account-password" className="font-medium">Trader password</Label>
                          <Input
                            id="edit-account-password"
                            type={showSecrets ? "text" : "password"}
                            value={editFormData.account_password}
                            onChange={(e) => setEditFormData((prev) => ({ ...prev, account_password: e.target.value }))}
                            placeholder={storedBridgePassword ? "Stored — enter to replace" : "Enter terminal trader password"}
                            className="bg-background"
                          />
                          <p className="text-xs text-muted-foreground">{storedBridgePassword ? "A trader password is stored server-side." : "No trader password is stored."}</p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-account-server" className="font-medium">Terminal server</Label>
                          <Input id="edit-account-server" value={editFormData.account_server} onChange={(e) => setEditFormData((prev) => ({ ...prev, account_server: e.target.value }))} placeholder="Broker terminal server name" className="bg-background" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-bridge-url" className="font-medium">Private bridge URL</Label>
                          <Input id="edit-bridge-url" value={editFormData.bridge_url} onChange={(e) => setEditFormData((prev) => ({ ...prev, bridge_url: e.target.value }))} placeholder="http://127.0.0.1:8765" className="bg-background" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-bridge-token" className="font-medium">Bridge token (optional)</Label>
                          <Input id="edit-bridge-token" type={showSecrets ? "text" : "password"} value={editFormData.bridge_token} onChange={(e) => setEditFormData((prev) => ({ ...prev, bridge_token: e.target.value }))} placeholder={(connection as any).bridge_token_configured ? "Stored — enter to replace" : "Optional bearer token"} className="bg-background" />
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="edit-terminal-path" className="font-medium">Terminal path (optional)</Label>
                          <Input id="edit-terminal-path" value={editFormData.terminal_path} onChange={(e) => setEditFormData((prev) => ({ ...prev, terminal_path: e.target.value }))} placeholder="Local terminal data path, if required by bridge" className="bg-background" />
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <>
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
                          placeholder={connection.api_key_configured ? "Stored — enter to replace" : "Enter your API key"}
                          className="pr-10 bg-background"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecrets(!showSecrets)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {connection.api_key_configured ? "A key is stored server-side." : "No API key is stored."}
                      </p>
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
                        placeholder={connection.api_secret_configured ? "Stored — enter to replace" : "Enter your API secret"}
                        className="bg-background"
                      />
                      <p className="text-xs text-muted-foreground">
                        {connection.api_secret_configured ? "A secret is stored server-side." : "No API secret is stored."}
                      </p>
                    </div>
                  </>
                )}

                {connection.exchange === "okx" && !isForex && (
                  <div className="space-y-2">
                    <Label htmlFor="edit-passphrase" className="font-medium">API Passphrase (OKX only)</Label>
                    <Input
                      id="edit-passphrase"
                      type={showSecrets ? "text" : "password"}
                      value={editFormData.api_passphrase}
                      onChange={(e) => setEditFormData((prev) => ({ ...prev, api_passphrase: e.target.value }))}
                      placeholder="Enter your API passphrase"
                      className="bg-background"
                    />
                  </div>
                )}

                <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs text-blue-900">
                  ℹ️ Stored credentials remain server-side, are masked in the browser, and are only used for {isForex ? (forexBridgeSelected ? "the explicitly selected private InstaForex terminal bridge" : "read-only InstaForex account data") : `authenticated connections to ${connection.exchange}`}.
                </div>
              </div>
            </TabsContent>

            {/* Advanced Tab */}
            <TabsContent value="advanced" className="space-y-4 mt-4">
              {isForex && (
                <Card className="border-cyan-200 bg-cyan-50/40 dark:border-cyan-900 dark:bg-cyan-950/20">
                  <div className="p-4 space-y-4">
                    <div>
                      <p className="font-medium text-cyan-950 dark:text-cyan-100">InstaForex transport and PositionCost</p>
                      <p className="mt-1 text-xs text-cyan-900/80 dark:text-cyan-200/80">{forexBridgeSelected ? "The private terminal bridge supplies live quotes, history, and native ticket-linked orders; official REST/HTTP remains the read-only fallback." : "REST/HTTP supplies quotes, history, and account data; official HTTP order execution is unavailable."} PositionCost uses the live broker bid/ask spread plus the configured safety buffer.</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-symbol-suffix">Broker symbol suffix</Label>
                        <Input id="edit-symbol-suffix" value={editFormData.symbol_suffix} onChange={(e) => setEditFormData((prev) => ({ ...prev, symbol_suffix: e.target.value }))} placeholder="e.g. .fx or .m" />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5"><Label htmlFor="edit-positions-average">Average count</Label><Input id="edit-positions-average" type="number" min="1" max="600" value={editFormData.positions_average} onChange={(e) => setEditFormData((prev) => ({ ...prev, positions_average: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label htmlFor="edit-lot-size">Contract size / lot</Label><Input id="edit-lot-size" type="number" min="1" value={editFormData.lot_size} onChange={(e) => setEditFormData((prev) => ({ ...prev, lot_size: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label htmlFor="edit-max-spread-pips">Max spread (pips)</Label><Input id="edit-max-spread-pips" type="number" min="0" step="0.1" value={editFormData.max_spread_pips} onChange={(e) => setEditFormData((prev) => ({ ...prev, max_spread_pips: e.target.value }))} /></div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5"><Label htmlFor="edit-position-cost">Fallback PositionCost %</Label><Input id="edit-position-cost" type="number" min="0.02" max="1" step="0.01" value={editFormData.position_cost_percent} onChange={(e) => setEditFormData((prev) => ({ ...prev, position_cost_percent: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label htmlFor="edit-spread-buffer">Spread buffer (pips)</Label><Input id="edit-spread-buffer" type="number" min="0" step="0.1" value={editFormData.spread_buffer_pips} onChange={(e) => setEditFormData((prev) => ({ ...prev, spread_buffer_pips: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label htmlFor="edit-spread-multiplier">Spread multiplier</Label><Input id="edit-spread-multiplier" type="number" min="0" step="0.1" value={editFormData.spread_multiplier} onChange={(e) => setEditFormData((prev) => ({ ...prev, spread_multiplier: e.target.value }))} /></div>
                    </div>
                  </div>
                </Card>
              )}
              {!isForex && <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded p-3 text-xs">
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
              </div>}

              {!isForex && <div className="bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800 rounded p-3 text-xs">
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
              </div>}
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
