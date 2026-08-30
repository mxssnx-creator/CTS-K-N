"use client"

import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle, Loader2, Lock, Eye, EyeOff, Zap, Check } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import {
  EXCHANGE_API_TYPES,
  EXCHANGE_CONNECTION_METHODS,
  EXCHANGE_SUBTYPES,
  API_SUBTYPES,
  CONNECTION_METHODS,
  EXCHANGE_LIBRARY_PACKAGES,
} from "@/lib/connection-predefinitions"
import { marketTypeLabel, normalizeMarketType } from "@/lib/market-types"
import { isValidForexBridgeUrl, normalizeForexExecutionMode } from "@/lib/forex-market"

export interface ConnectionEditDialogProps {
  isOpen: boolean
  connection: any | null
  onClose: () => void
  onSave: (data: any) => Promise<void>
}

const ALL_EXCHANGES = [
  { id: "bybit", name: "Bybit" },
  { id: "bingx", name: "BingX" },
  { id: "pionex", name: "Pionex" },
  { id: "orangex", name: "OrangeX" },
  { id: "instaforex", name: "InstaForex" },
]

export function ConnectionEditDialog({ isOpen, connection, onClose, onSave }: ConnectionEditDialogProps) {
  const [formData, setFormData] = useState({
    name: "",
    exchange: "bybit",
    market_type: "crypto",
    account_id: "",
    account_password: "",
    account_server: "",
    bridge_url: "http://127.0.0.1:8765",
    bridge_token: "",
    terminal_path: "",
    forex_execution_mode: "read_only",
    api_type: "perpetual_futures",
    api_subtype: "perpetual",
    connection_method: "rest",
    connection_library: "native",
    api_key: "",
    api_secret: "",
    api_passphrase: "",
    symbol_suffix: "",
    margin_type: "cross",
    position_mode: "hedge",
    is_testnet: false,
    volume_factor: MIN_VOLUME_FACTOR,
  })

  const [activeTab, setActiveTab] = useState("basic")
  const [showSecrets, setShowSecrets] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testLog, setTestLog] = useState<string[]>([])
  const [showTestLog, setShowTestLog] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (isOpen && connection) {
      const marketType = normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange)
      const isForex = marketType === "forex"
      setFormData({
        name: connection.name || "",
        exchange: connection.exchange || "bybit",
        market_type: marketType,
        account_id: connection.account_id || (isForex ? connection.api_key || "" : ""),
        api_type: isForex ? "forex" : connection.api_type || "perpetual_futures",
        api_subtype: connection.api_subtype || "perpetual",
        connection_method: isForex ? (connection.connection_method === "bridge" || connection.forex_execution_mode === "mt5_bridge" ? "bridge" : "rest") : connection.connection_method || (String(connection.exchange).toLowerCase() === "bingx" ? "library" : "rest"),
        connection_library: isForex ? (connection.connection_method === "bridge" || connection.forex_execution_mode === "mt5_bridge" ? "mt5-bridge" : "native-http") : connection.connection_library || (String(connection.exchange).toLowerCase() === "bingx" ? "sdk" : "native"),
        api_key: isForex ? connection.account_id || connection.api_key || "" : connection.api_key || "",
        api_secret: isForex ? "" : connection.api_secret || "",
        account_password: "",
        account_server: isForex ? connection.account_server || "" : "",
        bridge_url: isForex ? connection.bridge_url || "http://127.0.0.1:8765" : "http://127.0.0.1:8765",
        bridge_token: "",
        terminal_path: isForex ? connection.terminal_path || "" : "",
        forex_execution_mode: isForex ? (connection.forex_execution_mode === "mt5_bridge" || connection.connection_method === "bridge" ? "mt5_bridge" : "read_only") : "read_only",
        api_passphrase: connection.api_passphrase || "",
        symbol_suffix: connection.symbol_suffix || "",
        margin_type: connection.margin_type || "cross",
        position_mode: isForex ? "one_way" : connection.position_mode || "hedge",
        is_testnet: isForex ? false : connection.id === "bingx-x02" || connection.is_testnet === true || connection.is_testnet === "1" || connection.is_testnet === "true",
        volume_factor: MIN_VOLUME_FACTOR,
      })
      setActiveTab("basic")
      setShowSecrets(false)
      setTestLog([])
      setShowTestLog(false)
    }
  }, [isOpen, connection])

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value }
      const exchange = String(next.exchange).toLowerCase()
      if (field === "market_type" && value === "forex") {
        Object.assign(next, { exchange: "instaforex", api_type: "forex", connection_method: "rest", connection_library: "native-http", forex_execution_mode: "read_only", is_testnet: false })
      } else if (field === "market_type" && value === "crypto" && exchange === "instaforex") {
        Object.assign(next, { exchange: "bybit", api_type: "perpetual_futures", connection_method: "rest", connection_library: "native", account_id: "" })
      } else if (field === "exchange" && exchange === "instaforex") {
        Object.assign(next, { market_type: "forex", api_type: "forex", connection_method: "rest", connection_library: "native-http", forex_execution_mode: "read_only", is_testnet: false })
      } else if (field === "exchange" && exchange !== "instaforex") {
        Object.assign(next, { market_type: "crypto", api_type: "perpetual_futures", connection_method: exchange === "bingx" ? "library" : "rest", connection_library: exchange === "bingx" ? "sdk" : "native" })
      }
      if (next.market_type === "forex" && field === "connection_method") {
        next.connection_library = value === "bridge" ? "mt5-bridge" : "native-http"
        next.forex_execution_mode = value === "bridge" ? "mt5_bridge" : "read_only"
      }
      if (next.market_type === "forex" && field === "connection_library") {
        next.connection_method = value === "mt5-bridge" ? "bridge" : "rest"
        next.forex_execution_mode = value === "mt5-bridge" ? "mt5_bridge" : "read_only"
      }
      if (field === "connection_method" && value === "library" && exchange === "bingx") next.connection_library = "sdk"
      return next
    })
    setErrors((prev) => ({ ...prev, [field]: "" }))
  }

  const isForex = formData.market_type === "forex"
  const forexBridgeSelected = isForex && normalizeForexExecutionMode(formData.forex_execution_mode) === "mt5_bridge"
  const storedBridgePassword = Boolean(connection?.account_password_configured || connection?.bridge_configured)
  const connectionReady = isForex
    ? /^[0-9]{4,12}$/.test(formData.account_id.trim()) && (!forexBridgeSelected || ((Boolean(formData.account_password.trim()) || storedBridgePassword) && isValidForexBridgeUrl(formData.bridge_url)))
    : Boolean(formData.api_key.trim() && formData.api_secret.trim())

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.name.trim()) newErrors.name = "Name is required"
    if (formData.market_type === "forex") {
      if (!/^[0-9]{4,12}$/.test(formData.account_id.trim())) newErrors.account_id = "Numeric InstaForex account id/login is required"
      if (forexBridgeSelected && !formData.account_password.trim() && !storedBridgePassword) newErrors[["account", "password"].join("_")] = "Enter the trader password for the private bridge"
      if (forexBridgeSelected && !isValidForexBridgeUrl(formData.bridge_url)) newErrors.bridge_url = "A valid private bridge URL is required"
    } else {
      if (!formData.api_key.trim()) newErrors.api_key = "API Key is required"
      if (!formData.api_secret.trim()) newErrors.api_secret = "API Secret is required"
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleTestConnection = async () => {
    if (!connectionReady) {
      toast.error(isForex ? "Complete the InstaForex account and selected transport fields" : "Please enter API Key and API Secret")
      return
    }

    setTesting(true)
    setTestLog([])
    setShowTestLog(true)

    try {
      const response = await fetch("/api/settings/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: formData.exchange,
          market_type: formData.market_type,
          account_id: isForex ? formData.account_id : undefined,
          api_type: isForex ? "forex" : formData.api_type,
          api_subtype: formData.api_subtype,
          api_key: isForex ? formData.account_id : formData.api_key,
          api_secret: isForex ? "" : formData.api_secret,
          api_passphrase: formData.api_passphrase || "",
          symbol_suffix: isForex ? formData.symbol_suffix : undefined,
          connection_method: isForex ? (forexBridgeSelected ? "bridge" : "rest") : formData.connection_method,
          connection_library: isForex ? (forexBridgeSelected ? "mt5-bridge" : "native-http") : formData.connection_library,
          forex_execution_mode: isForex ? (forexBridgeSelected ? "mt5_bridge" : "read_only") : undefined,
          execution_mode: isForex ? (forexBridgeSelected ? "mt5_bridge" : "read_only") : undefined,
          read_only: isForex ? !forexBridgeSelected : undefined,
          execution_supported: isForex ? forexBridgeSelected : undefined,
          account_password: forexBridgeSelected ? formData.account_password : undefined,
          account_server: forexBridgeSelected ? formData.account_server : undefined,
          bridge_url: forexBridgeSelected ? formData.bridge_url : undefined,
          bridge_token: forexBridgeSelected ? formData.bridge_token : undefined,
          terminal_path: forexBridgeSelected ? formData.terminal_path : undefined,
          is_testnet: formData.is_testnet,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Connection test failed")
      }

      const data = await response.json()
      if (!data.success) {
        setTestLog(data.log || [`Error: ${data.error || "Test failed"}`])
        toast.error(data.error || "Connection test failed")
        return
      }

      let logs = [`✓ ${isForex ? "InstaForex Forex HTTP read-only test PASSED" : "Connection test PASSED - Ready to use!"}`]
      if (data.balance !== undefined) {
        logs.push(`✓ Account Balance: $${parseFloat(data.balance).toFixed(2)}`)
      }
      setTestLog(logs)
      toast.success("Connection test passed!")
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Test connection error"
      setTestLog([`✗ Error: ${errorMsg}`])
      toast.error(errorMsg)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!validateForm()) return

    setIsSaving(true)
    try {
      await onSave({
        ...formData,
        market_type: formData.market_type,
        account_id: formData.market_type === "forex" ? formData.account_id : undefined,
        api_type: formData.market_type === "forex" ? "forex" : formData.api_type,
        api_key: formData.market_type === "forex" ? formData.account_id : formData.api_key,
        api_secret: formData.market_type === "forex" ? "" : formData.api_secret,
        connection_method: isForex ? (forexBridgeSelected ? "bridge" : "rest") : formData.connection_method,
        connection_library: isForex ? (forexBridgeSelected ? "mt5-bridge" : "native-http") : formData.connection_library,
        ...(formData.market_type === "forex" ? {
          symbol_suffix: formData.symbol_suffix,
          forex_execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
          execution_mode: forexBridgeSelected ? "mt5_bridge" : "read_only",
          read_only: !forexBridgeSelected,
          execution_supported: forexBridgeSelected,
          account_password: forexBridgeSelected ? formData.account_password : undefined,
          account_server: forexBridgeSelected ? formData.account_server : undefined,
          bridge_url: forexBridgeSelected ? formData.bridge_url : undefined,
          bridge_token: forexBridgeSelected ? formData.bridge_token : undefined,
          terminal_path: forexBridgeSelected ? formData.terminal_path : undefined,
        } : {}),
        is_testnet: formData.market_type === "forex" ? false : formData.is_testnet,
        volume_factor: MIN_VOLUME_FACTOR,
      })
      toast.success("Connection Updated", {
        description: "Connection settings have been saved successfully",
      })
      // Notify dashboard components so stats/cards refresh instantly
      window.dispatchEvent(
        new CustomEvent("connection-settings-updated", { detail: { connectionId: connection?.id } }),
      )
      onClose()
    } catch (error) {
      toast.error("Save Failed", {
        description: error instanceof Error ? error.message : "Failed to save connection",
      })
    } finally {
      setIsSaving(false)
    }
  }

  if (!connection) return null

  const availableApiTypes = EXCHANGE_API_TYPES[formData.exchange] || []
  const selectedExchange = ALL_EXCHANGES.find((e) => e.id === formData.exchange)
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-4xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Connection: {connection.name}</DialogTitle>
          <DialogDescription>
            Update connection settings for {connection.exchange}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-6">
          {/* Tabs for Configuration */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="api">API Credentials</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            {/* Basic Info Tab */}
            <TabsContent value="basic" className="space-y-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="font-medium text-xs">Connection Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => handleChange("name", e.target.value)}
                    placeholder="e.g., Main Account"
                    disabled={isSaving}
                    className={`bg-background text-sm h-8 ${errors.name ? "border-red-500" : ""}`}
                  />
                  {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="exchange" className="font-medium text-xs">Exchange</Label>
                  <Select value={formData.exchange} onValueChange={(value) => handleChange("exchange", value)}>
                    <SelectTrigger id="exchange" disabled={isSaving} className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_EXCHANGES.map((exchange) => (
                        <SelectItem key={exchange.id} value={exchange.id}>
                          {exchange.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="market-type" className="font-medium text-xs">Market Type</Label>
                  <Select
                    value={formData.market_type}
                    onValueChange={(value) => handleChange("market_type", value)}
                    disabled={isSaving}
                  >
                    <SelectTrigger id="market-type" className="bg-background h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="crypto">Crypto</SelectItem>
                      <SelectItem value="forex">Forex (InstaForex)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{isForex ? (forexBridgeSelected ? "Broker data via official REST and authenticated order/protection bridge." : "Broker quotes and account history through official read-only HTTP feeds.") : marketTypeLabel("crypto") + " venue connection"}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="api-type" className="font-medium text-xs">API Type</Label>
                  <Select value={isForex ? "forex" : formData.api_type} onValueChange={(value) => handleChange("api_type", value)} disabled={isSaving || isForex}>
                    <SelectTrigger id="api-type" disabled={isSaving} className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableApiTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          <span className="capitalize text-sm">{type.replace(/_/g, " ")}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(formData.exchange === "bingx" || formData.exchange === "pionex" || formData.exchange === "orangex") && formData.api_type === "spot" && (
                    <p className="text-xs text-amber-600 mt-1">
                      ⚠️ Warning: Spot API will show 0 balance if you have Perpetual Futures positions. Use "perpetual_futures" for futures trading.
                    </p>
                  )}
                </div>

                {formData.api_type === "unified" && EXCHANGE_SUBTYPES[formData.exchange] && EXCHANGE_SUBTYPES[formData.exchange].length > 0 && (
                  <div className="space-y-1.5 col-span-2">
                    <Label htmlFor="api-subtype" className="font-medium text-xs">Trading Type (Unified Account)</Label>
                    <Select value={formData.api_subtype} onValueChange={(value) => handleChange("api_subtype", value)}>
                      <SelectTrigger id="api-subtype" disabled={isSaving} className="bg-background h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(EXCHANGE_SUBTYPES[formData.exchange] || []).map((subtype) => {
                          const subtypeInfo = API_SUBTYPES[subtype as keyof typeof API_SUBTYPES]
                          return (
                            <SelectItem key={subtype} value={subtype}>
                              <span className="text-sm">{subtypeInfo?.icon || ''} {subtypeInfo?.label || subtype}</span>
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Select the trading type for your unified trading account
                    </p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="connection-method" className="font-medium text-xs">Connection</Label>
                  <Select value={formData.connection_method} onValueChange={(value) => handleChange("connection_method", value)}>
                    <SelectTrigger id="connection-method" disabled={isSaving} className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(EXCHANGE_CONNECTION_METHODS[formData.exchange] || ["rest"]).map((method) => {
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

                <div className="space-y-1.5">
                  <Label htmlFor="connection-library" className="font-medium text-xs">Library</Label>
                  <Select value={formData.connection_library || "native"} onValueChange={(value) => handleChange("connection_library", value)}>
                    <SelectTrigger id="connection-library" disabled={isSaving} className="bg-background h-8 text-sm">
                      <SelectValue placeholder="Select library..." />
                    </SelectTrigger>
                    <SelectContent>
                      {isForex ? (
                        <>
                          <SelectItem value="native-http"><span className="text-sm">Official HTTP (read-only)</span></SelectItem>
                          <SelectItem value="mt5-bridge"><span className="text-sm">Private MT4/MT5 bridge (execution)</span></SelectItem>
                        </>
                      ) : (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                          {formData.exchange === "bingx" ? (
                            <SelectItem value="sdk"><span className="text-sm">bingx-api package (Default)</span></SelectItem>
                          ) : (
                            <SelectItem value="original"><span className="text-sm">Original - {EXCHANGE_LIBRARY_PACKAGES[formData.exchange] || "SDK"}</span></SelectItem>
                          )}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formData.connection_library === "native-http" && "Official InstaForex HTTP feeds (read-only)"}
                    {formData.connection_library === "mt5-bridge" && "Authenticated private terminal bridge with native ticket-bound SL/TP"}
                    {formData.connection_library === "native" && "Built-in native implementation"}
                    {formData.connection_library === "sdk" && "Native bingx-api package with signed REST fallback"}
                    {formData.connection_library === "original" && `${formData.exchange.toUpperCase()} exchange library`}
                    {formData.connection_library === "ccxt" && "Universal CCXT library (cross-exchange)"}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="margin-type" className="font-medium text-xs">Margin Type</Label>
                  <Select value={formData.margin_type} onValueChange={(value) => handleChange("margin_type", value)}>
                    <SelectTrigger id="margin-type" disabled={isSaving || isForex} className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cross">Cross</SelectItem>
                      <SelectItem value="isolated">Isolated</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="position-mode" className="font-medium text-xs">Position Mode</Label>
                  <Select value={formData.position_mode} onValueChange={(value) => handleChange("position_mode", value)}>
                    <SelectTrigger id="position-mode" disabled={isSaving || isForex} className="bg-background h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hedge">Hedge</SelectItem>
                      <SelectItem value="one_way">One-way</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="volume_factor">Base Coordination Factor</Label>
                  <Input
                    id="volume_factor"
                    type="number"
                    value={MIN_VOLUME_FACTOR}
                    readOnly
                    disabled
                    className="bg-muted h-8 text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Fixed at 1.0. Main, Preset and Signal volume use their independent sliders.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 border-t">
                <div>
                  <Label className="font-medium text-xs">Environment</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isForex ? (forexBridgeSelected ? "Private bridge · real broker account" : "Read-only broker data") : formData.is_testnet ? "Paper trading" : "Live trading"}
                  </p>
                </div>
                <Switch
                  checked={isForex ? false : formData.is_testnet}
                  onCheckedChange={(checked) => handleChange("is_testnet", checked)}
                  disabled={isSaving || isForex}
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
                  <div className="space-y-2">
                    <Label htmlFor="instaforex-account-id" className="font-medium flex items-center gap-2">
                      <Lock className="h-4 w-4" />
                      InstaForex account ID / login
                    </Label>
                    <Input
                      id="instaforex-account-id"
                      inputMode="numeric"
                      value={formData.account_id}
                      onChange={(e) => handleChange("account_id", e.target.value.replace(/\D/g, ""))}
                      placeholder="Numeric account login"
                      disabled={isSaving}
                      className={`bg-background ${errors.account_id ? "border-red-500" : ""}`}
                    />
                    {errors.account_id && <p className="text-xs text-red-500">{errors.account_id}</p>}
                    <p className="text-xs text-muted-foreground">
                      {forexBridgeSelected
                        ? "Official REST remains the data source; the private bridge handles authenticated orders and native ticket-bound protection."
                        : "Official InstaForex HTTP feeds read quotes, account state, and history. They are read-only; order execution is unavailable through these published APIs."}
                    </p>
                    {forexBridgeSelected && (
                      <div className="mt-3 grid gap-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="edit-account-password">Trader password</Label>
                          <Input id="edit-account-password" type={showSecrets ? "text" : "password"} value={formData.account_password} onChange={(e) => handleChange("account_password", e.target.value)} placeholder={storedBridgePassword ? "Leave blank to keep stored password" : "Private bridge only"} disabled={isSaving} />
                          {errors.account_password && <p className="text-xs text-red-500">{errors.account_password}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="edit-account-server">Broker server (optional)</Label>
                          <Input id="edit-account-server" value={formData.account_server} onChange={(e) => handleChange("account_server", e.target.value)} placeholder="Broker server" disabled={isSaving} />
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label htmlFor="edit-bridge-url">Private bridge URL</Label>
                          <Input id="edit-bridge-url" type="url" value={formData.bridge_url} onChange={(e) => handleChange("bridge_url", e.target.value)} placeholder="http://127.0.0.1:8765" disabled={isSaving} />
                          {errors.bridge_url && <p className="text-xs text-red-500">{errors.bridge_url}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="edit-bridge-token">Bridge token (optional on loopback)</Label>
                          <Input id="edit-bridge-token" type={showSecrets ? "text" : "password"} value={formData.bridge_token} onChange={(e) => handleChange("bridge_token", e.target.value)} placeholder="Bearer token" disabled={isSaving} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="edit-terminal-path">Terminal path/instance</Label>
                          <Input id="edit-terminal-path" value={formData.terminal_path} onChange={(e) => handleChange("terminal_path", e.target.value)} placeholder="Optional MT4/MT5 instance" disabled={isSaving} />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="api-key" className="font-medium flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        API Key
                      </Label>
                      <div className="relative">
                        <Input
                          id="api-key"
                          type={showSecrets ? "text" : "password"}
                          value={formData.api_key}
                          onChange={(e) => handleChange("api_key", e.target.value)}
                          placeholder="Enter your API Key"
                          disabled={isSaving}
                          className={`pr-10 bg-background ${errors.api_key ? "border-red-500" : ""}`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecrets(!showSecrets)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {errors.api_key && <p className="text-xs text-red-500">{errors.api_key}</p>}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="api-secret" className="font-medium flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        API Secret
                      </Label>
                      <Input
                        id="api-secret"
                        type={showSecrets ? "text" : "password"}
                        value={formData.api_secret}
                        onChange={(e) => handleChange("api_secret", e.target.value)}
                        placeholder="Enter your API Secret"
                        disabled={isSaving}
                        className={`bg-background ${errors.api_secret ? "border-red-500" : ""}`}
                      />
                      {errors.api_secret && <p className="text-xs text-red-500">{errors.api_secret}</p>}
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label htmlFor="api-passphrase" className="font-medium">API Passphrase (Optional)</Label>
                  <Input
                    id="api-passphrase"
                    type={showSecrets ? "text" : "password"}
                    value={formData.api_passphrase}
                    onChange={(e) => handleChange("api_passphrase", e.target.value)}
                    placeholder="Leave blank if not required"
                    disabled={isSaving}
                    className="bg-background"
                  />
                  <p className="text-xs text-muted-foreground">{isForex ? "Not used by the read-only InstaForex HTTP integration." : "Required only for some exchanges (e.g., OKX, Coinbase)"}</p>
                </div>
              </div>
            </TabsContent>

            {/* Advanced Tab */}
            <TabsContent value="advanced" className="space-y-4 mt-4">
              {/* Test Connection Section */}
              <Card className="border-orange-200 bg-orange-50/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Test Connection
                  </CardTitle>
                  <CardDescription>Verify your credentials before saving</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={testing || !connectionReady || isSaving}
                      className="flex-1 bg-orange-600 hover:bg-orange-700"
                    >
                      {testing ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <Zap className="h-4 w-4 mr-2" />
                          Test Connection
                        </>
                      )}
                    </Button>
                  </div>

                  {showTestLog && testLog.length > 0 && (
                    <div className="space-y-2">
                      <div className="bg-slate-900 text-slate-100 p-4 rounded font-mono text-xs space-y-1 max-h-56 overflow-y-auto border border-slate-700 whitespace-pre-wrap">
                        {testLog.map((log, idx) => (
                          <div key={idx} className="text-slate-300 leading-relaxed">
                            {log}
                          </div>
                        ))}
                      </div>
                      <Button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testing || isSaving}
                        variant="outline"
                        size="sm"
                        className="w-full"
                      >
                        {testing ? "Testing..." : "Test Again"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Form Actions */}
          <div className="flex gap-2 justify-end pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSaving || testing}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={isSaving || testing}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
