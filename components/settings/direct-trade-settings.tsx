"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, Loader2, Save, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  clampDirectTradeVolumeFactor,
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
  DIRECT_TRADE_MAX_SYMBOLS,
  DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  DIRECT_TRADE_VOLUME_FACTOR_MAX,
  DIRECT_TRADE_VOLUME_FACTOR_MIN,
} from "@/lib/direct-trade-limits"
import {
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
} from "@/lib/direct-trade-coordination"
import {
  DEFAULT_DCA_PROFILE,
  MAX_DCA_POSITION_VOLUME_RATIO,
  MIN_DCA_POSITION_VOLUME_RATIO,
  type DcaProfile,
  type DcaTakeProfitMode,
} from "@/lib/dca-strategy"

type DirectTradeState = {
  enabled: boolean
  liveMode: boolean
  connectionId: string | null
  processingIntervalMs: number
  recalcIntervalMs: number
  symbolCount: number
  symbolOrder: "volatility_1h" | "volume" | "volatility"
  minVolFactor: number
  positionCostPercent: number
  maxSlRatio: number
  slRatioStep: number
  inverseMaxSlRatio: number
  timeframes: string[]
  strategyTypes: string[]
  historyHours: number
  entryTactics: string[]
  enabledIndicationTypes: string[]
  exitTactics: string[]
  entryTiming: "current" | "last_confirmed"
  activityVolumeRatio: number
  maxHoldMinutes: number
  takeProfitRatioRange: [number, number]
  takeProfitRatioStep: number
  trailingMinTakeProfitRatio: number
  blockRange: [number, number]
  blockVolumeRatio: number
  blockProfitFactorRatio: number
  maxTotalPositions: number
  maxPositionsPerSymbol: number
  maxPositionsPerDirection: number
  keepEnabledPosCount: number
  deactivatePosCount: number
  minProfitFactor: number
  minRecentProfitFactor: number
  recentEvaluationPositions: number
  maxDrawdownTimeMin: number
  prevPosWindow: number
  prevPosMinCount: number
  evalPosCount: number
  trailingEnabled: boolean
  dcaProfile: DcaProfile
}

