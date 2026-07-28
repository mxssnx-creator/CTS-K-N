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
import { PRESET_INDICATOR_TYPES } from "@/lib/preset-optimizer"
import { parseStoredBoolean } from "@/lib/trailing-settings"
import {
  MAIN_TRADE_BASE_PF_RATIO_MIN,
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  MAIN_TRADE_PF_RATIO_MAX,
  MAIN_TRADE_PF_RATIO_MIN,
  MAIN_TRADE_PF_RATIO_STEP,
} from "@/lib/main-trade-profit-factor"
import {
  POS_COUNT_VOLUME_RATIO_DEFAULT,
  POS_COUNT_VOLUME_RATIO_MAX,
  POS_COUNT_VOLUME_RATIO_MIN,
  POS_COUNT_VOLUME_RATIO_STEP,
  posCountVolumeRatioToSetMultiplier,
} from "@/lib/pos-count-volume-ratio"

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
    : [...PRESET_INDICATOR_TYPES]
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
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Main Trade PositionCost Ratios</h3>
                    <p className="text-xs text-muted-foreground">
                      Minimum cost-relative result required at each stage.
                      Ratio 0.10 equals one PositionCost. This is separate
                      from realised Profit Factor (gross profit ÷ gross loss).
                    </p>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Base PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={MAIN_TRADE_BASE_PF_RATIO_MIN}
                          max={MAIN_TRADE_PF_RATIO_MAX}
                          step={MAIN_TRADE_PF_RATIO_STEP}
                          value={[settings.baseProfitFactor ?? MAIN_TRADE_BASE_PF_RATIO_DEFAULT]}
                          onValueChange={([value]) => handleSettingChange("baseProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.baseProfitFactor ?? MAIN_TRADE_BASE_PF_RATIO_DEFAULT).toFixed(2)}
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
                          min={MAIN_TRADE_PF_RATIO_MIN}
                          max={MAIN_TRADE_PF_RATIO_MAX}
                          step={MAIN_TRADE_PF_RATIO_STEP}
                          value={[settings.mainProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT]}
                          onValueChange={([value]) => handleSettingChange("mainProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.mainProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT).toFixed(2)}
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
                          min={MAIN_TRADE_PF_RATIO_MIN}
                          max={MAIN_TRADE_PF_RATIO_MAX}
                          step={MAIN_TRADE_PF_RATIO_STEP}
                          value={[settings.realProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT]}
                          onValueChange={([value]) => handleSettingChange("realProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.realProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT).toFixed(2)}
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
                          min={MAIN_TRADE_PF_RATIO_MIN}
                          max={MAIN_TRADE_PF_RATIO_MAX}
                          step={MAIN_TRADE_PF_RATIO_STEP}
                          value={[settings.liveProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT]}
                          onValueChange={([value]) => handleSettingChange("liveProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.liveProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT).toFixed(2)}
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

                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Base Step Coverage</h3>
                    <p className="text-xs text-muted-foreground">
                      Exhaustive pseudo-position windows. Every integer step
                      from 2 through 30 is generated independently.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>First Step Window (fixed)</Label>
                    <div className="flex items-center gap-4">
                      <Slider
                        min={2}
                        max={2}
                        step={1}
                        value={[2]}
                        disabled
                        className="flex-1"
                      />
                      <span className="text-sm font-medium w-10 text-right">
                        2
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Steps generated: 2, 3, 4, …, 29, 30 (29 independent windows)
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
                    {PRESET_INDICATOR_TYPES.map((type) => {
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
                      Every valid Block count is evaluated independently. Its physical target is general volume + ((general volume × ratio) × active Block count); exchange orders submit only the missing delta, while result and pause state remain count-specific.
                      Regular ladders use Base-derived Sets only; Active Real
                      counts independently include Pos-Count positions.
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
                        Block {count}: {(1 + count * presetBlockVolumeRatio).toFixed(2)}× total
                      </div>
                    ))}
                  </div>
                </div>
              </div>
                </CardContent>
              </Card>

              {/* ── Stage Evaluation Position-Count Thresholds ─────────────── */}
              <Card>
                <CardHeader>
                  <CardTitle>Continuous Row Evaluation</CardTitle>
                  <CardDescription>
                    Main evaluates each Base lineage over its latest completed
                    positions; Real evaluates promoted Main rows independently.
                    Live mirrors a validated Real row without a second hidden gate.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Main Row Lookback</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={8}
                          max={80}
                          step={1}
                          value={[settings.mainEvalPosCount ?? 25]}
                          onValueChange={([v]) => handleSettingChange("mainEvalPosCount", v)}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-10 text-right">
                          {settings.mainEvalPosCount ?? 25}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Default 25 closed positions per exact Set lineage.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Real Row Lookback</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={8}
                          max={80}
                          step={1}
                          value={[settings.realEvalPosCount ?? 20]}
                          onValueChange={([v]) => handleSettingChange("realEvalPosCount", v)}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-10 text-right">
                          {settings.realEvalPosCount ?? 20}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Default 20 positions; successful rows are mirrored to Live.
                      </p>
                    </div>

                    {/* Position-Count (Pis) Sets coordination ratio */}
                    <div className="space-y-2 md:col-span-3">
                      <Label>Position-Count (Pis) Coordination Ratio</Label>
                      <div className="flex items-center gap-3">
                        <Slider
                          min={POS_COUNT_VOLUME_RATIO_MIN}
                          max={POS_COUNT_VOLUME_RATIO_MAX}
                          step={POS_COUNT_VOLUME_RATIO_STEP}
                          value={[Number(settings.posCountsVolumeRatio ?? POS_COUNT_VOLUME_RATIO_DEFAULT)]}
                          onValueChange={([v]) => handleSettingChange("posCountsVolumeRatio", Number(v.toFixed(1)))}
                          className="flex-1"
                        />
                        <span className="text-sm font-semibold w-14 text-right">
                          {(Number(settings.posCountsVolumeRatio ?? POS_COUNT_VOLUME_RATIO_DEFAULT)).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {posCountVolumeRatioToSetMultiplier(
                          settings.posCountsVolumeRatio ?? POS_COUNT_VOLUME_RATIO_DEFAULT,
                        ).toFixed(4)}× Base volume per valid Set; ratio 10 = 0.02×.
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
