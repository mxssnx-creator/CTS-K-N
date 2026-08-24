"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Info } from "lucide-react"
import type { PresetType } from "@/lib/types"

interface BaseSettings {
  trailingEnabled: boolean
  blockEnabled: boolean
  dcaEnabled: boolean
}

interface PresetTypeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetType: PresetType | null
  onSave: (presetTypeData: Partial<PresetType>) => void
}

export function PresetTypeDialog({ open, onOpenChange, presetType, onSave }: PresetTypeDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [presetTradeType, setPresetTradeType] = useState("standard")
  const [isActive, setIsActive] = useState(true)
  const [autoEvaluate, setAutoEvaluate] = useState(true)
  const [evaluationIntervalHours, setEvaluationIntervalHours] = useState(24)

  const [timeoutPerIndication, setTimeoutPerIndication] = useState(60)
  const [timeoutAfterPosition, setTimeoutAfterPosition] = useState(300)

  // Trailing is on by default for new preset types — the variant is
  // axis-independent in the coordinator and lifts hit-rate on TP-side
  // exits, so the operator opts OUT rather than in.
  const [trailingEnabled, setTrailingEnabled] = useState(true)

  const [blockEnabled, setBlockEnabled] = useState(true)
  const [dcaEnabled, setDcaEnabled] = useState(false)
  const [normalEnabled, setNormalEnabled] = useState(true)

  const [baseSettings, setBaseSettings] = useState<BaseSettings>({
    trailingEnabled: true,
    blockEnabled: true,
    dcaEnabled: false,
  })
  const [loadingBaseSettings, setLoadingBaseSettings] = useState(true)

  useEffect(() => {
    if (open) {
      fetchBaseSettings()
    }
  }, [open])

  const fetchBaseSettings = async () => {
    try {
      setLoadingBaseSettings(true)
      const response = await fetch("/api/settings")
      if (response.ok) {
        const settings = await response.json()
        setBaseSettings({
          trailingEnabled: settings.trailingEnabled !== false, // Default true
          blockEnabled: settings.blockEnabled !== false, // Default true
          dcaEnabled: settings.dcaEnabled === true, // Default false
        })
      }
    } catch (error) {
      console.error("[v0] Failed to fetch base settings:", error)
    } finally {
      setLoadingBaseSettings(false)
    }
  }

  useEffect(() => {
    if (presetType) {
      setName(presetType.name || "")
      setDescription(presetType.description || "")
      setPresetTradeType(presetType.preset_trade_type || "standard")
      setIsActive(presetType.is_active ?? true)
      setAutoEvaluate(presetType.auto_evaluate ?? true)
      setEvaluationIntervalHours(presetType.evaluation_interval_hours || 24)
      setTimeoutPerIndication(presetType.timeout_per_indication || 60)
      setTimeoutAfterPosition(presetType.timeout_after_position || 300)
      // Matches the new-preset default: when an older record didn't
      // persist `trailing_enabled`, treat it as ON rather than OFF so
      // the dialog UI agrees with the engine-side default.
      setTrailingEnabled(presetType.trailing_enabled ?? true)
      setBlockEnabled(presetType.block_enabled ?? true)
      setDcaEnabled(presetType.dca_enabled ?? false)
      setNormalEnabled((presetType as PresetType & { normal_enabled?: boolean }).normal_enabled ?? true)
    } else {
      // Reset to defaults for new preset type
      setName("")
      setDescription("")
      setPresetTradeType("standard")
      setIsActive(true)
      setAutoEvaluate(true)
      setEvaluationIntervalHours(24)
      setTimeoutPerIndication(60)
      setTimeoutAfterPosition(300)
      setTrailingEnabled(true)
      setBlockEnabled(true)
      setDcaEnabled(false)
      setNormalEnabled(true)
    }
  }, [presetType, open])

  const handleSave = () => {
    const presetTypeData: Partial<PresetType> = {
      name,
      description,
      preset_trade_type: presetTradeType,
      is_active: isActive,
      auto_evaluate: autoEvaluate,
      evaluation_interval_hours: evaluationIntervalHours,
      max_positions_per_indication: 0,
      max_positions_per_direction: 0,
      max_positions_per_range: 0,
      timeout_per_indication: timeoutPerIndication,
      timeout_after_position: timeoutAfterPosition,
      trailing_enabled: trailingEnabled && baseSettings.trailingEnabled,
      trailing_only: false,
      block_enabled: blockEnabled && baseSettings.blockEnabled,
      dca_enabled: dcaEnabled && baseSettings.dcaEnabled,
      dca_only: false,
      normal_enabled: normalEnabled,
    }

    onSave(presetTypeData)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{presetType ? "Edit Preset Type" : "Create Preset Type"}</DialogTitle>
          <DialogDescription>
            Configure a preset type with multiple configuration sets for coordinated trading
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., RSI + MACD Strategy"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe this preset type..."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tradeType">Trade Type</Label>
            <Input
              id="tradeType"
              value={presetTradeType}
              onChange={(e) => setPresetTradeType(e.target.value)}
              placeholder="e.g., standard, aggressive, conservative"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Active</Label>
              <p className="text-sm text-muted-foreground">Enable this preset type for trading</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto Evaluate</Label>
              <p className="text-sm text-muted-foreground">Automatically evaluate and open positions</p>
            </div>
            <Switch checked={autoEvaluate} onCheckedChange={setAutoEvaluate} />
          </div>

          <div className="space-y-2">
            <Label>Evaluation Interval: {evaluationIntervalHours} hours</Label>
            <Slider
              min={1}
              max={168}
              step={1}
              value={[evaluationIntervalHours]}
              onValueChange={([value]) => setEvaluationIntervalHours(value)}
            />
            <p className="text-xs text-muted-foreground">How often to evaluate configurations (1-168 hours)</p>
          </div>

          <div className="border-t pt-4 space-y-4">
            <h4 className="font-medium">Position Capacity</h4>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-4">
                <Label>Indication × config × direction lanes</Label>
                <Badge variant="secondary">Unlimited</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Every complete Preset configuration is processed. Worker concurrency and exchange
                rate limits control in-flight work only and never truncate configurations.
              </p>
            </div>
          </div>

          <div className="border-t pt-4 space-y-4">
            <h4 className="font-medium">Timeout Settings</h4>

            <div className="space-y-2">
              <Label>Timeout Per Indication: {timeoutPerIndication} seconds</Label>
              <Slider
                min={10}
                max={600}
                step={10}
                value={[timeoutPerIndication]}
                onValueChange={([value]) => setTimeoutPerIndication(value)}
              />
              <p className="text-xs text-muted-foreground">Cooldown between indication evaluations (10-600 seconds)</p>
            </div>

            <div className="space-y-2">
              <Label>Timeout After Position: {timeoutAfterPosition} seconds</Label>
              <Slider
                min={60}
                max={3600}
                step={60}
                value={[timeoutAfterPosition]}
                onValueChange={([value]) => setTimeoutAfterPosition(value)}
              />
              <p className="text-xs text-muted-foreground">Cooldown after opening a position (60-3600 seconds)</p>
            </div>
          </div>

          <div className="border-t pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Strategy Options</h4>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="h-3 w-3" />
                <span>Synced with Base Settings</span>
              </div>
            </div>

            {/* Additional Category - Trailing */}
            <div className="rounded-lg border border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/20 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 border-purple-300"
                >
                  Additional
                </Badge>
                <span className="text-sm text-muted-foreground">Enhancement strategies</span>
              </div>

              <div className={`flex items-center justify-between ${!baseSettings.trailingEnabled ? "opacity-50" : ""}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Label>Trailing Stop</Label>
                    {!baseSettings.trailingEnabled && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Disabled in Base Settings
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Enable trailing stop loss for dynamic profit protection
                  </p>
                </div>
                <Switch
                  checked={trailingEnabled}
                  onCheckedChange={setTrailingEnabled}
                  disabled={!baseSettings.trailingEnabled}
                />
              </div>
            </div>

            {/* Adjust Category - Block & DCA */}
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 border-blue-300"
                >
                  Adjust
                </Badge>
                <span className="text-sm text-muted-foreground">Volume/position adjustment strategies</span>
              </div>

              {/* Block Strategy */}
              <div className={`flex items-center justify-between ${!baseSettings.blockEnabled ? "opacity-50" : ""}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Label>Block Strategy</Label>
                    {!baseSettings.blockEnabled && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Disabled in Base Settings
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Enable block trading for volume adjustment</p>
                </div>
                <Switch
                  checked={blockEnabled}
                  onCheckedChange={setBlockEnabled}
                  disabled={!baseSettings.blockEnabled}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-primary/25 bg-primary/5 p-3">
                <div className="space-y-0.5">
                  <Label>Normal strategy</Label>
                  <p className="text-sm text-muted-foreground">Keep the default strategy family executable alongside enabled add-ons. Off preserves validation but gates orders.</p>
                </div>
                <Switch checked={normalEnabled} onCheckedChange={setNormalEnabled} />
              </div>

              {/* DCA Strategy */}
              <div className={`flex items-center justify-between ${!baseSettings.dcaEnabled ? "opacity-50" : ""}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Label>DCA Strategy</Label>
                    {!baseSettings.dcaEnabled && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Disabled in Base Settings
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Enable dollar-cost averaging for position adjustment</p>
                </div>
                <Switch checked={dcaEnabled} onCheckedChange={setDcaEnabled} disabled={!baseSettings.dcaEnabled} />
              </div>

            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            {presetType ? "Update" : "Create"} Preset Type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
