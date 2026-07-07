"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/lib/simple-toast"
import { Save, CheckCircle } from "lucide-react"

export function ActiveAdvancedIndicationSettings() {
  const [settings, setSettings] = useState({
    activity_ratios: { from: 0.5, to: 3.0, step: 0.5 },
    time_windows: [1, 3, 5, 10, 15, 20, 30, 40],
    min_positions: 3,
    continuation_ratio: 0.6,
    min_volatility: 0.1,
    max_drawdown: 5.0,
  })
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings/indications/active-advanced")
      if (response.ok) {
        const data = await response.json()
        if (data.settings) {
          setSettings(data.settings)
        }
      }
    } catch (error) {
      console.error("Failed to load settings:", error)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const response = await fetch("/api/settings/indications/active-advanced", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })

      if (response.ok) {
        toast.success("Active Advanced settings saved successfully")
      } else {
        toast.error("Failed to save settings")
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setIsSaving(false)
    }
  }

  const updateSetting = (field: string, subfield: string | null, value: any) => {
    setSettings((prev: any) => ({
      ...prev,
      [field]: subfield ? { ...prev[field], [subfield]: value } : value,
    }))
  }

  const calculateCount = (range: { from: number; to: number; step: number }): number => {
    return Math.floor((range.to - range.from) / range.step) + 1
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving} size="sm">
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>

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
                value={settings.activity_ratios.from}
                onChange={(e) => updateSetting("activity_ratios", "from", Number.parseFloat(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">To</Label>
              <Input
                type="number"
                step="0.5"
                min="0.5"
                max="10"
                value={settings.activity_ratios.to}
                onChange={(e) => updateSetting("activity_ratios", "to", Number.parseFloat(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Step</Label>
              <Input
                type="number"
                step="0.5"
                value={settings.activity_ratios.step}
                onChange={(e) => updateSetting("activity_ratios", "step", Number.parseFloat(e.target.value))}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Count: {calculateCount(settings.activity_ratios)} variations
          </p>
        </div>

        <div>
          <Label className="text-base font-semibold">Time Windows (minutes)</Label>
          <p className="text-sm text-muted-foreground mb-2">
            Analysis time frames: 1, 3, 5, 10, 15, 20, 30, 40 minutes
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            {settings.time_windows.map((window) => (
              <Badge key={window} variant="outline" className="text-xs px-2 py-1">
                {window}min
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Each activity ratio is tested across all time windows ({calculateCount(settings.activity_ratios)} ×{" "}
            {settings.time_windows.length} = {calculateCount(settings.activity_ratios) * settings.time_windows.length}{" "}
            combinations)
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
                Ensures market is active (not flat) with minimum {settings.min_volatility}% volatility
              </p>
            </div>

            <div className="p-3 bg-muted rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Momentum Analysis</span>
                <Badge variant="outline" className="text-xs">
                  Price Acceleration
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">Calculates price acceleration to confirm trend strength</p>
            </div>

            <div className="p-3 bg-muted rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Drawdown Filter</span>
                <Badge variant="outline" className="text-xs">
                  Max {settings.max_drawdown}%
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
              <span>
                Last part shows continuation in same direction (min {settings.continuation_ratio * 100}% of overall)
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
              <span>Volatility indicates active market (≥{settings.min_volatility}%)</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
              <span>Momentum is positive (price acceleration)</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
              <span>Drawdown within acceptable limits (≤{settings.max_drawdown}%)</span>
            </li>
          </ul>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Minimum Positions</Label>
            <Input
              type="number"
              value={settings.min_positions}
              onChange={(e) => updateSetting("min_positions", null, Number.parseInt(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">Minimum data points required</p>
          </div>
          <div className="space-y-2">
            <Label>Continuation Ratio</Label>
            <Input
              type="number"
              step="0.1"
              value={settings.continuation_ratio}
              onChange={(e) => updateSetting("continuation_ratio", null, Number.parseFloat(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">Min continuation required (0-1)</p>
          </div>
          <div className="space-y-2">
            <Label>Min Volatility (%)</Label>
            <Input
              type="number"
              step="0.1"
              value={settings.min_volatility}
              onChange={(e) => updateSetting("min_volatility", null, Number.parseFloat(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">Minimum volatility threshold</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ActiveAdvancedIndicationSettings
