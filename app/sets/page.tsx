"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Plus, Edit, Trash2, Save, X, Settings, Info } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import type { PresetConfigurationSet } from "@/lib/types-preset-coordination"
import {
  INDICATOR_DEFAULTS,
  getIndicatorDefaults,
  type IndicationParameterRange,
} from "@/lib/indication-range-calculator"

export default function SetsPage() {
  const [sets, setSets] = useState<PresetConfigurationSet[]>([])
  const [loading, setLoading] = useState(true)
  const [editingSet, setEditingSet] = useState<PresetConfigurationSet | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [formData, setFormData] = useState<Partial<PresetConfigurationSet>>({
    name: "",
    description: "",
    symbol_mode: "main",
    symbols: [],
    indication_type: "rsi",
    indication_params: {
      period: INDICATOR_DEFAULTS.rsi.period.default,
      oversold: INDICATOR_DEFAULTS.rsi.oversold.default,
      overbought: INDICATOR_DEFAULTS.rsi.overbought.default,
    },
    takeprofit_min: 2.0,
    takeprofit_max: 30.0,
    takeprofit_step: 2.0,
    stoploss_min: 0.3,
    stoploss_max: 3.0,
    stoploss_step: 0.3,
    trailing_enabled: true,
    trail_starts: [0.5, 1.0, 1.5],
    trail_stops: [0.2, 0.4, 0.6],
    range_days: 7,
    trades_per_48h_min: 5,
    profit_factor_min: 0.5,
    drawdown_time_max: 12,
    evaluation_positions_count1: 25,
    evaluation_positions_count2: 50,
    database_positions_per_set: 250,
    database_threshold_percent: 20,
    is_active: true,
  })

  useEffect(() => {
    loadSets()
  }, [])

  const loadSets = async () => {
    try {
      setLoading(true)
      const response = await fetch("/api/preset-sets")
      if (response.ok) {
        const data = await response.json()
        setSets(data)
      }
    } catch (error) {
      console.error("[v0] Failed to load sets:", error)
      toast.error("Failed to load configuration sets")
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingSet(null)
    setFormData({
      name: "",
      description: "",
      symbol_mode: "main",
      symbols: [],
      indication_type: "rsi",
      indication_params: {
        period: INDICATOR_DEFAULTS.rsi.period.default,
        oversold: INDICATOR_DEFAULTS.rsi.oversold.default,
        overbought: INDICATOR_DEFAULTS.rsi.overbought.default,
      },
      takeprofit_min: 2.0,
      takeprofit_max: 30.0,
      takeprofit_step: 2.0,
      stoploss_min: 0.3,
      stoploss_max: 3.0,
      stoploss_step: 0.3,
      trailing_enabled: true,
      trail_starts: [0.5, 1.0, 1.5],
      trail_stops: [0.2, 0.4, 0.6],
      range_days: 7,
      trades_per_48h_min: 5,
      profit_factor_min: 0.5,
      drawdown_time_max: 12,
      evaluation_positions_count1: 25,
      evaluation_positions_count2: 50,
      database_positions_per_set: 250,
      database_threshold_percent: 20,
      is_active: true,
    })
    setIsDialogOpen(true)
  }

  const handleEdit = (set: PresetConfigurationSet) => {
    setEditingSet(set)
    setFormData(set)
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    try {
      const url = editingSet ? `/api/preset-sets/${editingSet.id}` : "/api/preset-sets"
      const method = editingSet ? "PUT" : "POST"

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        toast.success(editingSet ? "Set updated successfully" : "Set created successfully")
        setIsDialogOpen(false)
        loadSets()
      } else {
        throw new Error("Failed to save set")
      }
    } catch (error) {
      console.error("[v0] Failed to save set:", error)
      toast.error("Failed to save configuration set")
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this configuration set?")) return

    try {
      const response = await fetch(`/api/preset-sets/${id}`, { method: "DELETE" })
      if (response.ok) {
        toast.success("Set deleted successfully")
        loadSets()
      }
    } catch (error) {
      console.error("[v0] Failed to delete set:", error)
      toast.error("Failed to delete configuration set")
    }
  }

  const updateFormData = (key: string, value: any) => {
    setFormData((prev) => ({ ...prev, [key]: value }))
  }

  const updateIndicationParam = (key: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      indication_params: { ...prev.indication_params, [key]: value },
    }))
  }

  const getCurrentIndicatorRanges = (): Record<string, IndicationParameterRange> => {
    return getIndicatorDefaults(formData.indication_type || "rsi")
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Configuration Sets</h1>
          <p className="text-muted-foreground mt-1">Manage configuration sets for preset coordination</p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Create Set
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sets.map((set) => (
          <Card key={set.id} className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-lg truncate">{set.name}</CardTitle>
                  <CardDescription className="text-sm mt-1 line-clamp-2">
                    {set.description || "No description"}
                  </CardDescription>
                </div>
                <Badge variant={set.is_active ? "default" : "secondary"} className="ml-2 shrink-0">
                  {set.is_active ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Indication:</span>
                  <div className="font-medium capitalize">{set.indication_type}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Symbol Mode:</span>
                  <div className="font-medium capitalize">{set.symbol_mode}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">TP Range:</span>
                  <div className="font-medium">
                    {set.takeprofit_min}-{set.takeprofit_max}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">SL Range:</span>
                  <div className="font-medium">
                    {set.stoploss_min}-{set.stoploss_max}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Range Days:</span>
                  <div className="font-medium">{set.range_days}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Min PF:</span>
                  <div className="font-medium">{set.profit_factor_min}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t">
                <Button variant="outline" size="sm" onClick={() => handleEdit(set)} className="flex-1">
                  <Edit className="h-3 w-3 mr-1" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDelete(set.id)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {sets.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Settings className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No configuration sets yet</h3>
            <p className="text-muted-foreground mb-4">Create your first configuration set to get started</p>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create Set
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSet ? "Edit Configuration Set" : "Create Configuration Set"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            {/* Basic Information */}
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => updateFormData("name", e.target.value)}
                  placeholder="Enter set name"
                />
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => updateFormData("description", e.target.value)}
                  placeholder="Enter description"
                  rows={2}
                />
              </div>
            </div>

            {/* Symbol Selection */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Symbol Selection</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Symbol Mode</Label>
                  <Select value={formData.symbol_mode} onValueChange={(value) => updateFormData("symbol_mode", value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Main Symbols</SelectItem>
                      <SelectItem value="forced">Forced Symbols</SelectItem>
                      <SelectItem value="manual">Manual Input</SelectItem>
                      <SelectItem value="exchange">From Exchange</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.symbol_mode === "exchange" && (
                  <>
                    <div className="space-y-2">
                      <Label>Order By</Label>
                      <Select
                        value={formData.exchange_order_by}
                        onValueChange={(value) => updateFormData("exchange_order_by", value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="market_cap">Market Cap</SelectItem>
                          <SelectItem value="volume">Volume</SelectItem>
                          <SelectItem value="volatility">Volatility</SelectItem>
                          <SelectItem value="price_change">Price Change</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Limit (10 default)</Label>
                      <Input
                        type="number"
                        min="1"
                        max="100"
                        value={formData.exchange_limit}
                        onChange={(e) => updateFormData("exchange_limit", Number.parseInt(e.target.value))}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Indication Configuration */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Indication Configuration</CardTitle>
                <CardDescription className="flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3" />
                  Ranges are calculated as 50% from default values with dynamic steps
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Indication Type</Label>
                  <Select
                    value={formData.indication_type}
                    onValueChange={(value) => {
                      updateFormData("indication_type", value)
                      const defaults = getIndicatorDefaults(value)
                      const newParams: Record<string, number> = {}
                      for (const [key, range] of Object.entries(defaults)) {
                        newParams[key] = range.default
                      }
                      updateFormData("indication_params", newParams)
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rsi">RSI</SelectItem>
                      <SelectItem value="macd">MACD</SelectItem>
                      <SelectItem value="bollinger">Bollinger Bands</SelectItem>
                      <SelectItem value="sar">Parabolic SAR</SelectItem>
                      <SelectItem value="adx">ADX</SelectItem>
                      <SelectItem value="ema">EMA</SelectItem>
                      <SelectItem value="sma">SMA</SelectItem>
                      <SelectItem value="stochastic">Stochastic</SelectItem>
                      <SelectItem value="atr">ATR</SelectItem>
                      <SelectItem value="cci">CCI</SelectItem>
                      <SelectItem value="mfi">MFI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.indication_type === "rsi" && (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>
                        Period ({INDICATOR_DEFAULTS.rsi.period.min}-{INDICATOR_DEFAULTS.rsi.period.max}, step{" "}
                        {INDICATOR_DEFAULTS.rsi.period.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.rsi.period.min}
                        max={INDICATOR_DEFAULTS.rsi.period.max}
                        step={INDICATOR_DEFAULTS.rsi.period.step}
                        value={formData.indication_params?.period || INDICATOR_DEFAULTS.rsi.period.default}
                        onChange={(e) => updateIndicationParam("period", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">Default: {INDICATOR_DEFAULTS.rsi.period.default}</p>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Oversold ({INDICATOR_DEFAULTS.rsi.oversold.min}-{INDICATOR_DEFAULTS.rsi.oversold.max}, step{" "}
                        {INDICATOR_DEFAULTS.rsi.oversold.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.rsi.oversold.min}
                        max={INDICATOR_DEFAULTS.rsi.oversold.max}
                        step={INDICATOR_DEFAULTS.rsi.oversold.step}
                        value={formData.indication_params?.oversold || INDICATOR_DEFAULTS.rsi.oversold.default}
                        onChange={(e) => updateIndicationParam("oversold", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.rsi.oversold.default}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Overbought ({INDICATOR_DEFAULTS.rsi.overbought.min}-
                        {Math.min(100, INDICATOR_DEFAULTS.rsi.overbought.max)}, step{" "}
                        {INDICATOR_DEFAULTS.rsi.overbought.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.rsi.overbought.min}
                        max={Math.min(100, INDICATOR_DEFAULTS.rsi.overbought.max)}
                        step={INDICATOR_DEFAULTS.rsi.overbought.step}
                        value={formData.indication_params?.overbought || INDICATOR_DEFAULTS.rsi.overbought.default}
                        onChange={(e) => updateIndicationParam("overbought", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.rsi.overbought.default}
                      </p>
                    </div>
                  </div>
                )}

                {formData.indication_type === "macd" && (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>
                        Fast Period ({INDICATOR_DEFAULTS.macd.fastPeriod.min}-{INDICATOR_DEFAULTS.macd.fastPeriod.max},
                        step {INDICATOR_DEFAULTS.macd.fastPeriod.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.macd.fastPeriod.min}
                        max={INDICATOR_DEFAULTS.macd.fastPeriod.max}
                        step={INDICATOR_DEFAULTS.macd.fastPeriod.step}
                        value={formData.indication_params?.fastPeriod || INDICATOR_DEFAULTS.macd.fastPeriod.default}
                        onChange={(e) => updateIndicationParam("fastPeriod", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.macd.fastPeriod.default}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Slow Period ({INDICATOR_DEFAULTS.macd.slowPeriod.min}-{INDICATOR_DEFAULTS.macd.slowPeriod.max},
                        step {INDICATOR_DEFAULTS.macd.slowPeriod.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.macd.slowPeriod.min}
                        max={INDICATOR_DEFAULTS.macd.slowPeriod.max}
                        step={INDICATOR_DEFAULTS.macd.slowPeriod.step}
                        value={formData.indication_params?.slowPeriod || INDICATOR_DEFAULTS.macd.slowPeriod.default}
                        onChange={(e) => updateIndicationParam("slowPeriod", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.macd.slowPeriod.default}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Signal Period ({INDICATOR_DEFAULTS.macd.signalPeriod.min}-
                        {INDICATOR_DEFAULTS.macd.signalPeriod.max}, step {INDICATOR_DEFAULTS.macd.signalPeriod.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.macd.signalPeriod.min}
                        max={INDICATOR_DEFAULTS.macd.signalPeriod.max}
                        step={INDICATOR_DEFAULTS.macd.signalPeriod.step}
                        value={formData.indication_params?.signalPeriod || INDICATOR_DEFAULTS.macd.signalPeriod.default}
                        onChange={(e) => updateIndicationParam("signalPeriod", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.macd.signalPeriod.default}
                      </p>
                    </div>
                  </div>
                )}

                {formData.indication_type === "bollinger" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>
                        Period ({INDICATOR_DEFAULTS.bollinger.period.min}-{INDICATOR_DEFAULTS.bollinger.period.max},
                        step {INDICATOR_DEFAULTS.bollinger.period.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.bollinger.period.min}
                        max={INDICATOR_DEFAULTS.bollinger.period.max}
                        step={INDICATOR_DEFAULTS.bollinger.period.step}
                        value={formData.indication_params?.period || INDICATOR_DEFAULTS.bollinger.period.default}
                        onChange={(e) => updateIndicationParam("period", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.bollinger.period.default}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Std Dev ({INDICATOR_DEFAULTS.bollinger.stdDev.min}-{INDICATOR_DEFAULTS.bollinger.stdDev.max},
                        step {INDICATOR_DEFAULTS.bollinger.stdDev.step})
                      </Label>
                      <Input
                        type="number"
                        min={INDICATOR_DEFAULTS.bollinger.stdDev.min}
                        max={INDICATOR_DEFAULTS.bollinger.stdDev.max}
                        step={INDICATOR_DEFAULTS.bollinger.stdDev.step}
                        value={formData.indication_params?.stdDev || INDICATOR_DEFAULTS.bollinger.stdDev.default}
                        onChange={(e) => updateIndicationParam("stdDev", Number.parseFloat(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {INDICATOR_DEFAULTS.bollinger.stdDev.default}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Position Ranges */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Position Ranges</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>TP Min</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={formData.takeprofit_min}
                      onChange={(e) => updateFormData("takeprofit_min", Number.parseFloat(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>TP Max</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={formData.takeprofit_max}
                      onChange={(e) => updateFormData("takeprofit_max", Number.parseFloat(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>TP Step</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={formData.takeprofit_step}
                      onChange={(e) => updateFormData("takeprofit_step", Number.parseFloat(e.target.value))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>SL Min</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={formData.stoploss_min}
                      onChange={(e) => updateFormData("stoploss_min", Number.parseFloat(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SL Max</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={formData.stoploss_max}
                      onChange={(e) => updateFormData("stoploss_max", Number.parseFloat(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SL Step</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={formData.stoploss_step}
                      onChange={(e) => updateFormData("stoploss_step", Number.parseFloat(e.target.value))}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Trailing Options */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Trailing Options</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Enable Trailing</Label>
                  <Switch
                    checked={formData.trailing_enabled}
                    onCheckedChange={(checked) => updateFormData("trailing_enabled", checked)}
                  />
                </div>

                {formData.trailing_enabled && (
                  <>
                    <div className="space-y-2">
                      <Label>Trail Starts (comma-separated)</Label>
                      <Input
                        value={formData.trail_starts?.join(", ")}
                        onChange={(e) =>
                          updateFormData(
                            "trail_starts",
                            e.target.value.split(",").map((v) => Number.parseFloat(v.trim())),
                          )
                        }
                        placeholder="0.5, 1.0, 1.5"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Trail Stops (comma-separated)</Label>
                      <Input
                        value={formData.trail_stops?.join(", ")}
                        onChange={(e) =>
                          updateFormData(
                            "trail_stops",
                            e.target.value.split(",").map((v) => Number.parseFloat(v.trim())),
                          )
                        }
                        placeholder="0.2, 0.4, 0.6"
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Calculation Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Calculation Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Range Days (1-20): {formData.range_days}</Label>
                  <Slider
                    min={1}
                    max={20}
                    step={1}
                    value={[formData.range_days || 7]}
                    onValueChange={([value]) => updateFormData("range_days", value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Trades per 48h Minimal (1-20): {formData.trades_per_48h_min}</Label>
                  <Slider
                    min={1}
                    max={20}
                    step={1}
                    value={[formData.trades_per_48h_min || 5]}
                    onValueChange={([value]) => updateFormData("trades_per_48h_min", value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Profit Factor Minimal (0.5-5.0): {formData.profit_factor_min}</Label>
                  <Slider
                    min={0.5}
                    max={5.0}
                    step={0.1}
                    value={[formData.profit_factor_min || 0.5]}
                    onValueChange={([value]) => updateFormData("profit_factor_min", value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>DrawDown Time Maximal (4-20 hours): {formData.drawdown_time_max}</Label>
                  <Slider
                    min={4}
                    max={20}
                    step={1}
                    value={[formData.drawdown_time_max || 12]}
                    onValueChange={([value]) => updateFormData("drawdown_time_max", value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Evaluation Count 1 (10-50): {formData.evaluation_positions_count1}</Label>
                    <Slider
                      min={10}
                      max={50}
                      step={1}
                      value={[formData.evaluation_positions_count1 || 25]}
                      onValueChange={([value]) => updateFormData("evaluation_positions_count1", value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Evaluation Count 2 (50-100): {formData.evaluation_positions_count2}</Label>
                    <Slider
                      min={50}
                      max={100}
                      step={1}
                      value={[formData.evaluation_positions_count2 || 50]}
                      onValueChange={([value]) => updateFormData("evaluation_positions_count2", value)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Status */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <Label>Active Status</Label>
              <Switch
                checked={formData.is_active}
                onCheckedChange={(checked) => updateFormData("is_active", checked)}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button onClick={handleSave}>
                <Save className="h-4 w-4 mr-2" />
                Save Set
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