const DEFAULT_STATE: DirectTradeState = {
  enabled: false,
  liveMode: false,
  connectionId: null,
  processingIntervalMs: 280,
  recalcIntervalMs: 2 * 60 * 60 * 1000,
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  positionCostPercent: 0.1,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["5m", "15m", "30m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  historyHours: 48,
  entryTactics: ["relative"],
  enabledIndicationTypes: ["relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  trailingMinTakeProfitRatio: DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  blockRange: [1, 12],
  blockVolumeRatio: 1,
  blockProfitFactorRatio: 0.8,
  maxTotalPositions: DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  keepEnabledPosCount: 12,
  deactivatePosCount: 16,
  minProfitFactor: DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  minRecentProfitFactor: DIRECT_TRADE_RECENT_PF_DEFAULT,
  recentEvaluationPositions: 12,
  maxDrawdownTimeMin: 10,
  prevPosWindow: 25,
  prevPosMinCount: 5,
  evalPosCount: 12,
  trailingEnabled: true,
  dcaProfile: {
    ...DEFAULT_DCA_PROFILE,
    stepVolumeMultipliers: [...DEFAULT_DCA_PROFILE.stepVolumeMultipliers],
    stepDistancesPct: [...DEFAULT_DCA_PROFILE.stepDistancesPct],
  },
}

const STRATEGY_TYPES: Array<[string, string]> = [
  ["standard", "Standard"],
  ["trailing_fixed", "Trailing Fixed"],
  ["trailing_auto", "Trailing Auto"],
  ["combination", "Combination"],
  ["inverse", "Inverse"],
  ["high_protection", "High Protection"],
  ["dca", "DCA"],
]

type ConnectionOption = {
  id: string
  name?: string
  exchange?: string
  is_enabled?: boolean | string | number
  is_active?: boolean | string | number
}

function Range({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  digits = step < 1 ? 2 : 0,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  digits?: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{value.toFixed(digits)}{suffix}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
    </div>
  )
}

function SelectableList({
  label,
  values,
  options,
  onChange,
}: {
  label: string
  values: string[]
  options: Array<[string, string]>
  onChange: (next: string[]) => void
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map(([value, title]) => {
          const selected = values.includes(value)
          return (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => {
                const next = selected ? values.filter((entry) => entry !== value) : [...values, value]
                if (next.length > 0) onChange(next)
              }}
            >
              {title}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function directConfig(state: DirectTradeState) {
  const { enabled, liveMode, ...config } = state
  return config
}

export function DirectTradeSettings() {
  const [state, setState] = useState<DirectTradeState>(DEFAULT_STATE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [connections, setConnections] = useState<ConnectionOption[]>([])

  const request = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/trade-engine/direct-trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.success !== true) throw new Error(payload?.error || "Direct-Trade settings were not accepted")
    if (payload?.state) setState((previous) => ({ ...previous, ...payload.state }))
    return payload
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [response, connectionsResponse] = await Promise.all([
        fetch("/api/trade-engine/direct-trade"),
        fetch("/api/connections"),
      ])
      const [payload, connectionsPayload] = await Promise.all([
        response.json(),
        connectionsResponse.json().catch(() => ({})),
      ])
      if (!response.ok || !payload?.state) throw new Error("Direct-Trade settings could not be loaded")
      setState({ ...DEFAULT_STATE, ...payload.state })
      setConnections(Array.isArray(connectionsPayload?.connections) ? connectionsPayload.connections.filter((entry: ConnectionOption) => entry?.id) : [])
    } catch (error) {
      toast.error("Direct-Trade settings unavailable", { description: error instanceof Error ? error.message : "Unknown error" })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const update = <K extends keyof DirectTradeState>(key: K, value: DirectTradeState[K]) => {
    setState((previous) => ({ ...previous, [key]: value }))
  }

  const updateDca = <K extends keyof DcaProfile>(key: K, value: DcaProfile[K]) => {
    setState((previous) => ({
      ...previous,
      dcaProfile: { ...previous.dcaProfile, [key]: value },
    }))
  }

  const updateDcaStep = (key: "stepVolumeMultipliers" | "stepDistancesPct", index: number, value: number) => {
    setState((previous) => {
      const values = [...previous.dcaProfile[key]]
      values[index] = value
      return { ...previous, dcaProfile: { ...previous.dcaProfile, [key]: values } }
    })
  }

  const apply = async () => {
    setSaving(true)
    try {
      await request({ action: "update-config", ...directConfig(state) })
      toast.success("Direct-Trade settings applied", { description: "The processor reads the updated compact configuration on its next 280 ms cycle." })
    } catch (error) {
      toast.error("Direct-Trade settings were not saved", { description: error instanceof Error ? error.message : "Unknown error" })
    } finally {
      setSaving(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setSaving(true)
    try {
      await request(enabled ? { action: "start", liveMode: state.liveMode, ...directConfig(state) } : { action: "stop" })
      toast.success(enabled ? "Direct-Trade enabled" : "Direct-Trade stopped")
    } catch (error) {
      toast.error("Direct-Trade state was not changed", { description: error instanceof Error ? error.message : "Unknown error" })
    } finally {
      setSaving(false)
    }
  }

  const setLiveMode = async (liveMode: boolean) => {
    if (liveMode && !state.connectionId) {
      toast.error("Select a live exchange connection first")
      return
    }
    setSaving(true)
    try {
      await request({ action: "toggle-live", liveMode })
      toast.success(liveMode ? "Direct-Trade live mode enabled" : "Direct-Trade paper mode enabled")
    } catch (error) {
      toast.error("Direct-Trade mode was not changed", { description: error instanceof Error ? error.message : "Unknown error" })
    } finally {
      setSaving(false)
    }
  }

  const recalcMinutes = useMemo(() => Math.round(state.recalcIntervalMs / 60_000), [state.recalcIntervalMs])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" />Direct Trade</CardTitle>
            <CardDescription>One persisted configuration for the dashboard, processor, calculations, coordinated control orders and statistics.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={state.enabled ? "default" : "secondary"}>{state.enabled ? "Enabled" : "Stopped"}</Badge>
            <Badge variant={state.liveMode ? "destructive" : "outline"}>{state.liveMode ? "Live" : "Paper"}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-7">
        {loading ? <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading Direct-Trade settings…</div> : <>
          <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-3">
            <div className="flex items-center justify-between gap-3"><div><Label>Enable processor</Label><p className="text-xs text-muted-foreground">Starts or stops new Direct-Trade entries. Existing positions remain managed until closed.</p></div><Switch checked={state.enabled} disabled={saving} onCheckedChange={setEnabled} /></div>
            <div className="flex items-center justify-between gap-3"><div><Label>Live execution</Label><p className="text-xs text-muted-foreground">Paper remains selected until this explicit setting is changed.</p></div><Switch checked={state.liveMode} disabled={saving} onCheckedChange={setLiveMode} /></div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0" />Closed-position PF gates never cancel open TP/SL/trailing/time exits.</div>
          </div>

          <div className="max-w-xl space-y-2 rounded-lg border p-4">
            <Label className="text-xs">Live exchange connection</Label>
            <Select value={state.connectionId || "__none"} onValueChange={(value) => update("connectionId", value === "__none" ? null : value)}>
              <SelectTrigger><SelectValue placeholder="Select a connection" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No live connection — Paper only</SelectItem>
                {connections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name || connection.id} · {connection.exchange || "exchange"}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Live entries require this explicit target, the installed worker token, a current processor lease and the server’s live-order safety flag.</p>
          </div>

          <section className="space-y-4"><div><h3 className="font-semibold">Runtime and capacity</h3><p className="text-xs text-muted-foreground">Fast indexed pulses; historical recalculation remains separately bounded.</p></div><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <Range label="Processing interval" value={state.processingIntervalMs} min={100} max={2_000} step={20} suffix=" ms" onChange={(value) => update("processingIntervalMs", value)} />
            <Range label="Recalculate every" value={recalcMinutes} min={5} max={1_440} step={5} suffix=" min" onChange={(value) => update("recalcIntervalMs", value * 60_000)} />
            <Range label="Historical range" value={state.historyHours} min={6} max={90} step={1} suffix=" h" onChange={(value) => update("historyHours", value)} />
            <Range label="Symbols" value={state.symbolCount} min={1} max={DIRECT_TRADE_MAX_SYMBOLS} step={1} onChange={(value) => update("symbolCount", value)} />
            <Range label="Global open-position cap" value={state.maxTotalPositions} min={1} max={300} step={1} onChange={(value) => update("maxTotalPositions", value)} />
            <Range label="Max positions / symbol" value={state.maxPositionsPerSymbol} min={1} max={300} step={1} onChange={(value) => update("maxPositionsPerSymbol", value)} />
            <Range label="Max positions / direction" value={state.maxPositionsPerDirection} min={1} max={300} step={1} onChange={(value) => update("maxPositionsPerDirection", value)} />
            <Range label="Maximum hold" value={state.maxHoldMinutes} min={5} max={720} step={5} suffix=" min" onChange={(value) => update("maxHoldMinutes", value)} />
            <Range label="Activity-volume ratio" value={state.activityVolumeRatio} min={0} max={3} step={0.1} onChange={(value) => update("activityVolumeRatio", value)} />
            <div className="space-y-2"><Label className="text-xs">Symbol order</Label><Select value={state.symbolOrder} onValueChange={(value: DirectTradeState["symbolOrder"]) => update("symbolOrder", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="volatility_1h">Volatility · 1h</SelectItem><SelectItem value="volatility">Volatility · 24h</SelectItem><SelectItem value="volume">Volume · 24h</SelectItem></SelectContent></Select></div>
          </div></section>

          <section className="space-y-4"><div><h3 className="font-semibold">Independent coordination matrix</h3><p className="text-xs text-muted-foreground">Every selected type, timeframe combination, entry and exit tactic receives a separate set identity and performance lineage.</p></div><div className="space-y-5">
            <SelectableList label="Timeframes" values={state.timeframes} options={[["5m", "5m"], ["15m", "15m"], ["30m", "30m"]]} onChange={(value) => update("timeframes", value)} />
            <SelectableList label="Strategy types" values={state.strategyTypes} options={STRATEGY_TYPES} onChange={(value) => update("strategyTypes", value)} />
            <div className="space-y-3 rounded-lg border p-3">
              <div><Label className="text-xs">Live entry indication types</Label><p className="text-xs text-muted-foreground">All sliders may be off. Historical calculation and validation still run for the calculated indication types below.</p></div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[["momentum", "Momentum"], ["mean_reversion", "Mean reversion"], ["breakout", "Breakout"], ["relative", "Relative"]].map(([value, title]) => {
                  const checked = state.enabledIndicationTypes.includes(value)
                  return <label key={value} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"><span>{title}</span><Switch aria-label={`Enable ${title} Direct-Trade live entries`} checked={checked} onCheckedChange={(nextChecked) => update("enabledIndicationTypes", nextChecked ? [...state.enabledIndicationTypes, value] : state.enabledIndicationTypes.filter((entry) => entry !== value))} /></label>
                })}
              </div>
            </div>
            <SelectableList label="Calculated indication types" values={state.entryTactics} options={[["momentum", "Momentum"], ["mean_reversion", "Mean reversion"], ["breakout", "Breakout"], ["relative", "Relative"]]} onChange={(value) => update("entryTactics", value)} />
            <SelectableList label="Exit tactics" values={state.exitTactics} options={[["bracket", "Bracket"], ["momentum_reversal", "Momentum reversal"], ["relative", "Relative reversal"], ["time", "Time"]]} onChange={(value) => update("exitTactics", value)} />
            <div className="max-w-xs space-y-2"><Label className="text-xs">Entry timing</Label><Select value={state.entryTiming} onValueChange={(value: DirectTradeState["entryTiming"]) => update("entryTiming", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="current">Current causal candle</SelectItem><SelectItem value="last_confirmed">Last confirmed candle</SelectItem></SelectContent></Select></div>
          </div></section>

          <section className="space-y-4"><div><h3 className="font-semibold">Sizing, protection and blocks</h3><p className="text-xs text-muted-foreground">TP handles span 2–22× PositionCost; fresh Sets use the 5–10× default with a 5× creation stride. Explicit legacy grids remain readable. PositionCost is deducted once after an actual close. Block targets use Base + valid blocks × Base × Block ratio.</p></div><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Direct-Trade volume factor</Label>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{clampDirectTradeVolumeFactor(state.minVolFactor).toFixed(1)}×</span>
              </div>
              <Slider
                aria-label="Direct-Trade volume factor"
                value={[clampDirectTradeVolumeFactor(state.minVolFactor)]}
                min={DIRECT_TRADE_VOLUME_FACTOR_MIN}
                max={DIRECT_TRADE_VOLUME_FACTOR_MAX}
                step={0.1}
                onValueChange={([value]) => update("minVolFactor", clampDirectTradeVolumeFactor(value))}
              />
              <p className="text-[11px] text-muted-foreground">0.1–10, default 0.1. Effective request = factor × {DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO}; live execution rounds up only when exchange quantity/notional rules require it.</p>
            </div>
            <Range label="PositionCost" value={state.positionCostPercent} min={0.02} max={1} step={0.02} suffix=" %" onChange={(value) => update("positionCostPercent", value)} />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">TP Set range · × PositionCost</Label>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{state.takeProfitRatioRange[0]}–{state.takeProfitRatioRange[1]}</span>
              </div>
              <Slider
                aria-label="Direct-Trade take-profit PositionCost range"
                value={state.takeProfitRatioRange}
                min={DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN}
                max={DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX}
                step={1}
                minStepsBetweenThumbs={0}
                onValueChange={(next) => {
                  const minimum = Math.max(DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN, Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, Math.round(next[0] ?? state.takeProfitRatioRange[0])))
                  const maximum = Math.max(minimum, Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, Math.round(next[1] ?? state.takeProfitRatioRange[1])))
                  update("takeProfitRatioRange", [minimum, maximum])
                }}
              />
            </div>
            <Range label="TP Set-creation step · × PositionCost" value={state.takeProfitRatioStep} min={1} max={20} step={1} onChange={(value) => update("takeProfitRatioStep", value)} />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Trailing from TP step · × PositionCost</Label>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{state.trailingMinTakeProfitRatio}</span>
              </div>
              <Slider
                aria-label="Direct-Trade trailing minimum take-profit PositionCost ratio"
                value={[state.trailingMinTakeProfitRatio]}
                min={DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN}
                max={DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX}
                step={1}
                disabled={!state.trailingEnabled}
                onValueChange={([value]) => update("trailingMinTakeProfitRatio", value)}
              />
              <p className="text-xs text-muted-foreground">Only trailed variants at or above this TP multiple are materialised. Normal, DCA and non-trailing combination lanes below it remain available.</p>
            </div>
            <Range label="Normal SL maximum / TP" value={state.maxSlRatio} min={0.25} max={0.75} step={0.25} onChange={(value) => update("maxSlRatio", value)} />
            <Range label="Inverse SL maximum / TP" value={state.inverseMaxSlRatio} min={0.25} max={1.25} step={0.25} onChange={(value) => update("inverseMaxSlRatio", value)} />
            <Range label="SL ratio step" value={state.slRatioStep} min={0.25} max={0.75} step={0.25} onChange={(value) => update("slRatioStep", value)} />
            <Range label="Block minimum" value={state.blockRange[0]} min={0} max={state.blockRange[1]} step={1} onChange={(value) => update("blockRange", [value, state.blockRange[1]])} />
            <Range label="Block maximum" value={state.blockRange[1]} min={state.blockRange[0]} max={120} step={1} onChange={(value) => update("blockRange", [state.blockRange[0], value])} />
            <Range label="Block increase ratio / valid block" value={state.blockVolumeRatio} min={0.1} max={10} step={0.1} onChange={(value) => update("blockVolumeRatio", value)} />
            <Range label="Block minimum-PF factor" value={state.blockProfitFactorRatio} min={0.2} max={5} step={0.1} suffix="×" onChange={(value) => update("blockProfitFactorRatio", value)} />
            <div className="flex items-center justify-between rounded-md border p-3"><div><Label>Trailing protection</Label><p className="text-xs text-muted-foreground">Fixed, Auto and Combination remain independent lanes.</p></div><Switch checked={state.trailingEnabled} onCheckedChange={(value) => update("trailingEnabled", value)} /></div>
          </div></section>

          <section className="space-y-4">
            <div>
              <h3 className="font-semibold">DCA profile</h3>
              <p className="text-xs text-muted-foreground">Optimized 7-day defaults: Relative entry on 15m, four causal 1× adds at 0.3/0.6/1.0/1.6%, average-entry TP and a hard total exposure ceiling of 5× including the initial fill.</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              <Range label="DCA executable steps" value={state.dcaProfile.maxSteps} min={1} max={4} step={1} onChange={(value) => updateDca("maxSteps", value)} />
              <Range label="DCA total volume ceiling" value={state.dcaProfile.maxPositionVolumeRatio} min={MIN_DCA_POSITION_VOLUME_RATIO} max={MAX_DCA_POSITION_VOLUME_RATIO} step={0.1} suffix="×" onChange={(value) => updateDca("maxPositionVolumeRatio", value)} />
              <Range label="DCA add cooldown" value={state.dcaProfile.cooldownSeconds} min={0} max={3_600} step={5} suffix=" s" onChange={(value) => updateDca("cooldownSeconds", value)} />
              <div className="space-y-2">
                <Label className="text-xs">DCA take-profit reference</Label>
                <Select value={state.dcaProfile.takeProfitMode} onValueChange={(value: DcaTakeProfitMode) => updateDca("takeProfitMode", value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="average">Weighted average entry</SelectItem>
                    <SelectItem value="first_entry">First entry</SelectItem>
                    <SelectItem value="breakeven_plus">Breakeven plus</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Range label="Breakeven-plus target" value={state.dcaProfile.breakevenProfitPct} min={0.05} max={5} step={0.05} suffix=" %" onChange={(value) => updateDca("breakevenProfitPct", value)} />
            </div>
            <div className="grid gap-5 rounded-lg border p-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-4">
                  <p className="text-xs font-semibold">Step {index + 1}</p>
                  <Range label="Base-volume multiplier" value={state.dcaProfile.stepVolumeMultipliers[index]} min={0.1} max={2.5} step={0.1} suffix="×" onChange={(value) => updateDcaStep("stepVolumeMultipliers", index, value)} />
                  <Range label="Adverse distance" value={state.dcaProfile.stepDistancesPct[index]} min={0.1} max={20} step={0.1} suffix=" %" onChange={(value) => updateDcaStep("stepDistancesPct", index, value)} />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-4"><div><h3 className="font-semibold">Closed-position evaluation</h3><p className="text-xs text-muted-foreground">Recent PF is evaluated only from closed positions. The stricter default is calibrated with the 90-hour matrix before release.</p></div><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <Range label="Full-history PF minimum" value={state.minProfitFactor} min={0.8} max={10} step={0.1} onChange={(value) => update("minProfitFactor", value)} />
            <Range label="Recent closed-position PF minimum" value={state.minRecentProfitFactor} min={0.8} max={50} step={0.1} onChange={(value) => update("minRecentProfitFactor", value)} />
            <Range label="Recent evaluation positions" value={state.recentEvaluationPositions} min={3} max={50} step={1} suffix=" closed" onChange={(value) => update("recentEvaluationPositions", value)} />
            <Range label="Keep-enabled position window" value={state.keepEnabledPosCount} min={3} max={100} step={1} suffix=" closed" onChange={(value) => update("keepEnabledPosCount", value)} />
            <Range label="Permanent-deactivation window" value={state.deactivatePosCount} min={3} max={100} step={1} suffix=" closed" onChange={(value) => update("deactivatePosCount", value)} />
            <Range label="Maximum DDT" value={state.maxDrawdownTimeMin} min={1} max={120} step={1} suffix=" min" onChange={(value) => update("maxDrawdownTimeMin", value)} />
            <Range label="Overall rolling PF/DDT window" value={state.prevPosWindow} min={5} max={200} step={1} suffix=" closed" onChange={(value) => update("prevPosWindow", value)} />
            <Range label="Minimum positions before overall eval" value={state.prevPosMinCount} min={1} max={100} step={1} suffix=" closed" onChange={(value) => update("prevPosMinCount", value)} />
            <Range label="Coordination evaluation positions" value={state.evalPosCount} min={3} max={100} step={1} suffix=" closed" onChange={(value) => update("evalPosCount", value)} />
          </div></section>

          <div className="flex justify-end border-t pt-4"><Button type="button" onClick={apply} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Apply Direct-Trade settings</Button></div>
        </>}
      </CardContent>
    </Card>
  )
}
