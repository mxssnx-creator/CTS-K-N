"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus, Loader2, Trash2, Info, Settings, Eye, EyeOff } from 'lucide-react'
import { toast } from "@/lib/simple-toast"
import type { Connection } from "@/lib/db-types"
import { AddConnectionDialog } from "@/components/settings/add-connection-dialog"
import { ConnectionCard } from "@/components/settings/connection-card"
import { BingXCredentialsDialog } from "@/components/settings/bingx-credentials-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, Lock, Zap } from "lucide-react"
import { useDashboardEvents, type DashboardEventPayload } from "@/lib/dashboard-events"
import { isMaskedOrEmptyConnectionSecret } from "@/lib/connection-secrets"
import { normalizeMarketType, marketTypeLabel } from "@/lib/market-types"

const toBooleanFlag = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true"

const EXCHANGES: Record<string, { name: string; subtypes: string[] }> = {
  instaforex: { name: "InstaForex", subtypes: ["forex"] },
  bybit: { name: "Bybit", subtypes: ["perpetual", "futures", "spot", "options"] },
  bingx: { name: "BingX", subtypes: ["perpetual", "spot"] },
  pionex: { name: "Pionex", subtypes: ["spot"] },
  orangex: { name: "OrangeX", subtypes: ["perpetual", "spot"] },
  binance: { name: "Binance", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  okx: { name: "OKX", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  gateio: { name: "Gate.io", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  mexc: { name: "MEXC", subtypes: ["perpetual", "spot"] },
  bitget: { name: "Bitget", subtypes: ["perpetual", "futures", "spot", "margin"] },
  kucoin: { name: "KuCoin", subtypes: ["perpetual", "futures", "spot", "margin"] },
  huobi: { name: "Huobi", subtypes: ["perpetual", "spot", "margin"] },
}

const CONNECTION_METHODS = [
  { value: "rest", label: "REST API" },
  { value: "library", label: "Library SDK" },
  { value: "websocket", label: "WebSocket" },
  { value: "hybrid", label: "Hybrid (REST + WS)" },
]

const CONNECTION_LIBRARIES = [
  { value: "native-http", label: "Native HTTP (read-only)" },
  { value: "native", label: "Native" },
  { value: "sdk", label: "bingx-api" },
  { value: "ccxt", label: "CCXT" },
  { value: "exchange-lib", label: "Exchange SDK" },
  { value: "custom", label: "Custom" },
]

const EXCHANGE_CONNECTION_METHODS: Record<string, string[]> = {
  instaforex: ["rest"],
  bybit: ["rest", "websocket", "hybrid"],
  bingx: ["library", "rest", "websocket"],
  binance: ["rest", "websocket", "hybrid"],
  okx: ["rest", "websocket", "hybrid"],
  gateio: ["rest", "websocket"],
  kucoin: ["rest", "websocket"],
  mexc: ["rest", "websocket"],
  bitget: ["rest", "websocket"],
  pionex: ["rest", "websocket"],
  orangex: ["rest"],
  huobi: ["rest", "websocket"],
  kraken: ["rest", "websocket"],
  coinbase: ["rest"],
}

// Edit Connection Dialog Component
function EditConnectionDialog({ connection, onSave, exchangeName }: { connection: Connection; onSave: () => Promise<void>; exchangeName: string }) {
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testLog, setTestLog] = useState<string[]>([])
  const [showTestLog, setShowTestLog] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [btcPrice, setBtcPrice] = useState<string | null>(null)
  const isForex = normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange) === "forex"
  const [formData, setFormData] = useState({
    api_key: connection.api_key || "",
    account_id: connection.account_id || (isForex ? connection.api_key || "" : ""),
    api_secret: connection.api_secret || "",
    api_passphrase: connection.api_passphrase || "",
    symbol_suffix: connection.symbol_suffix || "",
    margin_type: connection.margin_type || "cross",
    position_mode: connection.position_mode || "hedge",
    is_testnet: isForex ? false : connection.id === "bingx-x02" || toBooleanFlag(connection.is_testnet),
    connection_method: isForex ? "rest" : connection.connection_method || (String(connection.exchange).toLowerCase() === "bingx" ? "library" : "rest"),
    connection_library: isForex ? "native-http" : connection.connection_library || (String(connection.exchange).toLowerCase() === "bingx" ? "sdk" : "native"),
    api_type: isForex ? "forex" : connection.api_type || "perpetual",
    api_subtype: connection.api_subtype || "perpetual",
    is_live_trade: connection.is_live_trade ?? false,
    market_type: isForex ? "forex" : "crypto",
  })
  const credentialReady = isForex
    ? /^[0-9]{4,12}$/.test(formData.account_id.trim())
    : Boolean(formData.api_key.trim() && formData.api_secret.trim())
  const connectionReady = credentialReady

  const handleTestConnection = async () => {
    if (!connectionReady) {
      toast.error(isForex
        ? "Please enter a valid numeric InstaForex account id/login"
        : "Please enter API Key and API Secret")
      return
    }

    setTesting(true)
    setTestLog([])
    setShowTestLog(true)
    setBtcPrice(null)

    try {
      console.log("[v0] [Test Connection] Using configured settings:", {
        exchange: connection.exchange,
        api_type: isForex ? "forex" : connection.api_type,
        api_subtype: formData.api_subtype,
        connection_method: formData.connection_method,
        connection_library: formData.connection_library,
        is_testnet: formData.is_testnet,
      })

      const response = await fetch(`/api/settings/connections/${connection.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: connection.exchange,
          api_type: isForex ? "forex" : formData.api_type,
          api_subtype: formData.api_subtype,
          connection_method: isForex ? "rest" : formData.connection_method,
          connection_library: isForex ? "native-http" : formData.connection_library,
          ...(isForex
            ? {
                account_id: formData.account_id,
                api_key: formData.account_id,
                market_type: "forex",
                execution_mode: "read_only",
                read_only: true,
                execution_supported: false,
              }
            : {}),
          ...(!isForex && !isMaskedOrEmptyConnectionSecret(formData.api_key) ? { api_key: formData.api_key } : {}),
          ...(!isForex && !isMaskedOrEmptyConnectionSecret(formData.api_secret) ? { api_secret: formData.api_secret } : {}),
          ...(!isMaskedOrEmptyConnectionSecret(formData.api_passphrase) ? { api_passphrase: formData.api_passphrase } : {}),
          is_testnet: isForex ? false : connection.id === "bingx-x02" || formData.is_testnet,
        }),
      })

      let logs = [
        `[${new Date().toLocaleTimeString()}] Starting connection test...\n`,
        `Exchange: ${connection.exchange.toUpperCase()} (${exchangeName})\n`,
        `Market: ${isForex ? "Forex" : "Crypto"}\n`,
        `API Type: ${isForex ? "forex" : formData.api_type} | Subtype: ${formData.api_subtype}\n`,
        `Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}\n`,
        `Testnet: ${isForex ? "No (broker)" : formData.is_testnet ? "Yes" : "No"}\n`,
        `Margin: ${formData.margin_type} | Position: ${formData.position_mode}\n`,
        `---\n`,
      ]

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Connection test failed")
      }

      const data = await response.json()
      let responseLogs = data.log || []
      if (!Array.isArray(responseLogs)) {
        responseLogs = [responseLogs.toString()]
      }
      logs.push(...responseLogs)

      // Add balance if available
      if (data.balance !== undefined) {
        const balanceUSD = parseFloat(data.balance).toFixed(2)
        logs.push(`\n✓ Account Balance: $${balanceUSD}`)
      }

      // Add BTC price if available
      if (Number(data.btcPrice) > 0) {
        const observedBtcPrice = Number(data.btcPrice).toFixed(2)
        setBtcPrice(observedBtcPrice)
        logs.push(`✓ BTC Price: $${observedBtcPrice}`)
      }

      logs.push(`\n✓ Connection test PASSED - ${isForex ? "Forex data verified (official HTTP API; read-only)" : "Ready to trade!"}`)
      setTestLog(logs)
      toast.success("Connection test passed!")
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Test connection error"
      let logs = [
        `[${new Date().toLocaleTimeString()}] Starting connection test...\n`,
        `Exchange: ${connection.exchange.toUpperCase()} (${exchangeName})\n`,
        `Market: ${isForex ? "Forex" : "Crypto"}\n`,
        `API Type: ${isForex ? "forex" : connection.api_type} | Subtype: ${formData.api_subtype}\n`,
        `Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}\n`,
        `---\n`,
        `✗ Error: ${errorMsg}`,
      ]
      if (btcPrice) {
        logs.push(`\nℹ BTC Price: $${btcPrice}`)
      }
      setTestLog(logs)
      toast.error(errorMsg)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: isForex ? formData.account_id : formData.api_key,
          api_secret: isForex ? "" : formData.api_secret,
          ...(isForex ? { account_id: formData.account_id, market_type: "forex", asset_class: "forex" } : {}),
          api_passphrase: formData.api_passphrase,
          margin_type: formData.margin_type,
          position_mode: formData.position_mode,
          is_testnet: isForex ? false : formData.is_testnet,
          connection_method: isForex ? "rest" : formData.connection_method,
          connection_library: isForex ? "native-http" : formData.connection_library,
          api_type: isForex ? "forex" : formData.api_type,
          api_subtype: isForex ? "forex" : formData.api_subtype,
          ...(isForex ? {
            symbol_suffix: formData.symbol_suffix,
            execution_mode: "read_only",
            read_only: true,
            execution_supported: false,
          } : {}),
        }),
      })

      if (!response.ok) throw new Error("Failed to update")
      toast.success("Connection updated")
      await onSave()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Tabs defaultValue="credentials" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="credentials">API Credentials</TabsTrigger>
        <TabsTrigger value="settings">Settings & Test</TabsTrigger>
      </TabsList>

      <TabsContent value="credentials" className="space-y-4 mt-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-900 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold mb-1">{isForex ? "Update InstaForex Account" : "Update API Credentials"}</p>
            <p className="text-xs">{isForex ? "The official HTTP integration reads account and market data only; order execution is unavailable." : "Change your API keys here if needed"}</p>
          </div>
        </div>

        {isForex ? (
          <div className="space-y-2">
            <Label className="font-medium flex items-center gap-2">
              <Lock className="h-4 w-4" />
              InstaForex Account ID / Login
            </Label>
            <Input
              inputMode="numeric"
              value={formData.account_id}
              onChange={(e) => setFormData({ ...formData, account_id: e.target.value.replace(/\D/g, "") })}
              placeholder="Numeric account login"
              disabled={loading}
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">Use the numeric account login accepted by InstaForex. The published Client/Quotes/Charts APIs supply account and market data only; order execution is unavailable.</p>
          </div>
        ) : (
          <>
          <div className="space-y-2">
          <Label className="font-medium flex items-center gap-2">
            <Lock className="h-4 w-4" />
            API Key
          </Label>
          <div className="relative">
            <Input
              type={showSecrets ? "text" : "password"}
              value={formData.api_key}
              onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
              placeholder="Enter your API Key"
              disabled={loading}
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
          </div>

        <div className="space-y-2">
          <Label className="font-medium flex items-center gap-2">
            <Lock className="h-4 w-4" />
            API Secret
          </Label>
          <Input
            type={showSecrets ? "text" : "password"}
            value={formData.api_secret}
            onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
            placeholder="Enter your API Secret"
            disabled={loading}
            className="bg-background"
          />
        </div>
          </>
        )}

        <div className="space-y-2">
          <Label className="font-medium">API Passphrase (Optional)</Label>
          <Input
            type={showSecrets ? "text" : "password"}
            value={formData.api_passphrase}
            onChange={(e) => setFormData({ ...formData, api_passphrase: e.target.value })}
            placeholder="Leave blank if not required"
            disabled={loading}
            className="bg-background"
          />
        </div>
      </TabsContent>

      <TabsContent value="settings" className="space-y-4 mt-4">
        {/* Connection Configuration Section */}
        <div className="border-b pb-4">
          <h4 className="font-semibold text-sm mb-3">Connection Configuration</h4>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Market type:</span>
            <Badge variant="outline">{marketTypeLabel(isForex ? "forex" : "crypto")}</Badge>
            {isForex && <Badge className="bg-amber-100 text-amber-900">REST read-only · no order execution</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="font-medium text-xs">API Subtype</Label>
              <Select value={formData.api_subtype} onValueChange={(value) => setFormData({ ...formData, api_subtype: value })}>
                <SelectTrigger disabled={loading} className="bg-background text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGES[connection.exchange as keyof typeof EXCHANGES]?.subtypes.map((subtype) => (
                    <SelectItem key={subtype} value={subtype}>
                      {subtype.charAt(0).toUpperCase() + subtype.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-xs">Connection Method</Label>
              <Select value={isForex ? "rest" : formData.connection_method} onValueChange={(value) => setFormData({ ...formData, connection_method: isForex ? "rest" : value, connection_library: isForex ? "native-http" : formData.connection_library })} disabled={isForex}>
                <SelectTrigger disabled={loading} className="bg-background text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGE_CONNECTION_METHODS[connection.exchange as keyof typeof EXCHANGE_CONNECTION_METHODS]?.map((method) => (
                    <SelectItem key={method} value={method}>
                      {CONNECTION_METHODS.find(m => m.value === method)?.label || method}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

                <div className="space-y-2">
                  <Label className="font-medium text-xs">Connection Library</Label>
              <Select value={isForex ? "native-http" : formData.connection_library} onValueChange={(value) => setFormData({ ...formData, connection_library: isForex ? "native-http" : value })} disabled={isForex}>
                <SelectTrigger disabled={loading} className="bg-background text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isForex && <SelectItem value="native-http">Official HTTP (read-only)</SelectItem>}
                  {!isForex && <>
                    <SelectItem value="native">Native</SelectItem>
                    <SelectItem value="ccxt">CCXT</SelectItem>
                    <SelectItem value="exchange-lib">Exchange-specific SDK</SelectItem>
                    <SelectItem value="custom">Custom Implementation</SelectItem>
                  </>}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {isForex && (
          <div className="space-y-3 border-b pb-4">
            <div>
              <h4 className="font-semibold text-sm">Forex transport</h4>
              <p className="text-xs text-muted-foreground mt-1">Official InstaForex REST/Quotes/Charts data; account and history reads are supported, while order execution is unavailable.</p>
            </div>
            <div className="space-y-2">
              <Label className="font-medium text-xs">Broker symbol suffix (optional)</Label>
              <Input value={formData.symbol_suffix} onChange={(e) => setFormData({ ...formData, symbol_suffix: e.target.value })} placeholder="e.g. .fx or .m" disabled={loading} />
            </div>
          </div>
        )}

        {/* Trading Settings Section */}
        <div className="border-b pb-4">
          <h4 className="font-semibold text-sm mb-3">Trading Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="font-medium">Margin Type</Label>
              <Select value={formData.margin_type} onValueChange={(value) => setFormData({ ...formData, margin_type: value })} disabled={isForex}>
                <SelectTrigger disabled={loading} className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cross">Cross Margin</SelectItem>
                  <SelectItem value="isolated">Isolated Margin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="font-medium">Position Mode</Label>
              <Select value={formData.position_mode} onValueChange={(value) => setFormData({ ...formData, position_mode: value })} disabled={isForex}>
                <SelectTrigger disabled={loading} className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hedge">Hedge Mode</SelectItem>
                  <SelectItem value="one-way">One-way Mode</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b pb-4">
          <div>
            <Label className="font-medium">Use Testnet</Label>
            <p className="text-xs text-muted-foreground mt-1">{isForex ? "Read-only HTTP account data" : formData.is_testnet ? "Testnet" : "Live"}</p>
          </div>
          <Switch checked={isForex ? false : connection.id === "bingx-x02" || formData.is_testnet} onCheckedChange={(checked) => setFormData({ ...formData, is_testnet: connection.id === "bingx-x02" || checked })} disabled={loading || connection.id === "bingx-x02" || isForex} />
        </div>

        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-orange-600" />
            <h4 className="font-semibold text-sm">Test Connection</h4>
          </div>

          {!showTestLog && (
            <Button onClick={handleTestConnection} disabled={testing || !connectionReady || loading} className="w-full bg-orange-600 hover:bg-orange-700">
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
          )}

          {showTestLog && testLog.length > 0 && (
            <div className="space-y-2">
              <div className="bg-slate-900 text-slate-100 p-3 rounded font-mono text-xs space-y-1 max-h-48 overflow-y-auto border border-slate-700">
                {testLog.map((log, idx) => (
                  <div key={idx} className="text-slate-300">
                    {log}
                  </div>
                ))}
              </div>
              <Button type="button" onClick={handleTestConnection} disabled={testing || loading} variant="outline" size="sm" className="w-full">
                {testing ? "Testing..." : "Test Again"}
              </Button>
            </div>
          )}
        </div>
      </TabsContent>

      <div className="flex gap-2 justify-end pt-4 mt-4 border-t">
        <Button variant="outline" disabled={loading} onClick={() => window.location.reload()}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </Tabs>
  )
}

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
        .map((c: any) => ({
          ...c,
          market_type: normalizeMarketType(c.market_type || c.asset_class, c.exchange),
          asset_class: normalizeMarketType(c.market_type || c.asset_class, c.exchange),
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
          api_type: normalizeMarketType(c.market_type || c.asset_class, c.exchange) === "forex" ? "forex" : c.api_type || "perpetual_futures",
          connection_method: normalizeMarketType(c.market_type || c.asset_class, c.exchange) === "forex"
            ? "rest"
            : c.connection_method || (String(c.exchange).toLowerCase() === "bingx" ? "library" : "rest"),
          connection_library: normalizeMarketType(c.market_type || c.asset_class, c.exchange) === "forex"
            ? "native-http"
            : c.connection_library || (String(c.exchange).toLowerCase() === "bingx" ? "sdk" : "native"),
        } as Connection))

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
