"use client"

import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConnectionPredefinitionSelector } from "./connection-predefinition-selector"
import { Save, Loader2, ExternalLink, Info } from 'lucide-react'
import { toast } from "@/lib/simple-toast"
import { EXCHANGE_CONFIGS, getExchangeConfig } from "@/lib/config"
import { CONNECTION_PREDEFINITIONS } from "@/lib/connection-predefinitions"

interface ExchangeConfig {
  name: string
  library: string
  packageName: string
  api_types: Array<{
    value: string
    label: string
    description: string
    capabilities: string[]
  }>
  connection_methods: Array<{
    value: string
    label: string
    description: string
    priority: number
    packageName?: string
  }>
  rate_limits: {
    requests_per_second: number
    requests_per_minute: number
  }
  docs_url: string
}

const EXCHANGE_API_CONFIGS: Record<string, ExchangeConfig> = {
  bybit: {
    name: "Bybit",
    library: "pybit",
    packageName: "pybit",
    api_types: [
      {
        value: "unified",
        label: "Unified Trading Account",
        description: "Multi-asset unified margin account",
        capabilities: ["leverage", "hedge_mode", "trailing", "spot", "futures"],
      },
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library",
        description: "Official Python SDK",
        packageName: "pybit",
        priority: 2,
      },
      { value: "typescript", label: "TypeScript Native", description: "Native TypeScript implementation", priority: 3 },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 120 },
    docs_url: "https://bybit-exchange.github.io/docs/",
  },
  bingx: {
    name: "BingX",
    library: "sdk",
    packageName: "bingx-api",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Node Library",
        description: "bingx-api fast path with signed REST fallback",
        packageName: "bingx-api",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://bingx-api.github.io/docs/",
  },
  binance: {
    name: "Binance",
    library: "python-binance",
    packageName: "python-binance",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library",
        description: "Official Python SDK",
        packageName: "python-binance",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 1200 },
    docs_url: "https://binance-docs.github.io/apidocs/",
  },
  okx: {
    name: "OKX",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 20, requests_per_minute: 600 },
    docs_url: "https://www.okx.com/docs-v5/en/",
  },
  gateio: {
    name: "Gate.io",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 900 },
    docs_url: "https://www.gate.io/docs/developers/apiv4/",
  },
  pionex: {
    name: "Pionex",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage", "hedge_mode"],
      },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://pionex-doc.gitbook.io/apidocs/",
  },
  orangex: {
    name: "OrangeX",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://openapi-docs.orangex.com/",
  },
  mexc: {
    name: "MEXC",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://mexcdevelop.github.io/apidocs/",
  },
  bitget: {
    name: "Bitget",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://bitgetlimited.github.io/apidoc/en/mix/",
  },
  kucoin: {
    name: "KuCoin",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 300 },
    docs_url: "https://docs.kucoin.com/",
  },
  huobi: {
    name: "Huobi",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://huobiapi.github.io/docs/spot/v1/en/",
  },
}

interface ConnectionForm {
  name: string
  exchange: string
  api_type: string
  connection_method: string
  connection_library: string
  api_key: string
  api_secret: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
}

interface ExchangeConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  connection?: any
  existingConnections?: any[]
}

