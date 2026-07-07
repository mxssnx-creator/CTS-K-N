"use client"
export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/lib/simple-toast"
import { Save, CheckCircle } from 'lucide-react'
import { Checkbox } from "@/components/ui/checkbox"

export default function CommonIndicationsSettingsPage() {
  const [settings, setSettings] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch(`/api/settings/indications/common?t=${Date.now()}`)
      const data = await response.json()
      if (data.success) {
        const settingsWithEnabled = Object.entries(data.settings).reduce(
          (acc, [key, value]: any) => {
            acc[key] = {
              ...value,
              enabled: value.enabled !== undefined ? value.enabled : (key !== "rsi" && key !== "macd"),
            }
            return acc
          },
          {} as any
        )
        setSettings(settingsWithEnabled)
      }
    } catch (error) {
      console.error("[v0] Failed to load common indication settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const response = await fetch("/api/settings/indications/common", {
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

  const updateSetting = (indicator: string, param: string, field: string, value: string) => {
    setSettings((prev: any) => ({
      ...prev,
      [indicator]: {
        ...prev[indicator],
        [param]:
          field === "interval" || field === "timeout"
            ? Number.parseFloat(value)
            : { ...prev[indicator][param], [field]: Number.parseFloat(value) },
      },
    }))
  }

  const toggleIndicatorEnabled = (indicator: string) => {
    setSettings((prev: any) => ({
      ...prev,
      [indicator]: {
        ...prev[indicator],
        enabled: !prev[indicator].enabled,
      },
    }))
  }

  if (isLoading || !settings) {
    return (
      <div className="p-6">
        <div className="text-center py-12">Loading settings...</div>
      </div>
    )
  }

  const renderParameterRow = (indicator: string, param: string, label: string) => (
    <div className="grid grid-cols-4 gap-4 items-center">
      <Label className="text-right">{label}</Label>
      <Input
        type="number"
        step="0.1"
        placeholder="From"
        value={settings[indicator][param].from}
        onChange={(e) => updateSetting(indicator, param, "from", e.target.value)}
      />
      <Input
        type="number"
        step="0.1"
        placeholder="To"
        value={settings[indicator][param].to}
        onChange={(e) => updateSetting(indicator, param, "to", e.target.value)}
      />
      <Input
        type="number"
        step="0.01"
        placeholder="Step"
        value={settings[indicator][param].step}
        onChange={(e) => updateSetting(indicator, param, "step", e.target.value)}
      />
    </div>
  )

  const renderIndicatorCard = (
    indicatorKey: string,
    indicatorName: string,
    indicatorDescription: string,
    parameters: { key: string, label: string }[]
  ) => (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between mb-4">
          <div>
            <CardTitle>{indicatorName}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${indicatorKey}-enabled`}
              checked={settings[indicatorKey].enabled}
              onCheckedChange={() => toggleIndicatorEnabled(indicatorKey)}
            />
            <Label htmlFor={`${indicatorKey}-enabled`} className="text-sm font-normal cursor-pointer">
              Enabled
            </Label>
          </div>
        </div>
        <CardDescription>{indicatorDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-4 items-center font-semibold text-sm">
          <div className="text-right">Parameter</div>
          <div>From</div>
          <div>To</div>
          <div>Step</div>
        </div>
        {parameters.map((param) => renderParameterRow(indicatorKey, param.key, param.label))}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div className="space-y-2">
            <Label>Interval (seconds)</Label>
            <Input
              type="number"
              value={settings[indicatorKey].interval}
              onChange={(e) => updateSetting(indicatorKey, "interval", "interval", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Engine check interval</p>
          </div>
          <div className="space-y-2">
            <Label>Timeout Time (seconds)</Label>
            <Input
              type="number"
              value={settings[indicatorKey].timeout}
              onChange={(e) => updateSetting(indicatorKey, "timeout", "timeout", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Pause duration after validated state (Default: 3 seconds)</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Common Indications Settings</h1>
          <p className="text-muted-foreground">Configure technical indicator parameters</p>
        </div>
        <Button onClick={handleSave} disabled={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </div>

      <div className="grid gap-6">
        {/* RSI */}
        {renderIndicatorCard(
          "rsi",
          "RSI (Relative Strength Index)",
          "Configure RSI indicator parameters",
          [
            { key: "period", label: "Period" },
            { key: "overbought", label: "Overbought" },
            { key: "oversold", label: "Oversold" },
          ]
        )}

        {/* MACD */}
        {renderIndicatorCard(
          "macd",
          "MACD (Moving Average Convergence Divergence)",
          "Configure MACD indicator parameters",
          [
            { key: "fastPeriod", label: "Fast Period" },
            { key: "slowPeriod", label: "Slow Period" },
            { key: "signalPeriod", label: "Signal Period" },
          ]
        )}

        {/* Bollinger Bands */}
        {renderIndicatorCard(
          "bollinger",
          "Bollinger Bands",
          "Configure Bollinger Bands parameters",
          [
            { key: "period", label: "Period" },
            { key: "stdDev", label: "Std Deviation" },
          ]
        )}

        {/* EMA */}
        {renderIndicatorCard(
          "ema",
          "EMA (Exponential Moving Average)",
          "Configure EMA parameters",
          [{ key: "period", label: "Period" }]
        )}

        {/* SMA */}
        {renderIndicatorCard(
          "sma",
          "SMA (Simple Moving Average)",
          "Configure SMA parameters",
          [{ key: "period", label: "Period" }]
        )}

        {/* Stochastic */}
        {renderIndicatorCard(
          "stochastic",
          "Stochastic Oscillator",
          "Configure Stochastic parameters",
          [
            { key: "kPeriod", label: "K Period" },
            { key: "dPeriod", label: "D Period" },
            { key: "overbought", label: "Overbought" },
            { key: "oversold", label: "Oversold" },
          ]
        )}

        {/* ATR */}
        {renderIndicatorCard(
          "atr",
          "ATR (Average True Range)",
          "Configure ATR parameters",
          [
            { key: "period", label: "Period" },
            { key: "multiplier", label: "Multiplier" },
          ]
        )}

        {/* Parabolic SAR */}
        {renderIndicatorCard(
          "parabolicSAR",
          "Parabolic SAR (Stop and Reverse)",
          "Configure Parabolic SAR parameters",
          [
            { key: "acceleration", label: "Acceleration" },
            { key: "maximum", label: "Maximum" },
          ]
        )}

        {/* ADX */}
        {renderIndicatorCard(
          "adx",
          "ADX (Average Directional Index)",
          "Configure ADX parameters for trend strength",
          [
            { key: "period", label: "Period" },
            { key: "threshold", label: "Threshold" },
          ]
        )}
      </div>
    </div>
  )
}
