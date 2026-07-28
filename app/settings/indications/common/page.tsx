"use client"

export const dynamic = "force-dynamic"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Activity, BarChart3, RefreshCw, Save, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  normalizeCommonIndicationSettings,
  type CommonCoordinationSettings,
  type CommonIndicatorSettings,
  type CommonIndicationSettingsDocument,
  type CommonNumericRange,
} from "@/lib/common-indicator-config"
import { toast } from "@/lib/simple-toast"

function listText(values: number[]): string {
  return values.join(", ")
}

function parseList(value: string, fallback: number[]): number[] {
  const parsed = [...new Set(value.split(/[\s,|]+/).map(Number).filter(Number.isFinite))]
  return parsed.length > 0 ? parsed : fallback
}

export default function CommonIndicationsSettingsPage() {
  const [settings, setSettings] = useState<CommonIndicationSettingsDocument>(
    () => normalizeCommonIndicationSettings(DEFAULT_COMMON_INDICATION_SETTINGS),
  )
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const loadSettings = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/settings/indications/common?t=${Date.now()}`, {
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || "Settings request failed")
      setSettings(normalizeCommonIndicationSettings(data.settings))
      setDirty(false)
    } catch (error) {
      console.error("[common-indications] Failed to load settings:", error)
      toast.error("Failed to load common indicator settings")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const enabledCount = useMemo(
    () => COMMON_INDICATOR_DEFINITIONS.filter((definition) =>
      (settings[definition.storageKey] as CommonIndicatorSettings).enabled,
    ).length,
    [settings],
  )

  const updateIndicator = (
    storageKey: string,
    update: (current: CommonIndicatorSettings) => CommonIndicatorSettings,
  ) => {
    setSettings((current) => ({
      ...current,
      [storageKey]: update(current[storageKey] as CommonIndicatorSettings),
    }))
    setDirty(true)
  }

  const updateRange = (
    storageKey: string,
    parameter: string,
    field: keyof CommonNumericRange,
    rawValue: string,
  ) => {
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return
    updateIndicator(storageKey, (current) => ({
      ...current,
      [parameter]: {
        ...(current[parameter] as CommonNumericRange),
        [field]: value,
      },
    }))
  }

  const updateCoordination = <Key extends keyof CommonCoordinationSettings>(
    key: Key,
    value: CommonCoordinationSettings[Key],
  ) => {
    setSettings((current) => ({
      ...current,
      coordination: { ...current.coordination, [key]: value },
    }))
    setDirty(true)
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
      if (!response.ok || !data.success) throw new Error(data.error || "Settings save failed")
      setSettings(normalizeCommonIndicationSettings(data.settings))
      setDirty(false)
      toast.success("Common indicators and coordination settings saved")
    } catch (error) {
      console.error("[common-indications] Failed to save settings:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save settings")
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading common indicator contract…
      </div>
    )
  }

  const coordination = settings.coordination

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BarChart3 className="h-5 w-5 text-primary" />
            Common indicators
          </h1>
          <p className="text-xs text-muted-foreground">
            One durable contract for official technical indicators, presets and short-range coordination.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            {enabledCount}/{COMMON_INDICATOR_DEFINITIONS.length} enabled
          </span>
          <Button variant="outline" size="sm" asChild>
            <Link href="/statistics/indications/common">
              <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
              Statistics
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadSettings()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reload
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={isSaving || !dirty}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <Card className="border-primary/25">
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <SlidersHorizontal className="h-4 w-4" />
                Multi-range coordination
              </CardTitle>
              <CardDescription className="text-xs">
                Independent signals stay available; this layer adds activity, PositionCost steps and wider higher-range drawdown validation.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="common-coordination-enabled"
                checked={coordination.enabled}
                onCheckedChange={(checked) => updateCoordination("enabled", checked === true)}
              />
              <Label htmlFor="common-coordination-enabled" className="text-xs">Enabled</Label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Timeframes (minutes)</Label>
            <Input
              className="h-8 text-xs"
              value={listText(coordination.timeframesMinutes)}
              onChange={(event) => updateCoordination(
                "timeframesMinutes",
                parseList(event.target.value, coordination.timeframesMinutes),
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">PositionCost steps</Label>
            <Input
              className="h-8 text-xs"
              value={listText(coordination.rangeSteps)}
              onChange={(event) => updateCoordination(
                "rangeSteps",
                parseList(event.target.value, coordination.rangeSteps),
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Drawdown ratios</Label>
            <Input
              className="h-8 text-xs"
              value={listText(coordination.drawdownRatios)}
              onChange={(event) => updateCoordination(
                "drawdownRatios",
                parseList(event.target.value, coordination.drawdownRatios),
              )}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Higher-range DD scale</Label>
            <Input
              className="h-8 text-xs"
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={coordination.higherRangeDrawdownScale}
              onChange={(event) => updateCoordination("higherRangeDrawdownScale", Number(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minimum agreement</Label>
            <Input
              className="h-8 text-xs"
              type="number"
              min={0.5}
              max={1}
              step={0.05}
              value={coordination.minAgreement}
              onChange={(event) => updateCoordination("minAgreement", Number(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minimum signals</Label>
            <Input
              className="h-8 text-xs"
              type="number"
              min={1}
              max={COMMON_INDICATOR_DEFINITIONS.length}
              value={coordination.minimumSignals}
              onChange={(event) => updateCoordination("minimumSignals", Number(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Short difference / cost</Label>
            <Input
              className="h-8 text-xs"
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={coordination.shortDifferenceRatio}
              onChange={(event) => updateCoordination("shortDifferenceRatio", Number(event.target.value))}
            />
          </div>
          <div className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            Default: 1/5/15/30m · 2/2.5/3 steps · +0.5 drawdown scale · 3s validated cooldown per exact config/direction.
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        {COMMON_INDICATOR_DEFINITIONS.map((definition) => {
          const indicator = settings[definition.storageKey] as CommonIndicatorSettings
          return (
            <Card key={definition.storageKey} className={indicator.enabled ? "border-emerald-500/25" : "opacity-80"}>
              <CardHeader className="p-3 pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Activity className="h-3.5 w-3.5" />
                      {definition.label}
                    </CardTitle>
                    <CardDescription className="mt-1 text-[11px] leading-4">
                      {definition.description}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${definition.storageKey}-enabled`}
                      checked={indicator.enabled}
                      onCheckedChange={(checked) => updateIndicator(definition.storageKey, (current) => ({
                        ...current,
                        enabled: checked === true,
                      }))}
                    />
                    <Label htmlFor={`${definition.storageKey}-enabled`} className="text-xs">Enabled</Label>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                <div className="grid grid-cols-[minmax(100px,1fr)_repeat(3,minmax(64px,0.7fr))] gap-1 text-[10px] font-medium uppercase text-muted-foreground">
                  <span>Parameter</span><span>From</span><span>To</span><span>Step</span>
                </div>
                {Object.entries(definition.parameters).map(([parameter, parameterDefinition]) => {
                  const configured = indicator[parameter] as CommonNumericRange
                  return (
                    <div
                      key={parameter}
                      className="grid grid-cols-[minmax(100px,1fr)_repeat(3,minmax(64px,0.7fr))] items-center gap-1"
                    >
                      <Label className="truncate text-[11px]">{parameterDefinition.label}</Label>
                      {(["from", "to", "step"] as const).map((field) => (
                        <Input
                          key={field}
                          className="h-7 px-2 text-[11px]"
                          type="number"
                          min={parameterDefinition.min}
                          max={parameterDefinition.max}
                          step={parameterDefinition.minimumStep}
                          value={configured[field]}
                          onChange={(event) =>
                            updateRange(definition.storageKey, parameter, field, event.target.value)}
                        />
                      ))}
                    </div>
                  )
                })}
                <div className="grid grid-cols-2 gap-2 border-t pt-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">Check interval (s)</Label>
                    <Input
                      className="h-7 text-[11px]"
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={indicator.interval}
                      onChange={(event) => updateIndicator(definition.storageKey, (current) => ({
                        ...current,
                        interval: Number(event.target.value),
                      }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Validated timeout (s)</Label>
                    <Input
                      className="h-7 text-[11px]"
                      type="number"
                      min={0}
                      step={0.1}
                      value={indicator.timeout}
                      onChange={(event) => updateIndicator(definition.storageKey, (current) => ({
                        ...current,
                        timeout: Number(event.target.value),
                      }))}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