export function ExchangeConnectionDialog({
  open,
  onOpenChange,
  onSuccess,
  connection,
  existingConnections = [],
}: ExchangeConnectionDialogProps) {
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<ConnectionForm>({
    name: "",
    exchange: "bybit",
    api_type: "perpetual_futures",
    connection_method: "library",
    connection_library: "pybit",
    api_key: "",
    api_secret: "",
    margin_type: "cross",
    position_mode: "hedge",
    is_testnet: false,
  })

  useEffect(() => {
    if (connection) {
      setForm({
        name: connection.name || "",
        exchange: connection.exchange || "bybit",
        api_type: connection.api_type || "perpetual_futures",
        connection_method: connection.connection_method || "library",
        connection_library: connection.connection_library || "pybit",
        api_key: connection.api_key || "",
        api_secret: connection.api_secret || "",
        margin_type: connection.margin_type || "cross",
        position_mode: connection.position_mode || "hedge",
        is_testnet: connection.is_testnet || false,
      })
    } else {
      setForm({
        name: "",
        exchange: "bybit",
        api_type: "perpetual_futures",
        connection_method: "library",
        connection_library: "pybit",
        api_key: "",
        api_secret: "",
        margin_type: "cross",
        position_mode: "hedge",
        is_testnet: false,
      })
    }
  }, [connection, open])

  useEffect(() => {
    const config = EXCHANGE_API_CONFIGS[form.exchange]
    if (config) {
      setForm((prev) => ({
        ...prev,
        connection_library: config.library,
        api_type: config.api_types[0]?.value || "perpetual_futures",
      }))
    }
  }, [form.exchange])

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error("Please enter a connection name")
      return
    }
    if (!form.api_key.trim() || !form.api_secret.trim()) {
      toast.error("Please enter API key and secret")
      return
    }

    setSaving(true)
    try {
      const [indicationRes, strategyRes, settingsRes] = await Promise.all([
        fetch("/api/settings/indications/main"),
        fetch("/api/settings/strategy"),
        fetch("/api/settings"),
      ])

      const indicationSettings = indicationRes.ok ? await indicationRes.json() : null
      const strategySettings = strategyRes.ok ? await strategyRes.json() : null
      const globalSettings = settingsRes.ok ? await settingsRes.json() : null

      const url = connection ? `/api/settings/connections/${connection.id}` : "/api/settings/connections"
      const method = connection ? "PATCH" : "POST"

      const payload = {
        ...form,
        connection_settings: {
          // Volume factor only for active connections (not predefined)
          baseVolumeFactor: globalSettings?.base_volume_factor ?? MIN_VOLUME_FACTOR,
          baseVolumeFactorLive: MIN_VOLUME_FACTOR,
          baseVolumeFactorPreset: MIN_VOLUME_FACTOR,
          
          // Use indication settings as defaults
          indicationTimeInterval: indicationSettings?.direction?.interval || 1,
          indicationTimeout: indicationSettings?.direction?.timeout || 3,
          indicationMinProfitFactor: globalSettings?.indication_min_profit_factor || 0.7,
          
          // Use strategy settings as defaults
          strategyMinProfitFactor: globalSettings?.strategy_min_profit_factor || 0.5,
          liveTradeProfitFactorMinBase: 0.6,
          liveTradeProfitFactorMinMain: 0.6,
          liveTradeProfitFactorMinReal: 0.6,
          liveTradeDrawdownTimeHours: 12,
          presetTradeProfitFactorMinBase: 0.6,
          presetTradeProfitFactorMinMain: 0.6,
          presetTradeProfitFactorMinReal: 0.6,
          presetTradeDrawdownTimeHours: 12,
          
          // Strategy toggles from global settings
          trailingWithTrailing: strategySettings?.trailing_enabled ?? true,
          trailingOnly: false,
          blockEnabled: strategySettings?.block_enabled ?? true,
          blockOnly: false,
          dcaEnabled: strategySettings?.dca_enabled ?? false,
          dcaOnly: false,
          presetTradeBlockEnabled: true,
          presetTradeDcaEnabled: false,
          
          // Symbol settings
          useMainSymbols: globalSettings?.use_main_symbols ?? false,
          arrangementType: "market_cap_24h",
          arrangementCount: 10,
          volumeRangePercentage: 20,
          targetPositions: globalSettings?.positions_average || 300,
        },
      }

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }))
        throw new Error(errorData.details || errorData.error || "Failed to save connection")
      }

      toast.success(connection ? "Connection updated successfully" : "Connection added successfully")
      // Notify dashboard components so stats/cards refresh instantly
      window.dispatchEvent(
        new CustomEvent("connection-settings-updated", { detail: { connectionId: connection?.id } }),
      )
      onSuccess()
      onOpenChange(false)
    } catch (error) {
      console.error("[v0] Failed to save connection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save connection")
    } finally {
      setSaving(false)
    }
  }

  const loadPredefinedConnection = (predefinition: any) => {
    const baseName = predefinition.name
    let uniqueName = baseName
    let counter = 1

    while (existingConnections.some((conn) => conn.name === uniqueName)) {
      uniqueName = `${baseName} (${counter})`
      counter++
    }

    setForm({
      name: uniqueName,
      exchange: predefinition.id.split("-")[0],
      api_type: predefinition.apiType,
      connection_method: predefinition.connectionMethod,
      connection_library: predefinition.connectionLibrary,
      api_key: predefinition.apiKey || "",
      api_secret: predefinition.apiSecret || "",
      margin_type: predefinition.marginType,
      position_mode: predefinition.positionMode,
      is_testnet: false,
    })
  }

  const existingConnectionIds = existingConnections.map((conn) => conn.id)
  
  const availablePredefinedCount = CONNECTION_PREDEFINITIONS.filter(
    (pred) => !existingConnectionIds.includes(pred.id)
  ).length

  const selectedExchangeConfig = EXCHANGE_API_CONFIGS[form.exchange]
  const selectedApiType = selectedExchangeConfig?.api_types.find((t) => t.value === form.api_type)
  const selectedConnectionMethod = selectedExchangeConfig?.connection_methods.find(
    (m) => m.value === form.connection_method,
  )
  
  const exchangeInfo = getExchangeConfig(form.exchange)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connection ? "Edit Connection" : "Add New Connection"}</DialogTitle>
          <DialogDescription>
            {connection ? "Update your exchange connection settings" : "Configure a new exchange API connection"}
          </DialogDescription>
        </DialogHeader>

        {!connection && availablePredefinedCount > 0 && (
          <div className="space-y-4 pb-4 border-b">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Quick Setup - Use Predefined Template</h3>
              <Badge variant="secondary" className="text-xs">
                {availablePredefinedCount} Available
              </Badge>
            </div>
            <ConnectionPredefinitionSelector
              onSelect={loadPredefinedConnection}
              existingConnectionIds={existingConnectionIds}
            />
          </div>
        )}

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">Basic Info</TabsTrigger>
            <TabsTrigger value="api">API Configuration</TabsTrigger>
            <TabsTrigger value="trading">Trading Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Connection Name *</Label>
                <Input
                  id="name"
                  placeholder="My Bybit Account"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="exchange">Exchange *</Label>
                <Select value={form.exchange} onValueChange={(value) => setForm({ ...form, exchange: value })}>
                  <SelectTrigger id="exchange">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXCHANGE_CONFIGS).map(([key, config]) => {
                      const apiConfig = EXCHANGE_API_CONFIGS[key]
                      return (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <span>{config.displayName}</span>
                            <Badge variant="outline" className="text-xs">
                              {config.type}
                            </Badge>
                            {config.status === "failing" && (
                              <Badge variant="destructive" className="text-xs">
                                Failing
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                {exchangeInfo && (
                  <div className="p-2 bg-muted rounded-md space-y-1">
                    <div className="flex items-center gap-2">
                      <Info className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs font-medium">{exchangeInfo.displayName} - {exchangeInfo.type}</span>
                      {exchangeInfo.status === "failing" && (
                        <Badge variant="destructive" className="text-xs">
                          Known Issues
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {exchangeInfo.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                    {exchangeInfo.docs && (
                      <a
                        href={exchangeInfo.docs}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        API Documentation
                      </a>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="api-key">API Key *</Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder="Enter API key"
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="api-secret">API Secret *</Label>
                <Input
                  id="api-secret"
                  type="password"
                  placeholder="Enter API secret"
                  value={form.api_secret}
                  onChange={(e) => setForm({ ...form, api_secret: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="testnet"
                checked={form.is_testnet}
                onCheckedChange={(checked) => setForm({ ...form, is_testnet: checked })}
              />
              <Label htmlFor="testnet">Use Testnet (for testing only)</Label>
            </div>
          </TabsContent>

          <TabsContent value="api" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="api-type">API Type</Label>
                <Select value={form.api_type} onValueChange={(value) => setForm({ ...form, api_type: value })}>
                  <SelectTrigger id="api-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedExchangeConfig?.api_types.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        <div className="flex flex-col">
                          <span className="font-medium">{type.label}</span>
                          <span className="text-xs text-muted-foreground">{type.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedApiType && (
                  <div className="p-2 bg-muted rounded-md">
                    <p className="text-xs font-medium mb-1">{selectedApiType.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {selectedApiType.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="connection-method">Connection Method</Label>
                <Select
                  value={form.connection_method}
                  onValueChange={(value) => setForm({ ...form, connection_method: value })}
                >
                  <SelectTrigger id="connection-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedExchangeConfig?.connection_methods
                      .sort((a, b) => a.priority - b.priority)
                      .map((method) => (
                        <SelectItem key={method.value} value={method.value}>
                          <div className="flex flex-col">
                            <span className="font-medium">{method.label}</span>
                            <span className="text-xs text-muted-foreground">{method.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {selectedConnectionMethod && (
                  <div className="p-2 bg-muted rounded-md">
                    <p className="text-xs font-medium">{selectedConnectionMethod.description}</p>
                    {selectedConnectionMethod.packageName && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Package: {selectedConnectionMethod.packageName}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2 col-span-2">
                <Label htmlFor="connection-library">Connection Library</Label>
                <Input
                  id="connection-library"
                  placeholder="e.g., pybit, ccxt"
                  value={form.connection_library}
                  onChange={(e) => setForm({ ...form, connection_library: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Library or SDK to use for API communication</p>
              </div>
            </div>

            {selectedExchangeConfig && (
              <div className="p-3 bg-muted rounded-md space-y-2">
                <h4 className="text-sm font-medium">Rate Limits</h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Per Second:</span>{" "}
                    <span className="font-medium">{selectedExchangeConfig.rate_limits.requests_per_second}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Per Minute:</span>{" "}
                    <span className="font-medium">{selectedExchangeConfig.rate_limits.requests_per_minute}</span>
                  </div>
                </div>
                <a
                  href={selectedExchangeConfig.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-block"
                >
                  View API Documentation →
                </a>
              </div>
            )}
          </TabsContent>

          <TabsContent value="trading" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="margin-type">Margin Type</Label>
                <Select value={form.margin_type} onValueChange={(value) => setForm({ ...form, margin_type: value })}>
                  <SelectTrigger id="margin-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cross">
                      <div className="flex flex-col">
                        <span className="font-medium">Cross Margin</span>
                        <span className="text-xs text-muted-foreground">Share margin across all positions</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="isolated">
                      <div className="flex flex-col">
                        <span className="font-medium">Isolated Margin</span>
                        <span className="text-xs text-muted-foreground">Separate margin per position</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="position-mode">Position Mode</Label>
                <Select
                  value={form.position_mode}
                  onValueChange={(value) => setForm({ ...form, position_mode: value })}
                >
                  <SelectTrigger id="position-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hedge">
                      <div className="flex flex-col">
                        <span className="font-medium">Hedge Mode</span>
                        <span className="text-xs text-muted-foreground">Hold long and short simultaneously</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="one-way">
                      <div className="flex flex-col">
                        <span className="font-medium">One-Way Mode</span>
                        <span className="text-xs text-muted-foreground">Single direction per symbol</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg space-y-2">
              <h4 className="text-sm font-medium">Trading Configuration Summary</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Exchange:</span>{" "}
                  <span className="font-medium">{selectedExchangeConfig?.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">API Type:</span>{" "}
                  <span className="font-medium">{selectedApiType?.label}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Margin:</span>{" "}
                  <span className="font-medium capitalize">{form.margin_type}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Position:</span>{" "}
                  <span className="font-medium capitalize">{form.position_mode}</span>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {connection ? "Update" : "Add"} Connection
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
