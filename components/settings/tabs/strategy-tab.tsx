"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import AutoIndicationSettings from "@/components/settings/auto-indication-settings"
import MultiTrailingSettings from "@/components/settings/strategy/multi-trailing-settings"
import { useState } from "react"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"
import { parseStoredBoolean } from "@/lib/trailing-settings"

interface StrategyTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}

function PresetOptimizerSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix = "",
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  suffix?: string
}) {
  const digits = step < 1 ? (step < 0.1 ? 2 : 1) : 0
  return (
    <div className="space-y-2">
      <div className="flex justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value.toFixed(digits)}{suffix}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next)} />
    </div>
  )
}

export function StrategyTab({ settings, handleSettingChange }: StrategyTabProps) {
  const [strategySubTab, setStrategySubTab] = useState("main")
  const [strategyMainSubTab, setStrategyMainSubTab] = useState("base")
  const blockAdjustmentEnabled = parseStoredBoolean(settings.blockAdjustment, true)
  const dcaAdjustmentEnabled = parseStoredBoolean(settings.dcaAdjustment, false)
  const dcaVolumes: number[] = Array.isArray(settings.dcaStepVolumeMultipliers)
    ? settings.dcaStepVolumeMultipliers
    : DEFAULT_DCA_PROFILE.stepVolumeMultipliers
  const dcaDistances: number[] = Array.isArray(settings.dcaStepDistancesPct)
    ? settings.dcaStepDistancesPct
    : DEFAULT_DCA_PROFILE.stepDistancesPct
  const dcaMaxSteps = Math.max(1, Math.min(4, Number(settings.dcaMaxSteps) || DEFAULT_DCA_PROFILE.maxSteps))
  const presetIndicatorTypes: string[] = Array.isArray(settings.presetIndicatorTypes)
    ? settings.presetIndicatorTypes
    : ["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"]
  const updateDcaStep = (key: "dcaStepVolumeMultipliers" | "dcaStepDistancesPct", index: number, value: number) => {
    const fallback = key === "dcaStepVolumeMultipliers"
      ? DEFAULT_DCA_PROFILE.stepVolumeMultipliers
      : DEFAULT_DCA_PROFILE.stepDistancesPct
    const current = Array.isArray(settings[key]) ? [...settings[key]] : [...fallback]
    while (current.length < 4) current.push(fallback[current.length])
    current[index] = value
    handleSettingChange(key, current)
  }
  const updatePresetBlockSetting = (presetKey: string, runtimeKey: string, value: number | boolean) => {
    handleSettingChange(presetKey, value)
    handleSettingChange(runtimeKey, value)
  }
  const presetBlockEnabled = settings.presetBlockEnabled !== false
  const presetBlockVolumeRatio = Number(settings.presetBlockVolumeRatio ?? settings.blockVolumeRatio ?? 1)
  const presetBlockProfitFactorRatio = Number(settings.presetBlockProfitFactorRatio ?? settings.blockProfitFactorRatio ?? 0.8)
  const presetBlockMaxStack = Number(settings.presetBlockMaxStack ?? settings.blockMaxStack ?? 10)
  const presetBlockPauseCountRatio = Number(settings.presetBlockPauseCountRatio ?? settings.blockPauseCountRatio ?? 1)
  const presetBlockActiveRealEnabled = settings.presetBlockActiveRealEnabled ?? settings.blockActiveRealEnabled ?? true
  const presetBlockActiveLiveEnabled = settings.presetBlockActiveLiveEnabled ?? settings.blockActiveLiveEnabled ?? true

  return (
    <TabsContent value="strategy" className="space-y-4">
      <Tabs value={strategySubTab} onValueChange={setStrategySubTab}>
        <TabsList>
          <TabsTrigger value="main">Main</TabsTrigger>
          <TabsTrigger value="preset">Preset</TabsTrigger>
          <TabsTrigger value="auto">Auto</TabsTrigger>
        </TabsList>

        <TabsContent value="main" className="space-y-4">
          <Tabs value={strategyMainSubTab} onValueChange={setStrategyMainSubTab}>
            <TabsList>
              <TabsTrigger value="base">Base</TabsTrigger>
              <TabsTrigger value="trailing">Trailing</TabsTrigger>
              <TabsTrigger value="adjustment">Adjustment</TabsTrigger>
            </TabsList>

            <TabsContent value="base" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Base Strategy Configuration</CardTitle>
                  <CardDescription>Configure base strategy parameters</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/*
                   * ── Main Trade Profit Factor Thresholds ────────────────
                   *
                   * Spec: "Change at Main Trade PF for Base, Main, Real,
                   * Live to 0.9 1.0 1.0 1.0 System Overall. Add to
                   * Settings Dialog at Strategies with Sliders. Ensure
                   * it works systemwide completely."
                   *
                   * Each slider tunes the minimum profit-factor gate for
                   * one stage of the Main-Trade pipeline (Base → Main →
                   * Real → Live). Values flow into the engine via
                   * `lib/strategy-coordinator.ts:loadAppPFThresholds()`,
                   * which mirrors them into:
                   *   - `PF_BASE_MIN`  — per-indication entry filter
                   *   - `METRICS.{base,main,real,live}.minProfitFactor`
                   *     — Set-average promotion gates
                   *
                   * Cache TTL is 5s so a slider change reflects in live
                   * gating within at most 5 seconds, no engine restart
                   * required. Range 0.0–2.0 with 0.1 step matches the
                   * existing Preset PF slider for UX consistency.
                   * Defaults match the spec exactly: 0.9 / 1.0 / 1.0 / 1.0.
                   */}
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Main Trade Profit Factor Thresholds</h3>
                    <p className="text-xs text-muted-foreground">
                      Minimum profit factor required to promote Sets between
                      Main-Trade stages. Defaults: Base 0.9, Main 1.0,
                      Real 1.0, Live 1.0.
                    </p>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Base PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.baseProfitFactor ?? 0.9]}
                          onValueChange={([value]) => handleSettingChange("baseProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.baseProfitFactor ?? 0.9).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Per-indication entry filter for Base Sets.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Main PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.mainProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("mainProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.mainProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Base Sets into Main.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Real PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.realProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("realProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.realProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Main Sets into Real.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Live PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.liveProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("liveProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.liveProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Real Sets into Live.
                      </p>
                    </div>
                  </div>

                  <Separator />

                  {/*
                   * ── Per-stage Max Drawdown-Time thresholds (DDT gate) ──
                   *
                   * A position's hold time is up to ~2h, so the DDT gate
                   * ceiling defaults to 4h per stage. Each slider sets the
                   * maximum acceptable average drawdown-time (in hours) for
                   * Sets promoted INTO that stage. Base stays open by design.
                   * Values flow into the engine via
                   * `lib/strategy-coordinator.ts:loadAppPFThresholds()`,
                   * which converts hours→minutes and writes
                   * `METRICS.{main,real,live}.maxDrawdownTime` (5s TTL).
                   */}
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Max Drawdown-Time Thresholds</h3>
                    <p className="text-xs text-muted-foreground">
                      Maximum average position hold-time for Sets promoted into
                      each stage. Positions hold up to ~2h, so defaults are 4h.
                      Base is unrestricted; the gate rejects at Main, Real, and Live.
                    </p>
                  </div>
                  <div className="grid md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Main DDT Ceiling (hours)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={1}
                          max={72}
                          step={1}
                          value={[settings.maxDrawdownTimeMainHours ?? 4]}
                          onValueChange={([value]) => handleSettingChange("maxDrawdownTimeMainHours", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-16 text-right">
                          {settings.maxDrawdownTimeMainHours ?? 4}h
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Max avg DDT to promote Base Sets into Main.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Real DDT Ceiling (hours)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={1}
                          max={72}
                          step={1}
                          value={[settings.maxDrawdownTimeRealHours ?? 4]}
                          onValueChange={([value]) => handleSettingChange("maxDrawdownTimeRealHours", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-16 text-right">
                          {settings.maxDrawdownTimeRealHours ?? 4}h
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Max avg DDT to promote Main Sets into Real.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Live DDT Ceiling (hours)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={1}
                          max={72}
                          step={1}
                          value={[settings.maxDrawdownTimeLiveHours ?? 4]}
                          onValueChange={([value]) => handleSettingChange("maxDrawdownTimeLiveHours", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-16 text-right">
                          {settings.maxDrawdownTimeLiveHours ?? 4}h
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Max avg DDT to promote Real Sets into Live.
                      </p>
                    </div>
                  </div>

                  <Separator />

                  {/*
                   * ── Minimal Step (pseudo-position window floor) ────────
                   * Filters indication config stepsOptions so only window
                   * sizes >= minStep are generated. Raise to eliminate fast
                   * noisy short-window configs; lower to test all windows.
                   */}
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Minimal Step</h3>
                    <p className="text-xs text-muted-foreground">
                      Minimum pseudo-position step-window size (Steps 2–30).
                      Only windows ≥ this value are generated. Higher values
                      filter out fast noisy configs and can reduce losing orders.
                      Default: 5.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Min Step Window</Label>
                    <div className="flex items-center gap-4">
                      <Slider
                        min={2}
                        max={30}
                        step={1}
                        value={[settings.minStep ?? 5]}
                        onValueChange={([value]) => handleSettingChange("minStep", value)}
                        className="flex-1"
                      />
                      <span className="text-sm font-medium w-10 text-right">
                        {settings.minStep ?? 5}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Steps generated: {[2, 3, 5, 10, 15, 20, 25, 30].filter(s => s >= (settings.minStep ?? 5)).join(", ")}
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Trading Range Configuration</h3>
                    <p className="text-xs text-muted-foreground">
                      Define ranges for base value and ratios to control position sizing and risk.
                    </p>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Base Value Range (Min/Max)</Label>
                        <div className="flex items-center gap-4">
                          <Slider
                            min={0.1}
                            max={5.0}
                            step={0.1}
                            value={[settings.baseValueRangeMin || 0.5, settings.baseValueRangeMax || 2.5]}
                            onValueChange={([min, max]) => {
                              handleSettingChange("baseValueRangeMin", min)
                              handleSettingChange("baseValueRangeMax", max)
                            }}
                            className="flex-1"
                          />
                          <span className="text-sm font-medium w-24 text-right">
                            {settings.baseValueRangeMin?.toFixed(1)} - {settings.baseValueRangeMax?.toFixed(1)}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Base Ratio Range (Min/Max)</Label>
                        <div className="flex items-center gap-4">
                          <Slider
                            min={0.1}
                            max={1.0}
                            step={0.1}
                            value={[settings.baseRatioMin || 0.2, settings.baseRatioMax || 1.0]}
                            onValueChange={([min, max]) => {
                              handleSettingChange("baseRatioMin", min)
                              handleSettingChange("baseRatioMax", max)
                            }}
                            className="flex-1"
                          />
                          <span className="text-sm font-medium w-20 text-right">
                            {settings.baseRatioMin?.toFixed(1)} - {settings.baseRatioMax?.toFixed(1)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="trailing" className="space-y-4">
              {/*
               * Multi-step trailing matrix per spec — Settings →
               * Strategy → Main → Trailing. Each enabled (start, stop)
               * combo spawns one independent Base Set per
               * (indication_type × direction); engine consumes them
               * via `getEnabledTrailingVariants()` in
               * `lib/strategy-coordinator.ts`.
               */}
              <MultiTrailingSettings
                settings={settings}
                handleSettingChange={handleSettingChange}
              />
            </TabsContent>

            <TabsContent value="adjustment" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Adjustment Strategies</CardTitle>
                  <CardDescription>Configure block and DCA adjustments</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-6 md:grid-cols-2">
                    <div className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <Label>Block Adjustment</Label>
                        <p className="text-xs text-muted-foreground">
                          Adjusts positions based on predefined blocks or segments
                        </p>
                      </div>
                      <Switch
                        checked={blockAdjustmentEnabled}
                        onCheckedChange={(checked) => handleSettingChange("blockAdjustment", checked)}
                      />
                    </div>

                    <div className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <Label>DCA (Dollar Cost Averaging)</Label>
                        <p className="text-xs text-muted-foreground">
                          Automatically adds to positions at lower prices
                        </p>
                      </div>
                      <Switch
                        checked={dcaAdjustmentEnabled}
                        onCheckedChange={(checked) => handleSettingChange("dcaAdjustment", checked)}
                      />
                    </div>
                  </div>

                  <div className={dcaAdjustmentEnabled ? "mt-6 space-y-5 border-t pt-5" : "mt-6 space-y-5 border-t pt-5 opacity-50 pointer-events-none"}>
                    <div>
                      <h3 className="font-semibold">DCA progression profile</h3>
                      <p className="text-xs text-muted-foreground">
                        Each step is triggered by an adverse move from the immutable first fill and sized from that first quantity—not from the accumulated total.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Maximum steps</Label>
                        <span className="text-sm font-semibold tabular-nums">{dcaMaxSteps}</span>
                      </div>
                      <Slider
                        min={1}
                        max={4}
                        step={1}
                        value={[dcaMaxSteps]}
                        onValueChange={([value]) => handleSettingChange("dcaMaxSteps", value)}
                      />
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      {Array.from({ length: dcaMaxSteps }, (_, index) => (
                        <div key={index} className="space-y-3 rounded-lg border bg-muted/20 p-3">
                          <div className="text-xs font-semibold">Step {index + 1}</div>
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-xs"><span>Initial-volume multiple</span><span>{Number(dcaVolumes[index] ?? DEFAULT_DCA_PROFILE.stepVolumeMultipliers[index]).toFixed(2)}×</span></div>
                            <Slider
                              min={0.1}
                              max={2.5}
                              step={0.1}
                              value={[Number(dcaVolumes[index] ?? DEFAULT_DCA_PROFILE.stepVolumeMultipliers[index])]}
                              onValueChange={([value]) => updateDcaStep("dcaStepVolumeMultipliers", index, Number(value.toFixed(2)))}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-xs"><span>Adverse distance</span><span>{Number(dcaDistances[index] ?? DEFAULT_DCA_PROFILE.stepDistancesPct[index]).toFixed(2)}%</span></div>
                            <Slider
                              min={0.1}
                              max={20}
                              step={0.1}
                              value={[Number(dcaDistances[index] ?? DEFAULT_DCA_PROFILE.stepDistancesPct[index])]}
                              onValueChange={([value]) => updateDcaStep("dcaStepDistancesPct", index, Number(value.toFixed(2)))}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Take-profit reference</Label>
                        <Select
                          value={settings.dcaTakeProfitMode || DEFAULT_DCA_PROFILE.takeProfitMode}
                          onValueChange={(value) => handleSettingChange("dcaTakeProfitMode", value)}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="average">Average entry</SelectItem>
                            <SelectItem value="first_entry">First entry</SelectItem>
                            <SelectItem value="breakeven_plus">Breakeven plus</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between"><Label>Step cooldown</Label><span className="text-xs">{Number(settings.dcaCooldownSeconds ?? DEFAULT_DCA_PROFILE.cooldownSeconds)}s</span></div>
                        <Slider
                          min={0}
                          max={3600}
                          step={5}
                          value={[Number(settings.dcaCooldownSeconds ?? DEFAULT_DCA_PROFILE.cooldownSeconds)]}
                          onValueChange={([value]) => handleSettingChange("dcaCooldownSeconds", value)}
                        />
                      </div>
                    </div>

                    {(settings.dcaTakeProfitMode || DEFAULT_DCA_PROFILE.takeProfitMode) === "breakeven_plus" && (
                      <div className="space-y-2">
                        <div className="flex justify-between"><Label>Breakeven profit</Label><span className="text-xs">{Number(settings.dcaBreakevenProfitPct ?? DEFAULT_DCA_PROFILE.breakevenProfitPct).toFixed(2)}%</span></div>
                        <Slider
                          min={0.05}
                          max={5}
                          step={0.05}
                          value={[Number(settings.dcaBreakevenProfitPct ?? DEFAULT_DCA_PROFILE.breakevenProfitPct)]}
                          onValueChange={([value]) => handleSettingChange("dcaBreakevenProfitPct", Number(value.toFixed(2)))}
                        />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="preset" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Preset Strategy Configuration</CardTitle>
              <CardDescription>Configure preset strategy parameters</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Minimum Profit Factor</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      min={0.4}
                      max={3.0}
                      step={0.1}
                      value={[settings.profitFactorMinPreset ?? 0.7]}
                      onValueChange={([value]) => handleSettingChange("profitFactorMinPreset", value)}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium w-10 text-right">
                      {(settings.profitFactorMinPreset ?? 0.7).toFixed(1)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Maximum Drawdown Time (hours)</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      min={1}
                      max={24}
                      step={0.5}
                      value={[settings.drawdownTimePreset ?? 5]}
                      onValueChange={([value]) => handleSettingChange("drawdownTimePreset", value)}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium w-16 text-right">
                      {settings.drawdownTimePreset ?? 5}h
                    </span>
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Historical Optimizer Coverage</h3>
                  <p className="text-xs text-muted-foreground">
                    The same persisted settings used by the Presets page and live Preset execution. TP and SL are ratios of exchange position cost.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <PresetOptimizerSlider label="History" value={Number(settings.presetHistoryDays ?? 14)} min={1} max={14} step={1} suffix="d" onChange={(value) => handleSettingChange("presetHistoryDays", value)} />
                  <PresetOptimizerSlider label="Presets / symbol / type" value={Number(settings.presetCountPerSymbol ?? 4)} min={1} max={12} step={1} onChange={(value) => handleSettingChange("presetCountPerSymbol", value)} />
                  <PresetOptimizerSlider label="Indicator variants / type" value={Number(settings.presetMaxIndicatorVariants ?? 4)} min={1} max={12} step={1} onChange={(value) => handleSettingChange("presetMaxIndicatorVariants", value)} />
                  <PresetOptimizerSlider label="Signals / variant" value={Number(settings.presetMaxSignalsPerVariant ?? 48)} min={8} max={128} step={1} onChange={(value) => handleSettingChange("presetMaxSignalsPerVariant", value)} />
                  <PresetOptimizerSlider label="Maximum candles / symbol" value={Number(settings.presetMaxCandlesPerRun ?? 6000)} min={500} max={20000} step={500} onChange={(value) => handleSettingChange("presetMaxCandlesPerRun", value)} />
                  <PresetOptimizerSlider label="Trailing step factor" value={Number(settings.presetTrailStepRatio ?? 0.5)} min={0.1} max={1} step={0.1} onChange={(value) => handleSettingChange("presetTrailStepRatio", value)} />
                </div>

                <div className="grid gap-4 lg:grid-cols-4">
                  <div className="space-y-3 rounded-lg border p-3">
                    <Label>Take Profit / position cost</Label>
                    <PresetOptimizerSlider label="Minimum" value={Number(settings.presetTpMin ?? 3)} min={3} max={30} step={1} onChange={(value) => handleSettingChange("presetTpMin", value)} />
                    <PresetOptimizerSlider label="Maximum" value={Number(settings.presetTpMax ?? 30)} min={3} max={30} step={1} onChange={(value) => handleSettingChange("presetTpMax", value)} />
                    <PresetOptimizerSlider label="Step" value={Number(settings.presetTpStep ?? 1)} min={1} max={27} step={1} onChange={(value) => handleSettingChange("presetTpStep", value)} />
                  </div>
                  <div className="space-y-3 rounded-lg border p-3">
                    <Label>Stop Loss / Take Profit</Label>
                    <PresetOptimizerSlider label="Minimum" value={Number(settings.presetSlMin ?? 0.25)} min={0.25} max={2} step={0.25} onChange={(value) => handleSettingChange("presetSlMin", value)} />
                    <PresetOptimizerSlider label="Maximum" value={Number(settings.presetSlMax ?? 2)} min={0.25} max={2} step={0.25} onChange={(value) => handleSettingChange("presetSlMax", value)} />
                    <PresetOptimizerSlider label="Step" value={Number(settings.presetSlStep ?? 0.25)} min={0.25} max={1.75} step={0.25} onChange={(value) => handleSettingChange("presetSlStep", value)} />
                  </div>
                  <div className="space-y-3 rounded-lg border p-3">
                    <Label>Trailing activation ratio</Label>
                    <PresetOptimizerSlider label="Minimum" value={Number(settings.presetTrailStartMin ?? 0.5)} min={0.5} max={1.5} step={0.1} onChange={(value) => handleSettingChange("presetTrailStartMin", value)} />
                    <PresetOptimizerSlider label="Maximum" value={Number(settings.presetTrailStartMax ?? 1.5)} min={0.5} max={1.5} step={0.1} onChange={(value) => handleSettingChange("presetTrailStartMax", value)} />
                    <PresetOptimizerSlider label="Step" value={Number(settings.presetTrailStartStep ?? 0.1)} min={0.1} max={1} step={0.1} onChange={(value) => handleSettingChange("presetTrailStartStep", value)} />
                  </div>
                  <div className="space-y-3 rounded-lg border p-3">
                    <Label>Trailing stop ratio</Label>
                    <PresetOptimizerSlider label="Minimum" value={Number(settings.presetTrailStopMin ?? 0.2)} min={0.2} max={0.4} step={0.1} onChange={(value) => handleSettingChange("presetTrailStopMin", value)} />
                    <PresetOptimizerSlider label="Maximum" value={Number(settings.presetTrailStopMax ?? 0.4)} min={0.2} max={0.4} step={0.1} onChange={(value) => handleSettingChange("presetTrailStopMax", value)} />
                    <PresetOptimizerSlider label="Step" value={Number(settings.presetTrailStopStep ?? 0.1)} min={0.1} max={0.2} step={0.1} onChange={(value) => handleSettingChange("presetTrailStopStep", value)} />
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <Label>Auto-generate missing results</Label>
                    <Switch checked={settings.presetAutoGenerate !== false} onCheckedChange={(checked) => handleSettingChange("presetAutoGenerate", checked)} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <Label>Auto-select best / symbol / type</Label>
                    <Switch checked={settings.presetAutoSelect !== false} onCheckedChange={(checked) => handleSettingChange("presetAutoSelect", checked)} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <Label>Trailing independent from TP</Label>
                    <Switch checked={settings.presetTrailingIndependent !== false} onCheckedChange={(checked) => handleSettingChange("presetTrailingIndependent", checked)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Common indication types</Label>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"].map((type) => {
                      const checked = presetIndicatorTypes.includes(type)
                      return (
                        <div key={type} className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <Label className="text-xs uppercase">{type}</Label>
                          <Switch
                            checked={checked}
                            onCheckedChange={(enabled) => handleSettingChange(
                              "presetIndicatorTypes",
                              enabled
                                ? [...new Set([...presetIndicatorTypes, type])]
                                : presetIndicatorTypes.filter((item) => item !== type),
                            )}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Strategy Type Enabling</h3>
                <p className="text-xs text-muted-foreground">
                  Enable or disable specific strategy types for preset trading.
                </p>
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>Trailing Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable trailing stop strategy</p>
                    </div>
                    <Switch
                      checked={settings.presetTrailingEnabled === true}
                      onCheckedChange={(checked) => handleSettingChange("presetTrailingEnabled", checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>Block Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable block trading strategy</p>
                    </div>
                    <Switch
                      checked={presetBlockEnabled}
                      onCheckedChange={(checked) => {
                        updatePresetBlockSetting("presetBlockEnabled", "variantBlockEnabled", checked)
                        handleSettingChange("presetBlockStrategy", checked)
                        handleSettingChange("blockAdjustment", checked)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>DCA Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable Dollar Cost Averaging strategy</p>
                    </div>
                    <Switch
                      checked={settings.presetDcaEnabled === true}
                      onCheckedChange={(checked) => handleSettingChange("presetDcaEnabled", checked)}
                    />
                  </div>
                </div>

                <div className={`space-y-4 rounded-lg border p-4 ${presetBlockEnabled ? "" : "opacity-60"}`}>
                  <div>
                    <h4 className="font-semibold">Block Strategy Type · Adjust</h4>
                    <p className="text-xs text-muted-foreground">
                      Every valid Block count is coordinated independently. Exchange add quantity = current position base × (active Block count × volume ratio); its volume state remains attached until that position closes profitably, followed by its own count pause.
                    </p>
                  </div>
                  <div className={presetBlockEnabled ? "grid gap-4 md:grid-cols-2 xl:grid-cols-4" : "grid gap-4 md:grid-cols-2 xl:grid-cols-4 pointer-events-none"}>
                    <PresetOptimizerSlider
                      label="Volume ratio"
                      value={presetBlockVolumeRatio}
                      min={0.25}
                      max={3}
                      step={0.05}
                      onChange={(value) => updatePresetBlockSetting("presetBlockVolumeRatio", "blockVolumeRatio", value)}
                    />
                    <PresetOptimizerSlider
                      label="ProfitFactor factor"
                      value={presetBlockProfitFactorRatio}
                      min={0.2}
                      max={5}
                      step={0.1}
                      onChange={(value) => updatePresetBlockSetting("presetBlockProfitFactorRatio", "blockProfitFactorRatio", value)}
                    />
                    <PresetOptimizerSlider
                      label="Independent Block counts"
                      value={presetBlockMaxStack}
                      min={1}
                      max={10}
                      step={1}
                      onChange={(value) => updatePresetBlockSetting("presetBlockMaxStack", "blockMaxStack", value)}
                    />
                    <PresetOptimizerSlider
                      label="Post-profit pause ratio"
                      value={presetBlockPauseCountRatio}
                      min={1}
                      max={4}
                      step={0.5}
                      onChange={(value) => updatePresetBlockSetting("presetBlockPauseCountRatio", "blockPauseCountRatio", value)}
                    />
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <Label>Active Real-position Block</Label>
                        <p className="text-xs text-muted-foreground">Coordinate currently running Real exposure.</p>
                      </div>
                      <Switch
                        checked={Boolean(presetBlockActiveRealEnabled)}
                        disabled={!presetBlockEnabled}
                        onCheckedChange={(checked) => updatePresetBlockSetting("presetBlockActiveRealEnabled", "blockActiveRealEnabled", checked)}
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <Label>Active Live-position Block</Label>
                        <p className="text-xs text-muted-foreground">Coordinate existing exchange exposure independently.</p>
                      </div>
                      <Switch
                        checked={Boolean(presetBlockActiveLiveEnabled)}
                        disabled={!presetBlockEnabled}
                        onCheckedChange={(checked) => updatePresetBlockSetting("presetBlockActiveLiveEnabled", "blockActiveLiveEnabled", checked)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    {[1, 2, Math.max(3, Math.min(10, Math.floor(presetBlockMaxStack)))].map((count, index) => (
                      <div key={`${count}-${index}`} className="rounded border bg-muted/20 p-2 text-center tabular-nums">
                        Block {count}: +{(count * presetBlockVolumeRatio).toFixed(2)}× base
                      </div>
                    ))}
                  </div>
                </div>
              </div>
                </CardContent>
              </Card>

              {/* ── Stage Evaluation Position-Count Thresholds ─────────────── */}
              {/*
               * Per-stage minimum pseudo-position counts. Sets that haven't
               * accumulated enough completed entries are SKIPPED at the
               * evaluation gate (not promoted, not counted as failed), so
               * fresh / warming-up sets re-enter on subsequent cycles once
               * enough positions have closed.
               *
               * Stored as 0 in default settings → StrategyCoordinator
               // applies the hardcoded defaults:
               //   stageMinPosCountBase=0  →  default  15 (Base→Main)
               //   stageMinPosCountMain=0  →  default  15 (Main→Real)
               //   stageMinPosCountReal=0  →  default  10 (Real→Live)
               //
               // Write path: page.tsx Settings → connection_settings hash
               // → StrategyCoordinator.loadAppPFThresholds() reads and snaps
               // to the 5-step grid (5, 10, 15, 20, … 50).
               */}
              <Card>
                <CardHeader>
                  <CardTitle>Stage Evaluation Thresholds</CardTitle>
                  <CardDescription>
                    Minimum completed pseudo-positions before each stage validates PF + drawdown.
                    Sets below the threshold are skipped (warming-up, not failed).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-3 gap-4">
                    {/* Base — not currently applied to base-stage, coord slot reserved */}
                    <div className="space-y-2">
                      <Label>Base → Main (min positions)</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={0}
                          max={50}
                          step={5}
                          value={[settings.stageMinPosCountBase ?? 0]}
                          onValueChange={([v]) => handleSettingChange("stageMinPosCountBase", v)}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-10 text-right">
                          {(settings.stageMinPosCountBase ?? 0) === 0 ? "Default" : settings.stageMinPosCountBase}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        0 = coordinator default (15)
                      </p>
                    </div>

                    {/* Main → Real */}
                    <div className="space-y-2">
                      <Label>Main → Real (min positions)</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={0}
                          max={50}
                          step={5}
                          value={[settings.stageMinPosCountMain ?? 0]}
                          onValueChange={([v]) => handleSettingChange("stageMinPosCountMain", v)}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-10 text-right">
                          {(settings.stageMinPosCountMain ?? 0) === 0 ? "Default" : settings.stageMinPosCountMain}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        0 = coordinator default (15)
                      </p>
                    </div>

                    {/* Real → Live */}
                    <div className="space-y-2">
                      <Label>Real → Live (min positions)</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={0}
                          max={50}
                          step={5}
                          value={[settings.stageMinPosCountReal ?? 0]}
                          onValueChange={([v]) => handleSettingChange("stageMinPosCountReal", v)}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-10 text-right">
                          {(settings.stageMinPosCountReal ?? 0) === 0 ? "Default" : settings.stageMinPosCountReal}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                          0 = coordinator default (10)
                        </p>
                      </div>

                    {/* Position-Count (Pis) Sets Volume Ratio */}
                    <div className="space-y-2 md:col-span-3">
                      <Label>Position-Count (Pis) Sets Volume Ratio</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={0.01}
                          max={0.25}
                          step={0.01}
                          value={[Number(settings.posCountsVolumeRatio ?? 0.05)]}
                          onValueChange={([v]) => handleSettingChange("posCountsVolumeRatio", Number(v.toFixed(2)))}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-14 text-right">
                          {(Number(settings.posCountsVolumeRatio ?? 0.05)).toFixed(2)}×
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Volume ratio for Main-stage additional pos-count Sets only (0.01–0.25).
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

        <TabsContent value="auto">
          <AutoIndicationSettings />
        </TabsContent>
      </Tabs>
    </TabsContent>
  )
}
