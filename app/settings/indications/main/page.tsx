"use client"
export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/lib/simple-toast"
import { Save, TrendingUp, Activity, Zap, CheckCircle } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider" // Import Slider
import { Switch } from "@/components/ui/switch" // Import Switch
import { Badge } from "@/components/ui/badge"

export default function MainIndicationsSettingsPage() {
  const [settings, setSettings] = useState({
    marketActivity: {
      enabled: true, // Added enable/disable toggle
      minPriceChange: 0.1, // Minimum price change % to consider market active
      minVolatility: 0.05, // Minimum volatility % to consider market active
      checkInterval: 1, // How often to check market activity (seconds)
      activationThreshold: 0.2, // Threshold % to activate indication checking
      deactivationThreshold: 0.05, // Threshold % to pause indication checking
      calculationRange: 10, // Added calculation range (5-20 seconds, default 10)
      calculationFrame: 1, // Added calculation frame (1 second)
      positionCostRatioIndex: 2, // Added position cost ratio index (1-20, default 2)
    },
    direction: {
      enabled: true,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      min_calculation_time: 3,
      interval: 1,
      timeout: 3,
    },
    move: {
      enabled: true,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      min_calculation_time: 3,
      interval: 1,
      timeout: 3,
    },
    active: {
      enabled: false,
      range: { from: 1, to: 10, step: 1 },
      activity_calculated: { from: 10, to: 90, step: 10 },
      activity_lastpart: { from: 10, to: 90, step: 10 },
      market_change_range: { from: 1, to: 10, step: 1 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      interval: 1,
      timeout: 3,
      min_calculation_time: 3,
    },
    active_advanced: {
      activity_ratios: { from: 0.5, to: 3.0, step: 0.5 },
      min_positions: 3,
      continuation_ratio: 0.6,
    },
    optimal: {
      enabled: true,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      min_calculation_time: 3,
      interval: 2,
      timeout: 10,
      trailing_optimal_ranges: true,
    },
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch(`/api/settings/indications/main?t=${Date.now()}`)
      const data = await response.json()
      if (data.success) {
        setSettings(data.settings)
      }
    } catch (error) {
      console.error("[v0] Failed to load main indication settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const response = await fetch("/api/settings/indications/main", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })

      const data = await response.json()
      if (data.success) {
        toast.success("Settings saved successfully")
      } else {
        toast.error(data.error || "Failed to save settings")
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setIsSaving(false)
    }
  }

  const updateSetting = (type: string, field: string, subfield: string | null, value: string) => {
    setSettings((prev: any) => ({
      ...prev,
      [type]: {
        ...prev[type],
        [field]: subfield ? { ...prev[type][field], [subfield]: Number.parseFloat(value) } : Number.parseFloat(value),
      },
    }))
  }

  const updateMarketActivitySetting = (field: string, value: any) => {
    // Changed value type to any to handle boolean and string
    setSettings((prev: any) => ({
      ...prev,
      marketActivity: {
        ...prev.marketActivity,
        [field]: typeof value === "string" ? Number.parseFloat(value) : value, // Handle string to number conversion
      },
    }))
  }

  const toggleIndicationEnabled = (type: string) => {
    setSettings((prev: any) => ({
      ...prev,
      [type]: {
        ...prev[type],
        enabled: !prev[type].enabled,
      },
    }))
  }

  const calculateCount = (range: { from: number; to: number; step: number }): number => {
    return Math.floor((range.to - range.from) / range.step) + 1
  }

  const calculatePositionCostRatio = (index: number): number => {
    return 0.05 * index // Index 1 = 0.05, Index 2 = 0.10, Index 20 = 1.00
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="text-center py-12">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Main Indications Settings</h1>
          <p className="text-muted-foreground">
            Configure direction, move, and active indication types with market change calculations
          </p>
        </div>
        <Button onClick={handleSave} disabled={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </div>

      <div className="grid gap-6">
        <Card className="border-2 border-primary">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <Activity className="h-6 w-6 text-primary" />
              <div>
                <CardTitle className="text-xl">Market Activity Pre-Check Settings</CardTitle>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Label htmlFor="market-activity-enabled" className="text-sm cursor-pointer">
                  {settings.marketActivity.enabled ? "Enabled" : "Disabled"}
                </Label>
                <Switch
                  id="market-activity-enabled"
                  checked={settings.marketActivity.enabled}
                  onCheckedChange={(checked) => updateMarketActivitySetting("enabled", checked)} // Pass boolean directly
                />
              </div>
            </div>
            <CardDescription>
              Global market activity thresholds that gate all main indication checking. Indications are only evaluated
              when market activity meets these criteria.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                How It Works
              </h4>
              <p className="text-xs text-muted-foreground">
                Before any Direction, Move, or Active indication is calculated, the system first checks if the market is
                sufficiently active. If price change and volatility are below the activation threshold, indication
                checking is paused to save resources. This prevents false signals during flat or low-activity market
                periods.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-base font-semibold">Minimum Price Change (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1.0"
                  value={settings.marketActivity.minPriceChange}
                  onChange={(e) => updateMarketActivitySetting("minPriceChange", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum price movement required to consider market active (default: 0.1%)
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold">Minimum Volatility (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1.0"
                  value={settings.marketActivity.minVolatility}
                  onChange={(e) => updateMarketActivitySetting("minVolatility", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum price volatility (standard deviation) required (default: 0.05%)
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold">Check Interval (seconds)</Label>
                <Input
                  type="number"
                  step="1"
                  min="1"
                  max="60"
                  value={settings.marketActivity.checkInterval}
                  onChange={(e) => updateMarketActivitySetting("checkInterval", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  How frequently to evaluate market activity (default: 1 second)
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold">Activation Threshold (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.05"
                  max="2.0"
                  value={settings.marketActivity.activationThreshold}
                  onChange={(e) => updateMarketActivitySetting("activationThreshold", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Combined threshold to START indication checking (default: 0.2%)
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold">Deactivation Threshold (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1.0"
                  value={settings.marketActivity.deactivationThreshold}
                  onChange={(e) => updateMarketActivitySetting("deactivationThreshold", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Combined threshold to PAUSE indication checking (default: 0.05%)
                </p>
              </div>
            </div>

            <div className="border-t pt-6 space-y-6">
              <h4 className="text-sm font-semibold mb-4">Calculation Settings</h4>

              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-semibold">Calculation Range (seconds)</Label>
                    <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {settings.marketActivity.calculationRange}s
                    </span>
                  </div>
                  <Slider
                    value={[settings.marketActivity.calculationRange]}
                    onValueChange={(value) => updateMarketActivitySetting("calculationRange", value[0])} // Pass number directly
                    min={5}
                    max={20}
                    step={1}
                    className="w-full"
                  />
                  <p className="text-xs text-muted-foreground">
                    Time window for market activity analysis (5-20 seconds, default: 10s)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-base font-semibold">Calculation Frame</Label>
                  <div className="p-3 bg-muted rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Frame Duration</span>
                      <Badge variant="outline">{settings.marketActivity.calculationFrame} second</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Each frame calculates the average price change for smooth market activity detection
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-semibold">Position Cost Ratio (Minimum/Average)</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                        {calculatePositionCostRatio(settings.marketActivity.positionCostRatioIndex).toFixed(2)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        (Index: {settings.marketActivity.positionCostRatioIndex})
                      </span>
                    </div>
                  </div>
                  <Slider
                    value={[settings.marketActivity.positionCostRatioIndex]}
                    onValueChange={(value) => updateMarketActivitySetting("positionCostRatioIndex", value[0])} // Pass number directly
                    min={1}
                    max={20}
                    step={1}
                    className="w-full"
                  />
                  <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <div>Min: 0.05 (Index 1)</div>
                    <div className="text-center">Default: 0.10 (Index 2)</div>
                    <div className="text-right">Max: 1.00 (Index 20)</div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Minimum/average position cost ratio per second for market activity validation. Higher values require
                    stronger price movements.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Activity States</h4>
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge className="bg-green-500 text-white text-xs">ACTIVE</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Market activity ≥ Activation Threshold. All indications are being checked normally.
                  </p>
                </div>

                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge className="bg-yellow-500 text-white text-xs">MONITORING</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Activity between Deactivation and Activation thresholds. System maintains current state.
                  </p>
                </div>

                <div className="p-3 bg-gray-500/10 border border-gray-500/20 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs">
                      PAUSED
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Market activity &lt; Deactivation Threshold. Indication checking is paused until market becomes
                    active.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <h4 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-300">Benefits</h4>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
                  <span>Reduces false signals during flat or choppy markets</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
                  <span>Saves computational resources by pausing checks in inactive markets</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
                  <span>
                    Provides hysteresis (different activation/deactivation thresholds) to prevent rapid state changes
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
                  <span>Applies globally to all main indication types for consistent behavior</span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Direction Indication */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <TrendingUp className="h-5 w-5 text-blue-500" />
                <div>
                  <CardTitle>Direction Indication</CardTitle>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="direction-enabled"
                  checked={settings.direction.enabled}
                  onCheckedChange={() => toggleIndicationEnabled("direction")}
                />
                <Label htmlFor="direction-enabled" className="text-sm font-normal cursor-pointer">
                  Enabled
                </Label>
              </div>
            </div>
            <CardDescription>
              Settings for direction change indications with additional per-second market change calculations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Range From</Label>
                <Input
                  type="number"
                  value={settings.direction.range.from}
                  onChange={(e) => updateSetting("direction", "range", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Range To</Label>
                <Input
                  type="number"
                  value={settings.direction.range.to}
                  onChange={(e) => updateSetting("direction", "range", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="1"
                  value={settings.direction.range.step}
                  onChange={(e) => updateSetting("direction", "range", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Count: {calculateCount(settings.direction.range)} variations
            </p>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Drawdown Ratio From</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.direction.drawdown_ratio.from}
                  onChange={(e) => updateSetting("direction", "drawdown_ratio", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Drawdown Ratio To</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.direction.drawdown_ratio.to}
                  onChange={(e) => updateSetting("direction", "drawdown_ratio", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.direction.drawdown_ratio.step}
                  onChange={(e) => updateSetting("direction", "drawdown_ratio", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Count: {calculateCount(settings.direction.drawdown_ratio)} variations
            </p>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Market Change Calculation (Per Second Activity)</h4>
              <p className="text-xs text-muted-foreground mb-4">
                Additional per-second price change calculations in effective direction with last 20% activity analysis
              </p>

              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-semibold">Market Change Range (1-10, step 2)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Calculated range in effective direction: 1, 3, 5, 7, 9 (maps to position cost ratios 0.1 to 1.344)
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="2"
                        min="1"
                        max="10"
                        value={settings.direction.market_change_range.from}
                        onChange={(e) => updateSetting("direction", "market_change_range", "from", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="2"
                        min="1"
                        max="10"
                        value={settings.direction.market_change_range.to}
                        onChange={(e) => updateSetting("direction", "market_change_range", "to", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="2"
                        value={settings.direction.market_change_range.step}
                        onChange={(e) => updateSetting("direction", "market_change_range", "step", e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.direction.market_change_range)} variations
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Last Part Base (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={settings.direction.market_change_lastpart_base}
                    onChange={(e) => updateSetting("direction", "market_change_lastpart_base", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Base percentage for last part activity (20% = 0.2 ratio) - analyzes the last 20% with higher changes
                  </p>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Last Part Activity Ratios (1.0-2.5, step 0.5)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Multipliers for last 20% activity difference: 1.0, 1.5, 2.0, 2.5
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.direction.market_change_lastpart_ratios.from}
                        onChange={(e) =>
                          updateSetting("direction", "market_change_lastpart_ratios", "from", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.direction.market_change_lastpart_ratios.to}
                        onChange={(e) =>
                          updateSetting("direction", "market_change_lastpart_ratios", "to", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.direction.market_change_lastpart_ratios.step}
                        onChange={(e) =>
                          updateSetting("direction", "market_change_lastpart_ratios", "step", e.target.value)
                        }
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.direction.market_change_lastpart_ratios)} variations
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Minimum Calculation Time (seconds)</Label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    value={settings.direction.min_calculation_time}
                    onChange={(e) => updateSetting("direction", "min_calculation_time", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum time to average market changes before validation (Default: 3 seconds)
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Engine Configuration (Independent per Indication)</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Interval (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.direction.interval}
                    onChange={(e) => updateSetting("direction", "interval", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Engine check interval</p>
                </div>
                <div className="space-y-2">
                  <Label>Timeout Time (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.direction.timeout}
                    onChange={(e) => updateSetting("direction", "timeout", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pause duration after validated state (Default: 3 seconds)
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Move Indication */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-green-500" />
                <div>
                  <CardTitle>Move Indication</CardTitle>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="move-enabled"
                  checked={settings.move.enabled}
                  onCheckedChange={() => toggleIndicationEnabled("move")}
                />
                <Label htmlFor="move-enabled" className="text-sm font-normal cursor-pointer">
                  Enabled
                </Label>
              </div>
            </div>
            <CardDescription>
              Settings for move indications without opposite direction with additional per-second market change
              calculations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Range From</Label>
                <Input
                  type="number"
                  value={settings.move.range.from}
                  onChange={(e) => updateSetting("move", "range", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Range To</Label>
                <Input
                  type="number"
                  value={settings.move.range.to}
                  onChange={(e) => updateSetting("move", "range", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="1"
                  value={settings.move.range.step}
                  onChange={(e) => updateSetting("move", "range", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">Count: {calculateCount(settings.move.range)} variations</p>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Drawdown Ratio From</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.move.drawdown_ratio.from}
                  onChange={(e) => updateSetting("move", "drawdown_ratio", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Drawdown Ratio To</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.move.drawdown_ratio.to}
                  onChange={(e) => updateSetting("move", "drawdown_ratio", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.move.drawdown_ratio.step}
                  onChange={(e) => updateSetting("move", "drawdown_ratio", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Count: {calculateCount(settings.move.drawdown_ratio)} variations
            </p>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Market Change Calculation (Per Second Activity)</h4>
              <p className="text-xs text-muted-foreground mb-4">
                Additional per-second price change calculations in effective direction with last 20% activity analysis
              </p>

              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-semibold">Market Change Range (1-10, step 2)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Calculated range in effective direction: 1, 3, 5, 7, 9 (maps to position cost ratios 0.1 to 1.344)
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="2"
                        min="1"
                        max="10"
                        value={settings.move.market_change_range.from}
                        onChange={(e) => updateSetting("move", "market_change_range", "from", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="2"
                        min="1"
                        max="10"
                        value={settings.move.market_change_range.to}
                        onChange={(e) => updateSetting("move", "market_change_range", "to", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="2"
                        value={settings.move.market_change_range.step}
                        onChange={(e) => updateSetting("move", "market_change_range", "step", e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.move.market_change_range)} variations
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Last Part Base (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={settings.move.market_change_lastpart_base}
                    onChange={(e) => updateSetting("move", "market_change_lastpart_base", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Base percentage for last part activity (20% = 0.2 ratio) - analyzes the last 20% with higher changes
                  </p>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Last Part Activity Ratios (1.0-2.5, step 0.5)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Multipliers for last 20% activity difference: 1.0, 1.5, 2.0, 2.5
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.move.market_change_lastpart_ratios.from}
                        onChange={(e) => updateSetting("move", "market_change_lastpart_ratios", "from", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.move.market_change_lastpart_ratios.to}
                        onChange={(e) => updateSetting("move", "market_change_lastpart_ratios", "to", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.move.market_change_lastpart_ratios.step}
                        onChange={(e) => updateSetting("move", "market_change_lastpart_ratios", "step", e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.move.market_change_lastpart_ratios)} variations
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Minimum Calculation Time (seconds)</Label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    value={settings.move.min_calculation_time}
                    onChange={(e) => updateSetting("move", "min_calculation_time", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum time to average market changes before validation (Default: 3 seconds)
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Engine Configuration (Independent per Indication)</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Interval (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.move.interval}
                    onChange={(e) => updateSetting("move", "interval", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Engine check interval</p>
                </div>
                <div className="space-y-2">
                  <Label>Timeout Time (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.move.timeout}
                    onChange={(e) => updateSetting("move", "timeout", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pause duration after validated state (Default: 3 seconds)
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Active Indication */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Zap className="h-5 w-5 text-yellow-500" />
                <div>
                  <CardTitle>Active Indication</CardTitle>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="active-enabled"
                  checked={settings.active.enabled}
                  onCheckedChange={() => toggleIndicationEnabled("active")}
                />
                <Label htmlFor="active-enabled" className="text-sm font-normal cursor-pointer">
                  Enabled
                </Label>
              </div>
            </div>
            <CardDescription>
              Settings for fast price change indications with range-based ratios and per-second market change
              calculations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              <div>
                <Label className="text-base font-semibold">Active Range (1-10)</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Range 1 = 0.1 ratio from position cost | Range 10 = 1.5 ratio from position cost
                </p>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      max="10"
                      value={settings.active.range.from}
                      onChange={(e) => updateSetting("active", "range", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      max="10"
                      value={settings.active.range.to}
                      onChange={(e) => updateSetting("active", "range", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="1"
                      value={settings.active.range.step}
                      onChange={(e) => updateSetting("active", "range", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Count: {calculateCount(settings.active.range)} variations
                </p>
                <p className="text-xs text-muted-foreground mt-1">Formula: ratio = 0.1 + (range - 1) × 0.1556</p>
              </div>

              <div>
                <Label className="text-base font-semibold">Activity for Calculated Positions (%)</Label>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="10"
                      value={settings.active.activity_calculated.from}
                      onChange={(e) => updateSetting("active", "activity_calculated", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="10"
                      value={settings.active.activity_calculated.to}
                      onChange={(e) => updateSetting("active", "activity_calculated", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="1"
                      value={settings.active.activity_calculated.step}
                      onChange={(e) => updateSetting("active", "activity_calculated", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Count: {calculateCount(settings.active.activity_calculated)} variations
                </p>
              </div>

              <div>
                <Label className="text-base font-semibold">Activity Last Part (%)</Label>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="10"
                      value={settings.active.activity_lastpart.from}
                      onChange={(e) => updateSetting("active", "activity_lastpart", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="10"
                      value={settings.active.activity_lastpart.to}
                      onChange={(e) => updateSetting("active", "activity_lastpart", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="1"
                      value={settings.active.activity_lastpart.step}
                      onChange={(e) => updateSetting("active", "activity_lastpart", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Count: {calculateCount(settings.active.activity_lastpart)} variations
                </p>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Market Change Calculation (Per Second Activity)</h4>
              <p className="text-xs text-muted-foreground mb-4">
                Additional per-second price change calculations in effective direction with last 20% activity analysis
              </p>

              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-semibold">Market Change Range (1-10, step 1)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Calculated range in effective direction: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (maps to position cost ratios
                    0.1 to 1.5)
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="1"
                        min="1"
                        max="10"
                        value={settings.active.market_change_range.from}
                        onChange={(e) => updateSetting("active", "market_change_range", "from", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="1"
                        min="1"
                        max="10"
                        value={settings.active.market_change_range.to}
                        onChange={(e) => updateSetting("active", "market_change_range", "to", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="1"
                        value={settings.active.market_change_range.step}
                        onChange={(e) => updateSetting("active", "market_change_range", "step", e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.active.market_change_range)} variations
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Last Part Base (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={settings.active.market_change_lastpart_base}
                    onChange={(e) => updateSetting("active", "market_change_lastpart_base", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Base percentage for last part activity (20% = 0.2 ratio) - analyzes the last 20% with higher changes
                  </p>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Last Part Activity Ratios (1.0-2.5, step 0.5)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Multipliers for last 20% activity difference: 1.0, 1.5, 2.0, 2.5
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.active.market_change_lastpart_ratios.from}
                        onChange={(e) =>
                          updateSetting("active", "market_change_lastpart_ratios", "from", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.active.market_change_lastpart_ratios.to}
                        onChange={(e) => updateSetting("active", "market_change_lastpart_ratios", "to", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Step</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={settings.active.market_change_lastpart_ratios.step}
                        onChange={(e) =>
                          updateSetting("active", "market_change_lastpart_ratios", "step", e.target.value)
                        }
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Count: {calculateCount(settings.active.market_change_lastpart_ratios)} variations
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3">Engine Configuration (Independent per Indication)</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Interval (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.active.interval}
                    onChange={(e) => updateSetting("active", "interval", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Engine check interval</p>
                </div>
                <div className="space-y-2">
                  <Label>Timeout Time (seconds)</Label>
                  <Input
                    type="number"
                    value={settings.active.timeout}
                    onChange={(e) => updateSetting("active", "timeout", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pause duration after validated state (Default: 3 seconds)
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Minimum Calculation Time (seconds)</Label>
              <Input
                type="number"
                step="1"
                min="1"
                value={settings.active.min_calculation_time}
                onChange={(e) => updateSetting("active", "min_calculation_time", "", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Minimum time to average market changes before validation (Default: 3 seconds)
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Active Advanced Indication */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-purple-500" />
              Active Advanced Indication
              <Badge variant="default" className="text-xs">
                NEW
              </Badge>
            </CardTitle>
            <CardDescription>
              Uses optimal market change calculations for positive success with activity percentage ratios for
              frequently and short time trades (1-40 min)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              <div>
                <Label className="text-base font-semibold">Activity Ratios (%)</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Percentage change thresholds: 0.5%, 1.0%, 1.5%, 2.0%, 2.5%, 3.0%
                </p>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="10"
                      value={settings.active_advanced?.activity_ratios?.from || 0.5}
                      onChange={(e) => updateSetting("active_advanced", "activity_ratios", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="10"
                      value={settings.active_advanced?.activity_ratios?.to || 3.0}
                      onChange={(e) => updateSetting("active_advanced", "activity_ratios", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={settings.active_advanced?.activity_ratios?.step || 0.5}
                      onChange={(e) => updateSetting("active_advanced", "activity_ratios", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Count:{" "}
                  {calculateCount(settings.active_advanced?.activity_ratios || { from: 0.5, to: 3.0, step: 0.5 })}{" "}
                  variations
                </p>
              </div>

              <div>
                <Label className="text-base font-semibold">Time Windows (minutes)</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Analysis time frames: 1, 3, 5, 10, 15, 20, 30, 40 minutes
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {[1, 3, 5, 10, 15, 20, 30, 40].map((window) => (
                    <Badge key={window} variant="outline" className="text-xs px-2 py-1">
                      {window}min
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Each activity ratio is tested across all time windows
                </p>
              </div>

              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-semibold mb-3">Market Change Calculations</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Advanced per-second calculations for optimal positive success rates
                </p>

                <div className="space-y-3">
                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Overall Market Change</span>
                      <Badge variant="outline" className="text-xs">
                        Average Price Change
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Calculates average price change across the entire time window
                    </p>
                  </div>

                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Last Part Change</span>
                      <Badge variant="outline" className="text-xs">
                        Last 20%
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Analyzes the last 20% of time window for continuation validation
                    </p>
                  </div>

                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Volatility Check</span>
                      <Badge variant="outline" className="text-xs">
                        Standard Deviation
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Ensures market is active (not flat) with minimum 0.1% volatility
                    </p>
                  </div>

                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Momentum Analysis</span>
                      <Badge variant="outline" className="text-xs">
                        Price Acceleration
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Calculates price acceleration to confirm trend strength
                    </p>
                  </div>

                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Drawdown Filter</span>
                      <Badge variant="outline" className="text-xs">
                        Max 5%
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Rejects indications with excessive drawdown within time window
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-semibold mb-3">Validation Criteria</h4>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span>Overall price change must meet or exceed activity ratio</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span>Last part shows continuation in same direction (min 60% of overall)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span>Volatility indicates active market (≥0.1%)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span>Momentum is positive (price acceleration)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span>Drawdown within acceptable limits (≤5.0%)</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Minimum Positions</Label>
                <Input
                  type="number"
                  value={settings.active_advanced?.min_positions || 3}
                  onChange={(e) => updateSetting("active_advanced", "min_positions", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Minimum data points required</p>
              </div>
              <div className="space-y-2">
                <Label>Continuation Ratio</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.active_advanced?.continuation_ratio || 0.6}
                  onChange={(e) => updateSetting("active_advanced", "continuation_ratio", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Min 60% continuation required</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Optimal Indication */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-blue-500" />
                <CardTitle>Optimal Indication</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Enabled</span>
                <Switch
                  checked={settings.optimal?.enabled !== false}
                  onCheckedChange={(checked) =>
                    setSettings((prev) => ({
                      ...prev,
                      optimal: { ...prev.optimal, enabled: checked },
                    }))
                  }
                />
              </div>
            </div>
            <CardDescription>
              Tracks market changes with trailing optimal ranges for dynamic entry timing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label className="text-base font-semibold">Range (Consecutive Steps)</Label>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      min="3"
                      max="100"
                      value={settings.optimal?.range?.from || 3}
                      onChange={(e) => updateSetting("optimal", "range", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      min="3"
                      max="100"
                      value={settings.optimal?.range?.to || 30}
                      onChange={(e) => updateSetting("optimal", "range", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      min="1"
                      value={settings.optimal?.range?.step || 1}
                      onChange={(e) => updateSetting("optimal", "range", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Count: {calculateCount(settings.optimal?.range || { from: 3, to: 30, step: 1 })} variations
                </p>
              </div>

              <div className="border-t pt-4">
                <h4 className="text-sm font-semibold mb-3">Interval & Timeout Settings</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Check Interval (seconds)</Label>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      max="60"
                      value={settings.optimal?.interval || 2}
                      onChange={(e) => updateSetting("optimal", "interval", null, e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">How often to check for optimal patterns</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Timeout (seconds)</Label>
                    <Input
                      type="number"
                      step="1"
                      min="3"
                      max="60"
                      value={settings.optimal?.timeout || 10}
                      onChange={(e) => updateSetting("optimal", "timeout", null, e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Maximum wait time (Interval × 5)</p>
                  </div>
                </div>
              </div>

              <div className="border-t pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-base font-semibold">Trailing Optimal Ranges</Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Dynamically adjust ranges based on market conditions
                    </p>
                  </div>
                  <Switch
                    checked={settings.optimal?.trailing_optimal_ranges !== false}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({
                        ...prev,
                        optimal: { ...prev.optimal, trailing_optimal_ranges: checked },
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
