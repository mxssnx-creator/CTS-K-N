"use client"
export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/lib/simple-toast"
import { Save, Sparkles, Info } from 'lucide-react'
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"

export default function OptimalIndicationSettingsPage() {
  const [settings, setSettings] = useState({
    optimal: {
      enabled: false,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      min_calculation_time: 3,
      base_positions_limit: 250,
      interval: 1,
      timeout: 3,
      initial_min_win_rate: 0.4,
      expanded_min_win_rate: 0.45,
      expanded_min_profit_ratio: 1.2,
      production_min_win_rate: 0.42,
      production_max_drawdown: 0.3,
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
      if (data.success && data.settings.optimal) {
        setSettings({ optimal: data.settings.optimal })
      }
    } catch (error) {
      console.error("[v0] Failed to load optimal indication settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const response = await fetch("/api/settings/indications/main")
      const currentData = await response.json()

      const updatedSettings = {
        ...currentData.settings,
        optimal: settings.optimal,
      }

      const saveResponse = await fetch("/api/settings/indications/main", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updatedSettings }),
      })

      const data = await saveResponse.json()
      if (data.success) {
        toast.success("Optimal indication settings saved successfully")
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

  const updateSetting = (field: string, subfield: string, value: string) => {
    setSettings((prev: any) => ({
      optimal: {
        ...prev.optimal,
        [field]: subfield ? { ...prev.optimal[field], [subfield]: Number.parseFloat(value) } : Number.parseFloat(value),
      },
    }))
  }

  const toggleOptimalEnabled = () => {
    setSettings((prev: any) => ({
      optimal: {
        ...prev.optimal,
        enabled: !prev.optimal.enabled,
      },
    }))
  }

  const calculateCount = (range: { from: number; to: number; step: number }): number => {
    return Math.floor((range.to - range.from) / range.step) + 1
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
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="h-8 w-8 text-purple-500" />
            Optimal Indication Settings
          </h1>
          <p className="text-muted-foreground mt-2">
            Advanced indication type with independent Sets (per-Set DB capacity up to 250 positions, tunable),
            performance tracking, and consecutive step detection
          </p>
        </div>
        <Button onClick={handleSave} disabled={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Optimal indications use a multi-phase evaluation system. Each configuration is an Independent Set
          whose position history is capped at the Set DB capacity (default 250 positions per Set — this is database
          length, not an indication-count limit). Sets are tested through evaluation phases before creating full
          position matrices.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-purple-500" />
              <div>
                <CardTitle>Optimal Indication Configuration</CardTitle>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="optimal-enabled"
                checked={settings.optimal.enabled}
                onCheckedChange={toggleOptimalEnabled}
              />
              <Label htmlFor="optimal-enabled" className="text-sm font-normal cursor-pointer">
                Enabled
              </Label>
            </div>
          </div>
          <CardDescription>
            Uses consecutive step detection, market change calculations, and performance-based filtering
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Base Range Settings */}
          <div>
            <Label className="text-base font-semibold">Range Settings</Label>
            <div className="grid grid-cols-3 gap-4 mt-3">
              <div className="space-y-2">
                <Label>Range From</Label>
                <Input
                  type="number"
                  value={settings.optimal.range.from}
                  onChange={(e) => updateSetting("range", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Range To</Label>
                <Input
                  type="number"
                  value={settings.optimal.range.to}
                  onChange={(e) => updateSetting("range", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="1"
                  value={settings.optimal.range.step}
                  onChange={(e) => updateSetting("range", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Count: {calculateCount(settings.optimal.range)} variations | Detects consecutive opposite direction steps
            </p>
          </div>

          {/* Drawdown Ratio */}
          <div>
            <Label className="text-base font-semibold">Drawdown Ratio (Performance Filter)</Label>
            <div className="grid grid-cols-3 gap-4 mt-3">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.optimal.drawdown_ratio.from}
                  onChange={(e) => updateSetting("drawdown_ratio", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.optimal.drawdown_ratio.to}
                  onChange={(e) => updateSetting("drawdown_ratio", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.optimal.drawdown_ratio.step}
                  onChange={(e) => updateSetting("drawdown_ratio", "step", e.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Count: {calculateCount(settings.optimal.drawdown_ratio)} variations | Filters positions by max drawdown
              from peak
            </p>
          </div>

          {/* Set DB Capacity */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">Set DB Capacity (positions per Independent Set)</Label>
            <Input
              type="number"
              step="10"
              min="50"
              max="500"
              value={settings.optimal.base_positions_limit}
              onChange={(e) => updateSetting("base_positions_limit", "", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Database length per Set — maximum pseudo-positions this Set can store before rearrangement (default 250,
              tunable 50–500). This is storage capacity, NOT an indication-count limit. Each Set is an independent
              unit; capacity is not shared across Sets.
            </p>
          </div>

          {/* Market Change Calculation */}
          <div className="border-t pt-6">
            <h4 className="text-base font-semibold mb-4">Market Change Calculation (Per-Second Activity)</h4>

            <div className="space-y-4">
              <div>
                <Label className="text-sm font-semibold">Market Change Range (1-10, step 2)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Values: 1, 3, 5, 7, 9 (maps to position cost ratios 0.1 to 1.344)
                </p>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="2"
                      min="1"
                      max="10"
                      value={settings.optimal.market_change_range.from}
                      onChange={(e) => updateSetting("market_change_range", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="2"
                      min="1"
                      max="10"
                      value={settings.optimal.market_change_range.to}
                      onChange={(e) => updateSetting("market_change_range", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="2"
                      value={settings.optimal.market_change_range.step}
                      onChange={(e) => updateSetting("market_change_range", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  Count: {calculateCount(settings.optimal.market_change_range)} variations
                </p>
              </div>

              <div className="space-y-2">
                <Label>Last Part Base (%)</Label>
                <Input
                  type="number"
                  step="1"
                  min="10"
                  max="50"
                  value={settings.optimal.market_change_lastpart_base}
                  onChange={(e) => updateSetting("market_change_lastpart_base", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Percentage for last part acceleration analysis (default 20%)
                </p>
              </div>

              <div>
                <Label className="text-sm font-semibold">Last Part Acceleration Ratios</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Multipliers: 1.0, 1.5, 2.0, 2.5 (compares last 20% to overall average)
                </p>
                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">From</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={settings.optimal.market_change_lastpart_ratios.from}
                      onChange={(e) => updateSetting("market_change_lastpart_ratios", "from", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={settings.optimal.market_change_lastpart_ratios.to}
                      onChange={(e) => updateSetting("market_change_lastpart_ratios", "to", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Step</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={settings.optimal.market_change_lastpart_ratios.step}
                      onChange={(e) => updateSetting("market_change_lastpart_ratios", "step", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  Count: {calculateCount(settings.optimal.market_change_lastpart_ratios)} variations
                </p>
              </div>

              <div className="space-y-2">
                <Label>Minimum Calculation Time (seconds)</Label>
                <Input
                  type="number"
                  step="1"
                  min="1"
                  max="10"
                  value={settings.optimal.min_calculation_time}
                  onChange={(e) => updateSetting("min_calculation_time", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum time to collect data before validating market acceleration (default: 3 seconds)
                </p>
              </div>
            </div>
          </div>

          {/* Performance Thresholds */}
          <div className="border-t pt-6">
            <h4 className="text-base font-semibold mb-4">Performance Thresholds (Evaluation Phases)</h4>

            <div className="space-y-4">
              <div className="bg-muted/50 p-4 rounded-lg space-y-3">
                <h5 className="font-semibold text-sm">Phase 1: Initial Evaluation (0-10 positions)</h5>
                <div className="space-y-2">
                  <Label>Minimum Win Rate</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={settings.optimal.initial_min_win_rate}
                    onChange={(e) => updateSetting("initial_min_win_rate", "", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Must achieve this win rate after 10 test positions (default: 0.40 = 40%)
                  </p>
                </div>
              </div>

              <div className="bg-muted/50 p-4 rounded-lg space-y-3">
                <h5 className="font-semibold text-sm">Phase 2: Expanded Evaluation (11-50 positions)</h5>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Minimum Win Rate</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={settings.optimal.expanded_min_win_rate}
                      onChange={(e) => updateSetting("expanded_min_win_rate", "", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Default: 0.45 (45%)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Min Profit Ratio</Label>
                    <Input
                      type="number"
                      step="0.1"
                      min="1"
                      max="3"
                      value={settings.optimal.expanded_min_profit_ratio}
                      onChange={(e) => updateSetting("expanded_min_profit_ratio", "", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Avg profit / avg loss (default: 1.2)</p>
                  </div>
                </div>
              </div>

              <div className="bg-muted/50 p-4 rounded-lg space-y-3">
                <h5 className="font-semibold text-sm">Phase 3: Production (50+ positions)</h5>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Minimum Win Rate</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={settings.optimal.production_min_win_rate}
                      onChange={(e) => updateSetting("production_min_win_rate", "", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Default: 0.42 (42%)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Drawdown</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={settings.optimal.production_max_drawdown}
                      onChange={(e) => updateSetting("production_max_drawdown", "", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Default: 0.30 (30%)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* System Settings */}
          <div className="border-t pt-6">
            <h4 className="text-base font-semibold mb-4">Engine Configuration (Independent per Indication)</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Interval (seconds)</Label>
                <Input
                  type="number"
                  value={settings.optimal.interval}
                  onChange={(e) => updateSetting("interval", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Engine check interval</p>
              </div>
              <div className="space-y-2">
                <Label>Timeout Time (seconds)</Label>
                <Input
                  type="number"
                  value={settings.optimal.timeout}
                  onChange={(e) => updateSetting("timeout", "", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Pause duration after validated state (Default: 3 seconds)</p>
              </div>
            </div>
          </div>

          {/* Configuration Summary */}
          <div className="border-t pt-6">
            <h4 className="text-base font-semibold mb-3">Configuration Summary</h4>
            <div className="bg-muted/30 p-4 rounded-lg space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Range variations:</span>
                <span className="font-mono">{calculateCount(settings.optimal.range)}</span>
              </div>
              <div className="flex justify-between">
                <span>Drawdown variations:</span>
                <span className="font-mono">{calculateCount(settings.optimal.drawdown_ratio)}</span>
              </div>
              <div className="flex justify-between">
                <span>Market change ranges:</span>
                <span className="font-mono">{calculateCount(settings.optimal.market_change_range)}</span>
              </div>
              <div className="flex justify-between">
                <span>Last part ratios:</span>
                <span className="font-mono">{calculateCount(settings.optimal.market_change_lastpart_ratios)}</span>
              </div>
              <div className="flex justify-between border-t pt-2 mt-2 font-semibold">
                <span>Total base configurations:</span>
                <span className="font-mono">
                  {calculateCount(settings.optimal.range) *
                    calculateCount(settings.optimal.drawdown_ratio) *
                    calculateCount(settings.optimal.market_change_range) *
                    calculateCount(settings.optimal.market_change_lastpart_ratios)}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Selected for evaluation (max):</span>
                <span className="font-mono">{settings.optimal.base_positions_limit}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
