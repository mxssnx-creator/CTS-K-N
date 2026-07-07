"use client"
export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/simple-toast"

export default function AutoIndicationPage() {
  const [settings, setSettings] = useState<any>({
    enabled: true,
    activity_ratios: { from: 0.5, to: 3.0, step: 0.5 },
    activity_threshold: { from: 1.0, to: 3.0, step: 0.5 },
    detection_window: { from: 60, to: 120, step: 30 },
    drawdown_ratios: { from: 0.01, to: 0.05, step: 0.01 },
    per_second_activity: { from: 0.5, to: 2.0, step: 0.25 },
    min_positions: 3,
    continuation_ratio: 0.6,
    interval: 1,
    timeout: 3,
  })

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  /**
   * The `/api/settings/indications/main` route stores a single JSON blob at
   * Redis key `indications:main` and returns it under `{ success, settings }`.
   * The auto-advanced indication lives at `settings.active_advanced` within
   * that blob, so:
   *   - GET   → unwrap data.settings.active_advanced
   *   - POST  → merge active_advanced back into the full settings object and
   *             POST the whole object under `{ settings }` (there is no PATCH
   *             verb defined on this route)
   * This replaces the previous implementation which read/wrote at the wrong
   * nesting level and used an unsupported PATCH method — leading to silent
   * "save succeeded" toasts while nothing actually persisted.
   */
  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings/indications/main?t=" + Date.now())
      if (response.ok) {
        const data = await response.json()
        const advanced = data?.settings?.active_advanced
        if (advanced && typeof advanced === "object") {
          // Merge server-stored values on top of defaults so partial blobs
          // (older installs that only persisted some fields) still render.
          setSettings((prev: any) => ({ ...prev, ...advanced }))
        }
      }
    } catch (error) {
      console.error("[v0] Failed to load auto indication settings:", error)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Fetch the current full blob so we can merge our slice back in without
      // clobbering sibling settings (direction / move / active / optimal etc).
      const currentResp = await fetch("/api/settings/indications/main?t=" + Date.now())
      const currentData = currentResp.ok ? await currentResp.json() : { settings: {} }
      const updated = {
        ...(currentData?.settings || {}),
        active_advanced: settings,
      }

      const response = await fetch("/api/settings/indications/main", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updated }),
      })

      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Failed to save settings")
      }

      toast.success("Auto indication settings saved successfully")
    } catch (error) {
      console.error("[v0] Failed to save:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  const updateSetting = (category: string, field: string, value: any) => {
    if (category) {
      setSettings((prev: any) => ({
        ...prev,
        [category]: {
          ...prev[category],
          [field]: parseFloat(value) || value,
        },
      }))
    } else {
      setSettings((prev: any) => ({
        ...prev,
        [field]: parseFloat(value) || value,
      }))
    }
  }

  const calculateCount = (range: { from: number; to: number; step: number }) => {
    return Math.floor((range.to - range.from) / range.step) + 1
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Auto Indication (Advanced)</h1>
          <p className="text-muted-foreground">
            Advanced automatic indication with activity tracking and market analysis
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Auto Indication</CardTitle>
              <CardDescription>
                Comprehensive 8-hour market analysis with progressive strategies for short-time trades
              </CardDescription>
            </div>
            <Switch
              checked={settings.enabled !== false}
              onCheckedChange={(checked) => setSettings((prev: any) => ({ ...prev, enabled: checked }))}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Activity Ratios */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Activity Ratios Range</h3>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_ratios?.from || 0.5}
                  onChange={(e) => updateSetting("activity_ratios", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_ratios?.to || 3.0}
                  onChange={(e) => updateSetting("activity_ratios", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_ratios?.step || 0.5}
                  onChange={(e) => updateSetting("activity_ratios", "step", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Count</Label>
                <div className="h-10 flex items-center justify-center border rounded-md bg-muted">
                  {calculateCount(settings.activity_ratios || { from: 0.5, to: 3.0, step: 0.5 })}
                </div>
              </div>
            </div>
          </div>

          {/* Activity Threshold */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Activity Threshold Range</h3>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_threshold?.from || 1.0}
                  onChange={(e) => updateSetting("activity_threshold", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_threshold?.to || 3.0}
                  onChange={(e) => updateSetting("activity_threshold", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.activity_threshold?.step || 0.5}
                  onChange={(e) => updateSetting("activity_threshold", "step", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Count</Label>
                <div className="h-10 flex items-center justify-center border rounded-md bg-muted">
                  {calculateCount(settings.activity_threshold || { from: 1.0, to: 3.0, step: 0.5 })}
                </div>
              </div>
            </div>
          </div>

          {/* Detection Window */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Detection Window (seconds)</h3>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  value={settings.detection_window?.from || 60}
                  onChange={(e) => updateSetting("detection_window", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  value={settings.detection_window?.to || 120}
                  onChange={(e) => updateSetting("detection_window", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  value={settings.detection_window?.step || 30}
                  onChange={(e) => updateSetting("detection_window", "step", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Count</Label>
                <div className="h-10 flex items-center justify-center border rounded-md bg-muted">
                  {calculateCount(settings.detection_window || { from: 60, to: 120, step: 30 })}
                </div>
              </div>
            </div>
          </div>

          {/* Drawdown Ratios */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Drawdown Ratios Range</h3>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={settings.drawdown_ratios?.from || 0.01}
                  onChange={(e) => updateSetting("drawdown_ratios", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={settings.drawdown_ratios?.to || 0.05}
                  onChange={(e) => updateSetting("drawdown_ratios", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={settings.drawdown_ratios?.step || 0.01}
                  onChange={(e) => updateSetting("drawdown_ratios", "step", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Count</Label>
                <div className="h-10 flex items-center justify-center border rounded-md bg-muted">
                  {calculateCount(settings.drawdown_ratios || { from: 0.01, to: 0.05, step: 0.01 })}
                </div>
              </div>
            </div>
          </div>

          {/* Per Second Activity */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Per Second Activity Range</h3>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="number"
                  step="0.25"
                  value={settings.per_second_activity?.from || 0.5}
                  onChange={(e) => updateSetting("per_second_activity", "from", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="number"
                  step="0.25"
                  value={settings.per_second_activity?.to || 2.0}
                  onChange={(e) => updateSetting("per_second_activity", "to", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Step</Label>
                <Input
                  type="number"
                  step="0.25"
                  value={settings.per_second_activity?.step || 0.25}
                  onChange={(e) => updateSetting("per_second_activity", "step", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Count</Label>
                <div className="h-10 flex items-center justify-center border rounded-md bg-muted">
                  {calculateCount(settings.per_second_activity || { from: 0.5, to: 2.0, step: 0.25 })}
                </div>
              </div>
            </div>
          </div>

          {/* Additional Settings */}
          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold">Additional Configuration</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Minimum Positions</Label>
                <Input
                  type="number"
                  min="1"
                  value={settings.min_positions || 3}
                  onChange={(e) => updateSetting("", "min_positions", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum number of positions required for activation
                </p>
              </div>

              <div className="space-y-2">
                <Label>Continuation Ratio</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={settings.continuation_ratio || 0.6}
                  onChange={(e) => updateSetting("", "continuation_ratio", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Ratio for continuation of active positions
                </p>
              </div>
            </div>
          </div>

          {/* Engine Configuration */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-semibold mb-4">Engine Configuration</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Interval (seconds)</Label>
                <Input
                  type="number"
                  min="1"
                  max="60"
                  value={settings.interval || 1}
                  onChange={(e) => updateSetting("", "interval", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Update interval for auto indication engine
                </p>
              </div>

              <div className="space-y-2">
                <Label>Timeout (seconds)</Label>
                <Input
                  type="number"
                  min="1"
                  max="30"
                  value={settings.timeout || 3}
                  onChange={(e) => updateSetting("", "timeout", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum execution time before timeout
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
