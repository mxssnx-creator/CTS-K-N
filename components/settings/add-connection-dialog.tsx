"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, Lock, ExternalLink, Check, Eye, EyeOff, Zap, ChevronDown } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { isHTMLResponse, parseHTMLResponse, parseCloudflareError } from "@/lib/html-response-parser"
import type { Connection } from "@/lib/db-types"
import {
  CONNECTION_PREDEFINITIONS,
  type ConnectionPredefinition,
  EXCHANGE_API_TYPES,
  EXCHANGE_LIBRARY_PACKAGES,
  CONNECTION_METHODS,
  API_SUBTYPES,
  EXCHANGE_SUBTYPES,
  EXCHANGE_CONNECTION_METHODS,
} from "@/lib/connection-predefinitions"

interface AddConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectionAdded?: (connectionId?: string) => Promise<void> | void
  onSuccess?: (connectionId?: string) => void
  showOnlyEnabled?: boolean
}

const ALL_EXCHANGES = [
  { id: "bybit", name: "Bybit" },
  { id: "bingx", name: "BingX" },
  { id: "pionex", name: "Pionex" },
  { id: "orangex", name: "OrangeX" },
]

export function AddConnectionDialog({ open, onOpenChange, onConnectionAdded, onSuccess, showOnlyEnabled = false }: AddConnectionDialogProps) {
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testLog, setTestLog] = useState<string[]>([])
  const [showTestLog, setShowTestLog] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<ConnectionPredefinition | null>(null)
  const [existingConnections, setExistingConnections] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState("basic")
  const [showSecrets, setShowSecrets] = useState(false)

  const [formData, setFormData] = useState({
    name: "",
    exchange: "bybit",
    api_type: "perpetual_futures",
    api_subtype: "perpetual",
    connection_method: "rest",
    connection_library: "native",
    api_key: "",
    api_secret: "",
    api_passphrase: "",
    margin_type: "cross",
    position_mode: "hedge",
    is_testnet: false, // ALWAYS MAINNET
  })

  useEffect(() => {
    if (open) {
      loadExistingConnections()
      setActiveTab("basic")
      resetForm()
      setTestLog([])
      setShowTestLog(false)
    }
  }, [open])

  useEffect(() => {
    // Update API type based on exchange. Use the functional updater to avoid
    // capturing stale `formData` — the dependency array only lists `exchange`
    // but the callback reads and spreads the whole form object.
    const apiTypes = EXCHANGE_API_TYPES[formData.exchange] || []
    if (apiTypes.length > 0 && !apiTypes.includes(formData.api_type)) {
      setFormData(prev => ({ ...prev, api_type: apiTypes[0] }))
    }

  }, [formData.exchange])

  useEffect(() => {
    // When switching to Advanced tab, show test instructions if credentials are filled
    if (activeTab === "advanced" && formData.api_key && formData.api_secret && !showTestLog) {
      // Auto-show test log UI to guide user
      setShowTestLog(true)
    }
    // Hide test log when leaving advanced tab
    if (activeTab !== "advanced" && showTestLog) {
      setShowTestLog(false)
    }
  }, [activeTab, formData.api_key, formData.api_secret, showTestLog])

  useEffect(() => {
    // Update connection method and library based on API type and exchange
    const exchange = formData.exchange
    const availableMethods = EXCHANGE_CONNECTION_METHODS[exchange] || ["rest"]

    // Set default connection method if current is not available
    if (!availableMethods.includes(formData.connection_method)) {
      setFormData(prev => ({ ...prev, connection_method: availableMethods[0] }))
    }

    // Set default library based on connection method
    let defaultLibrary = "native"
    if (formData.connection_method === "rest") {
      defaultLibrary = "native"
    } else if (formData.connection_method === "websocket") {
      defaultLibrary = "native"
    } else if (formData.connection_method === "library") {
      defaultLibrary = "original"
    }

    if (formData.connection_library !== defaultLibrary) {
      setFormData(prev => ({ ...prev, connection_library: defaultLibrary }))
    }
  }, [formData.exchange, formData.connection_method])

  const loadExistingConnections = async () => {
    try {
      const response = await fetch("/api/settings/connections")
      if (!response.ok) {
        console.error("[v0] Failed to load connections:", response.status)
        return
      }

      let data
      try {
        data = await response.json()
      } catch (parseError) {
        console.error("[v0] Failed to parse connections response:", parseError)
        return
      }

      const connections = Array.isArray(data) ? data : (data?.connections || [])
      const names = connections.map((c: Connection) => `${c.exchange}-${c.name}`)
      setExistingConnections(names)
    } catch (error) {
      console.error("[v0] Error loading existing connections:", error)
    }
  }

  const resetForm = () => {
    setFormData({
      name: "",
      exchange: "bybit",
      api_type: "perpetual_futures",
      api_subtype: "perpetual",
      connection_method: "rest",
      connection_library: "native",
      api_key: "",
      api_secret: "",
      api_passphrase: "",
      margin_type: "cross",
      position_mode: "hedge",
      is_testnet: false,
    })
    setSelectedTemplate(null)
  }

  const handleSelectTemplate = (template: ConnectionPredefinition) => {
    setSelectedTemplate(template)
    setFormData({
      name: template.displayName,
      exchange: template.exchange,
      api_type: template.apiType,
      api_subtype: "perpetual",
      connection_method: "rest",
      connection_library: "native",
      api_key: template.apiKey || "",
      api_secret: template.apiSecret || "",
      api_passphrase: "",
      margin_type: template.marginType,
      position_mode: template.positionMode,
      is_testnet: template.testnetSupported ? false : false,
    })
  }

  const handleTestConnection = async () => {
    // Validate required credentials before testing
    if (!formData.api_key || !formData.api_secret) {
      toast.error("Please fill in API Key and Secret before testing")
      setTestLog([`✗ Error: Missing API credentials. Please enter your API Key and Secret in the "API Credentials" tab.`])
      setShowTestLog(true)
      return
    }

    if (!formData.name) {
      toast.error("Please enter a connection name")
      setTestLog([`✗ Error: Missing connection name. Please enter a name for this connection.`])
      setShowTestLog(true)
      return
    }

    setTesting(true)
    setShowTestLog(true)
    const logs: string[] = []

    try {
      logs.push(`[${new Date().toLocaleTimeString()}] Testing connection...`)
      logs.push(`Exchange: ${formData.exchange.toUpperCase()}`)
      const apiInfoParts = [formData.api_type]
      if (formData.api_type === "unified" && formData.api_subtype) {
        apiInfoParts.push(formData.api_subtype)
      }
      logs.push(`API Type: ${apiInfoParts.join(" | ")}`)
      logs.push(`Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}`)
      logs.push(`---`)

      const response = await fetch("/api/settings/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: formData.exchange,
          api_type: formData.api_type,
          ...(formData.api_type === "unified" && formData.api_subtype && { api_subtype: formData.api_subtype }),
          connection_method: formData.connection_method,
          connection_library: formData.connection_library,
          api_key: formData.api_key,
          api_secret: formData.api_secret,
          api_passphrase: formData.api_passphrase || "",
          margin_type: formData.margin_type,
          position_mode: formData.position_mode,
          is_testnet: formData.is_testnet,
        }),
      })

      let data
      try {
        data = await response.json()
      } catch (parseError) {
        console.error("[v0] JSON parse error:", parseError)
        throw new Error("Invalid response format from server")
      }

      // Check for errors in response data
      if (data.error) {
        const errorMsg = data.error
        setTestLog(data.log || [`Error: ${errorMsg}`])
        toast.error(errorMsg)
        return
      }

      if (!data.success) {
        const errorMsg = data.error || "Connection test failed"
        setTestLog(data.log || [`Error: ${errorMsg}`])
        toast.error(errorMsg)
        return
      }

      // Extract and format log
      let formattedLogs = [`[${new Date().toLocaleTimeString()}] Starting connection test...\n`]

      // Add API connection info
      formattedLogs.push(`Exchange: ${formData.exchange.toUpperCase()}\n`)
      const apiLogParts = [formData.api_type]
      if (formData.api_type === "unified" && formData.api_subtype) {
        apiLogParts.push(formData.api_subtype)
      }
      formattedLogs.push(`API Type: ${apiLogParts.join(" | ")}\n`)
      formattedLogs.push(`Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}\n`)
      formattedLogs.push(`---\n`)

      // Add response logs
      let responseLogs = data.log || []
      if (!Array.isArray(responseLogs)) {
        responseLogs = [responseLogs.toString()]
      }
      formattedLogs.push(...responseLogs)

      // Add balance and price info if available
      let balanceDisplay = ""
      if (data.balance !== undefined) {
        const balanceUSD = parseFloat(data.balance).toFixed(2)
        formattedLogs.push(`\n✓ Account Balance: $${balanceUSD}`)
        balanceDisplay = ` Balance: $${balanceUSD}`
      }

      // Fetch BTC price for context
      try {
        const priceResponse = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")
        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          const btcPrice = priceData.data?.amount || "N/A"
          formattedLogs.push(`✓ BTC Price: $${btcPrice}`)

        }
      } catch {
        // BTC price is decorative context — a fetch failure is non-fatal
      }

      if (response.ok) {
        formattedLogs.push(`\n✓ Connection test PASSED - Ready to trade!`)
        toast.success(`Connection successful!${balanceDisplay}`)
      } else {
        formattedLogs.push(`\n✗ Connection test FAILED: ${data.error || "Unknown error"}`)
        toast.error(data.error || "Connection test failed")
      }
      setTestLog(formattedLogs)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Test connection error"
      setTestLog([`✗ Error: ${errorMsg}`])
      toast.error(errorMsg)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.name || !formData.api_key || !formData.api_secret) {
      toast.error("Please fill in all required fields")
      return
    }

    const connectionKey = `${formData.exchange}-${formData.name}`
    if (existingConnections.includes(connectionKey)) {
      toast.error("Connection with this name already exists for this exchange")
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/settings/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          exchange: formData.exchange,
          api_type: formData.api_type,
          ...(formData.api_type === "unified" && formData.api_subtype && { api_subtype: formData.api_subtype }),
          connection_method: formData.connection_method,
          connection_library: formData.connection_library,
          api_key: formData.api_key,
          api_secret: formData.api_secret,
          api_passphrase: formData.api_passphrase || "",
          margin_type: formData.margin_type,
          position_mode: formData.position_mode,
          is_testnet: formData.is_testnet,
          is_enabled: true,
        }),
      })

      if (!response.ok) {
        const error = await response.json()

        // Handle duplicate API key error
        if (response.status === 409) {
          throw new Error(error.details || "This API key is already connected. Please remove the existing connection first.")
        }

        throw new Error(error.message || error.details || "Failed to add connection")
      }

      const result = await response.json()
      const connectionId = result.id || result.connectionId

      toast.success("Connection added successfully")

      // Call both callbacks if provided
      if (onConnectionAdded) {
        await onConnectionAdded(connectionId)
      }
      if (onSuccess) {
        onSuccess(connectionId)
      }

      onOpenChange(false)
      resetForm()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add connection")
    } finally {
      setLoading(false)
    }
  }

  const selectedExchange = ALL_EXCHANGES.find((e) => e.id === formData.exchange)
  const availableApiTypes = EXCHANGE_API_TYPES[formData.exchange] || []
  const libraryPackage = EXCHANGE_LIBRARY_PACKAGES[formData.exchange] || "unknown"

  // Map API types to trading types
  const getTradingTypeFromApiType = (apiType: string): string => {
    if (apiType.includes("spot")) return "spot"
    if (apiType.includes("margin")) return "margin"
    if (apiType.includes("perpetual") || apiType.includes("futures") || apiType.includes("unified") || apiType.includes("contract")) {
      return "derivatives"
    }
    return "derivatives"
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Exchange Connection</DialogTitle>
          <DialogDescription>
            Configure and test a new exchange API connection. Select a template or enter custom details.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Template Selection */}
          <Card className="border border-blue-200 bg-blue-50/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-blue-600" />
                Quick Setup - Select Predefined Template
              </CardTitle>
              <CardDescription>Optional: Choose a template to auto-fill settings</CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={selectedTemplate?.id || ""} onValueChange={(templateId) => {
                const template = CONNECTION_PREDEFINITIONS.find(t => t.id === templateId)
                if (template) handleSelectTemplate(template)
              }}>
                <SelectTrigger className="w-full bg-white">
                  <SelectValue placeholder="Select a predefined template..." />
                </SelectTrigger>
                <SelectContent>
                  {CONNECTION_PREDEFINITIONS.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      <div className="flex items-center gap-2">
                        <span>{template.displayName}</span>
                        <Badge variant="secondary" className="text-xs">{template.maxLeverage}x</Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

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
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Main Account"
                    disabled={loading}
                    className="bg-white text-sm h-8"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="exchange" className="font-medium text-xs">Exchange</Label>
                  <Select value={formData.exchange} onValueChange={(value) => setFormData({ ...formData, exchange: value })}>
                    <SelectTrigger id="exchange" disabled={loading} className="bg-white h-8 text-sm">
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
                  <Label htmlFor="api-type" className="font-medium text-xs">API Type</Label>
                  <Select value={formData.api_type} onValueChange={(value) => setFormData({ ...formData, api_type: value })}>
                    <SelectTrigger id="api-type" disabled={loading} className="bg-white h-8 text-sm">
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
                    <Select value={formData.api_subtype} onValueChange={(value) => setFormData({ ...formData, api_subtype: value })}>
                      <SelectTrigger id="api-subtype" disabled={loading} className="bg-white h-8 text-sm">
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
                  <Select value={formData.connection_method} onValueChange={(value) => setFormData({ ...formData, connection_method: value })}>
                    <SelectTrigger id="connection-method" disabled={loading} className="bg-white h-8 text-sm">
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
                  <Select value={formData.connection_library || "native"} onValueChange={(value) => setFormData({ ...formData, connection_library: value })}>
                    <SelectTrigger id="connection-library" disabled={loading} className="bg-white h-8 text-sm">
                      <SelectValue placeholder="Select library..." />
                    </SelectTrigger>
                    <SelectContent>
                      {formData.connection_method === "rest" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                      {formData.connection_method === "library" && (
                        <>
                          <SelectItem value="original"><span className="text-sm">Original - {EXCHANGE_LIBRARY_PACKAGES[formData.exchange] || "Exchange SDK"}</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                      {formData.connection_method === "websocket" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                        </>
                      )}
                      {formData.connection_method === "hybrid" && (
                        <>
                          <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                          <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formData.connection_library === "native" && "Built-in native implementation"}
                    {formData.connection_library === "original" && `Official ${formData.exchange.toUpperCase()} SDK`}
                    {formData.connection_library === "ccxt" && "Universal CCXT library (cross-exchange)"}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="margin-type" className="font-medium text-xs">Margin Type</Label>
                  <Select value={formData.margin_type} onValueChange={(value) => setFormData({ ...formData, margin_type: value })}>
                    <SelectTrigger id="margin-type" disabled={loading} className="bg-white h-8 text-sm">
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
                  <Select value={formData.position_mode} onValueChange={(value) => setFormData({ ...formData, position_mode: value })}>
                    <SelectTrigger id="position-mode" disabled={loading} className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hedge">Hedge</SelectItem>
                      <SelectItem value="one-way">One-way</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 border-t">
                <div>
                  <Label className="font-medium text-xs">Testnet</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formData.is_testnet ? "Paper trading" : "Live trading"}
                  </p>
                </div>
                <Switch
                  checked={formData.is_testnet}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_testnet: checked })}
                  disabled={loading}
                />
              </div>

              {/* Rate Limit Info - Show only for REST and WebSocket */}
              {(formData.connection_method === "rest" || formData.connection_method === "websocket") && (
                <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded p-3 text-xs">
                  <div className="font-semibold text-blue-900 dark:text-blue-200 mb-2">
                    Rate Limits ({formData.connection_method === "rest" ? "REST API" : "WebSocket"})
                  </div>
                  <div className="text-blue-800 dark:text-blue-300 space-y-1">
                    {formData.connection_method === "rest" ? (
                      <>
                        <div>• Public requests: 1000 per 10 seconds</div>
                        <div>• Private requests: 100 per 10 seconds</div>
                        <div>• Recommended delay: 10-50ms between requests</div>
                        <div>• Check exchange docs for tier-specific limits</div>
                      </>
                    ) : (
                      <>
                        <div>• Unlimited message rate on WebSocket</div>
                        <div>• Max 10 concurrent connections</div>
                        <div>• Best for real-time market data</div>
                        <div>• Lower latency than REST polling</div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Library/Hybrid Info */}
              {(formData.connection_method === "library" || formData.connection_method === "hybrid") && (
                <div className="bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800 rounded p-3 text-xs">
                  <div className="font-semibold text-purple-900 dark:text-purple-200 mb-2">
                    Library Configuration ({formData.connection_library === "native" ? "Native" : formData.connection_library === "ccxt" ? "CCXT" : "Original SDK"})
                  </div>
                  <div className="text-purple-800 dark:text-purple-300 space-y-1">
                    {formData.connection_library === "native" ? (
                      <>
                        <div>• Built-in implementation</div>
                        <div>• Optimized for this exchange</div>
                        <div>• No external dependencies</div>
                        <div>• Fast and reliable</div>
                      </>
                    ) : formData.connection_library === "ccxt" ? (
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
              )}
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
                  <Label htmlFor="api-key" className="font-medium flex items-center gap-2">
                    <Lock className="h-4 w-4" />
                    API Key
                  </Label>
                  <div className="relative">
                    <Input
                      id="api-key"
                      type={showSecrets ? "text" : "password"}
                      value={formData.api_key}
                      onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                      placeholder="Enter your API Key"
                      disabled={loading}
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
                  <Label htmlFor="api-secret" className="font-medium flex items-center gap-2">
                    <Lock className="h-4 w-4" />
                    API Secret
                  </Label>
                  <Input
                    id="api-secret"
                    type={showSecrets ? "text" : "password"}
                    value={formData.api_secret}
                    onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                    placeholder="Enter your API Secret"
                    disabled={loading}
                    className="bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="api-passphrase" className="font-medium">API Passphrase (Optional)</Label>
                  <Input
                    id="api-passphrase"
                    type={showSecrets ? "text" : "password"}
                    value={formData.api_passphrase}
                    onChange={(e) => setFormData({ ...formData, api_passphrase: e.target.value })}
                    placeholder="Leave blank if not required"
                    disabled={loading}
                    className="bg-white"
                  />
                  <p className="text-xs text-muted-foreground">Required only for some exchanges (e.g., OKX, Coinbase)</p>
                </div>
              </div>
            </TabsContent>

            {/* Advanced Tab */}
            <TabsContent value="advanced" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="connection-library" className="font-medium">Connection Library</Label>
                <Select value={formData.connection_library} onValueChange={(value) => setFormData({ ...formData, connection_library: value })}>
                  <SelectTrigger id="connection-library" disabled={loading} className="bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="native">Native SDK (Recommended)</SelectItem>
                    <SelectItem value="ccxt">CCXT Universal Library</SelectItem>
                    <SelectItem value="library">Built-in Library</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {formData.connection_library === "native" && "Official exchange SDK - Best performance and feature support"}
                  {formData.connection_library === "ccxt" && "Universal library supporting 100+ exchanges"}
                  {formData.connection_library === "library" && "Built-in optimized connector"}
                </p>
              </div>

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
                  {/* Validation warning if credentials are missing */}
                  {(!formData.api_key || !formData.api_secret) && (
                    <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                      <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-medium">Please fill in API credentials first</p>
                        <p className="text-amber-800">Switch to the "API Credentials" tab to enter your API Key and Secret</p>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={testing || !formData.api_key || !formData.api_secret || loading}
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
                    {showTestLog && testLog.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={testing || loading}
                        className="flex items-center gap-2"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View Logs
                      </Button>
                    )}
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
                        disabled={testing || loading || !formData.api_key || !formData.api_secret}
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
              onClick={() => onOpenChange(false)}
              disabled={loading || testing}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || testing}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Add Connection
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
