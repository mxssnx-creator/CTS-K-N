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
]

export function ConnectionEditDialog({ isOpen, connection, onClose, onSave }: ConnectionEditDialogProps) {
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
      setFormData({
        name: connection.name || "",
        exchange: connection.exchange || "bybit",
        api_type: connection.api_type || "perpetual_futures",
        api_subtype: connection.api_subtype || "perpetual",
        connection_method: connection.connection_method || "rest",
        connection_library: connection.connection_library || "native",
        api_key: connection.api_key || "",
        api_secret: connection.api_secret || "",
        api_passphrase: connection.api_passphrase || "",
        margin_type: connection.margin_type || "cross",
        position_mode: connection.position_mode || "hedge",
        is_testnet: connection.is_testnet || false,
        volume_factor: connection.volume_factor ?? MIN_VOLUME_FACTOR,
      })
      setActiveTab("basic")
      setShowSecrets(false)
      setTestLog([])
      setShowTestLog(false)
    }
  }, [isOpen, connection])

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => ({ ...prev, [field]: "" }))
  }

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.name.trim()) newErrors.name = "Name is required"
    if (!formData.api_key.trim()) newErrors.api_key = "API Key is required"
    if (!formData.api_secret.trim()) newErrors.api_secret = "API Secret is required"
    if (formData.volume_factor <= 0) newErrors.volume_factor = "Volume factor must be positive"

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleTestConnection = async () => {
    if (!formData.api_key || !formData.api_secret) {
      toast.error("Please enter API Key and API Secret")
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
          api_type: formData.api_type,
          api_subtype: formData.api_subtype,
          connection_method: formData.connection_method,
          connection_library: formData.connection_library,
          api_key: formData.api_key,
          api_secret: formData.api_secret,
          api_passphrase: formData.api_passphrase || "",
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

      let logs = [`✓ Connection test PASSED - Ready to use!`]
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
      await onSave(formData)
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
                    className={`bg-white text-sm h-8 ${errors.name ? "border-red-500" : ""}`}
                  />
                  {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="exchange" className="font-medium text-xs">Exchange</Label>
                  <Select value={formData.exchange} onValueChange={(value) => handleChange("exchange", value)}>
                    <SelectTrigger id="exchange" disabled={isSaving} className="bg-white h-8 text-sm">
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
                  <Select value={formData.api_type} onValueChange={(value) => handleChange("api_type", value)}>
                    <SelectTrigger id="api-type" disabled={isSaving} className="bg-white h-8 text-sm">
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
                      <SelectTrigger id="api-subtype" disabled={isSaving} className="bg-white h-8 text-sm">
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
                    <SelectTrigger id="connection-method" disabled={isSaving} className="bg-white h-8 text-sm">
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
                    <SelectTrigger id="connection-library" disabled={isSaving} className="bg-white h-8 text-sm">
                      <SelectValue placeholder="Select library..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="native"><span className="text-sm">Native (Default)</span></SelectItem>
                      <SelectItem value="ccxt"><span className="text-sm">CCXT</span></SelectItem>
                      <SelectItem value="original"><span className="text-sm">Original - {EXCHANGE_LIBRARY_PACKAGES[formData.exchange] || "SDK"}</span></SelectItem>
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
                  <Select value={formData.margin_type} onValueChange={(value) => handleChange("margin_type", value)}>
                    <SelectTrigger id="margin-type" disabled={isSaving} className="bg-white h-8 text-sm">
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
                    <SelectTrigger id="position-mode" disabled={isSaving} className="bg-white h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hedge">Hedge</SelectItem>
                      <SelectItem value="one-way">One-way</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="volume_factor">Volume Factor</Label>
                  <Input
                    id="volume_factor"
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={formData.volume_factor}
                    onChange={(e) => handleChange("volume_factor", parseFloat(e.target.value))}
                    placeholder="1.0"
                    disabled={isSaving}
                    className={`bg-white h-8 text-sm ${errors.volume_factor ? "border-red-500" : ""}`}
                  />
                  {errors.volume_factor && <p className="text-xs text-red-500">{errors.volume_factor}</p>}
                  <p className="text-xs text-muted-foreground">Multiplier for order volume (1.0 = 100%)</p>
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
                  onCheckedChange={(checked) => handleChange("is_testnet", checked)}
                  disabled={isSaving}
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
                      className={`pr-10 bg-white ${errors.api_key ? "border-red-500" : ""}`}
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
                    className={`bg-white ${errors.api_secret ? "border-red-500" : ""}`}
                  />
                  {errors.api_secret && <p className="text-xs text-red-500">{errors.api_secret}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="api-passphrase" className="font-medium">API Passphrase (Optional)</Label>
                  <Input
                    id="api-passphrase"
                    type={showSecrets ? "text" : "password"}
                    value={formData.api_passphrase}
                    onChange={(e) => handleChange("api_passphrase", e.target.value)}
                    placeholder="Leave blank if not required"
                    disabled={isSaving}
                    className="bg-white"
                  />
                  <p className="text-xs text-muted-foreground">Required only for some exchanges (e.g., OKX, Coinbase)</p>
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
                      disabled={testing || !formData.api_key || !formData.api_secret || isSaving}
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
