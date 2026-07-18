"use client"

export const dynamic = "force-dynamic"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Loader2,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useExchange } from "@/lib/exchange-context"
import { toast } from "@/lib/simple-toast"

type IndicatorType = "rsi" | "macd" | "bollinger" | "ema" | "sma" | "stochastic" | "adx" | "atr" | "sar"

interface NumericRange {
  min: number
  max: number
  step: number
}

interface OptimizerSettings {
  historyDays: number
  presetsPerSymbol: number
  minProfitFactor: number
  maxDrawdownHours: number
  takeProfit: NumericRange
  stopLossRatio: NumericRange
  trailingEnabled: boolean
  trailingIndependent: boolean
  trailingStart: NumericRange
  trailingStop: NumericRange
  trailingStepRatio: number
  autoGenerate: boolean
  autoSelect: boolean
  indicatorTypes: IndicatorType[]
  maxIndicatorVariantsPerType: number
  maxSignalsPerVariant: number
  maxCandlesPerRun: number
  blockEnabled: boolean
  blockVolumeRatio: number
  blockProfitFactorRatio: number
  blockMaxStack: number
  blockPauseCountRatio: number
  blockActiveRealEnabled: boolean
  blockActiveLiveEnabled: boolean
}

interface DailyMetric {
  day: number
  date: string
  profitFactor: number
  netR: number
  positions: number
}

interface OptimizedPreset {
  id: string
  symbol: string
  indicator: { type: IndicatorType; params: Record<string, number> }
  positionCostPct: number
  takeProfitRatio: number
  takeProfitPct: number
  takeProfitEnabled: boolean
  stopLossToTakeProfitRatio: number
  stopLossPct: number
  trailing: {
    enabled: boolean
    independent: boolean
    startRatio: number
    stopRatio: number
    stepRatio: number
  }
  metrics: {
    profitFactor: number
    averageProfitFactor: number
    netR: number
    averageR: number
    winRate: number
    totalPositions: number
    winningPositions: number
    losingPositions: number
    maxDrawdownR: number
    drawdownTimeHours: number
    averageHoldMinutes: number
    score: number
    eligible: boolean
    daily: Array<DailyMetric & { averageR: number; winRate: number }>
  }
  selected: boolean
  rank: number
  generatedAt: string
  historyFrom: string
  historyTo: string
  dataPoints: number
}

interface PresetOverview {
  connectionId: string
  generationId: string | null
  settings: OptimizerSettings
  presets: OptimizedPreset[]
  summary: {
    total: number
    eligible: number
    selected: number
    symbols: number
    indicatorTypes: number
    averageProfitFactor: number
    averageWinRate: number
    averageDrawdownHours: number
    netR: number
    daily: DailyMetric[]
  }
  facets: { symbols: string[]; indicatorTypes: string[] }
  progress: {
    status: "idle" | "running" | "completed" | "failed"
    currentSymbol?: string
    symbolsCompleted: number
    symbolsTotal: number
    evaluatedConfigurations: number
    presetsGenerated: number
    sourceCandles: number
    sampledCandles: number
    error?: string
  }
  engine: Record<string, string>
}

const INDICATORS: IndicatorType[] = ["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"]

function formatNumber(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.00"
}

function formatProfitFactor(value: number): string {
  if (!Number.isFinite(value) || value >= 99) return "∞"
  return value.toFixed(2)
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "text-primary",
}: {
  icon: typeof BarChart3
  label: string
  value: string
  detail: string
  tone?: string
}) {
  return (
    <Card className="border-border/80 bg-card/90">
      <CardContent className="flex items-center gap-3 p-3">
        <div className={`rounded-lg bg-muted p-2 ${tone}`}><Icon className="h-4 w-4" /></div>
        <div className="min-w-0">
          <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="truncate text-[10px] text-muted-foreground/80">{detail}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  )
}

function PresetDailyDiagram({
  rows,
  minimumProfitFactor,
}: {
  rows: OptimizedPreset["metrics"]["daily"]
  minimumProfitFactor: number
}) {
  const maximum = Math.max(1, ...rows.map((row) => Math.min(10, Math.max(0, row.profitFactor))))
  return (
    <div
      className="rounded-md border bg-muted/20 px-2 py-1.5"
      aria-label={`Daily ProfitFactor diagram for ${rows.length} days`}
    >
      <div className="flex h-8 items-end gap-px">
        {rows.map((row) => {
          const bounded = Math.min(10, Math.max(0, row.profitFactor))
          const height = row.positions > 0 ? Math.max(8, (bounded / maximum) * 100) : 3
          return (
            <div
              key={`${row.day}-${row.date}`}
              className={`min-w-px flex-1 rounded-t-sm ${row.profitFactor >= minimumProfitFactor ? "bg-emerald-500/75" : row.positions > 0 ? "bg-amber-500/70" : "bg-muted-foreground/20"}`}
              style={{ height: `${height}%` }}
              title={`${row.date}: PF ${formatProfitFactor(row.profitFactor)}, ${row.positions} positions, ${formatNumber(row.netR)}R`}
            />
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[8px] uppercase tracking-wide text-muted-foreground">
        <span>D1</span><span>{rows.length || 0}-day PF</span><span>D{rows.length || 0}</span>
      </div>
    </div>
  )
}

export default function PresetsPage() {
  const { selectedConnectionId } = useExchange()
  const [overview, setOverview] = useState<PresetOverview | null>(null)
  const [draft, setDraft] = useState<OptimizerSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [togglingEngine, setTogglingEngine] = useState(false)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [symbolFilter, setSymbolFilter] = useState("all")
  const [indicatorFilter, setIndicatorFilter] = useState("all")
  const [eligibilityFilter, setEligibilityFilter] = useState<"all" | "eligible" | "selected">("all")
  const [trailingFilter, setTrailingFilter] = useState<"all" | "enabled" | "disabled">("all")
  const [visibleLimit, setVisibleLimit] = useState(48)
  const autoAttempted = useRef<string | null>(null)

  const loadOverview = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!selectedConnectionId) {
      setOverview(null)
      setDraft(null)
      return null
    }
    if (!quiet) setLoading(true)
    try {
      const response = await fetch(`/api/preset-optimizer?connectionId=${encodeURIComponent(selectedConnectionId)}`, {
        cache: "no-store",
        signal,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || `Request failed (${response.status})`)
      if (signal?.aborted) return null
      const next = body.data as PresetOverview
      setOverview(next)
      setDraft(next.settings)
      return next
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return null
      toast.error(error instanceof Error ? error.message : "Failed to load preset optimizer")
      return null
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [selectedConnectionId])

  useEffect(() => {
    setSymbolFilter("all")
    setIndicatorFilter("all")
    setEligibilityFilter("all")
    setTrailingFilter("all")
    autoAttempted.current = null
    void loadOverview()
  }, [loadOverview])

  const generate = useCallback(async (automatic = false) => {
    if (!selectedConnectionId || generating) return
    setGenerating(true)
    try {
      const response = await fetch("/api/preset-optimizer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          connectionId: selectedConnectionId,
          settings: draft || overview?.settings,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || `Generation failed (${response.status})`)
      setOverview(body.data)
      setDraft(body.data.settings)
      toast.success(`Generated ${body.progress?.presetsGenerated ?? body.data?.summary?.total ?? 0} ranked presets`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preset generation failed"
      if (!automatic) toast.error(message)
      else console.warn("[Presets] automatic generation failed:", message)
      await loadOverview(true)
    } finally {
      setGenerating(false)
    }
  }, [draft, generating, loadOverview, overview?.settings, selectedConnectionId])

  useEffect(() => {
    if (
      selectedConnectionId &&
      overview &&
      !overview.generationId &&
      overview.settings.autoGenerate &&
      overview.progress.status !== "running" &&
      autoAttempted.current !== selectedConnectionId
    ) {
      autoAttempted.current = selectedConnectionId
      void generate(true)
    }
  }, [generate, overview, selectedConnectionId])

  useEffect(() => {
    if (!generating) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const pollProgress = async () => {
      if (cancelled) return
      await loadOverview(true, controller.signal)
      if (!cancelled) timer = setTimeout(() => void pollProgress(), 1_000)
    }
    timer = setTimeout(() => void pollProgress(), 500)
    return () => {
      cancelled = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [generating, loadOverview])

  const saveSettings = async () => {
    if (!selectedConnectionId || !draft) return
    setSaving(true)
    try {
      const response = await fetch("/api/preset-optimizer", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: selectedConnectionId, settings: draft }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || `Save failed (${response.status})`)
      setOverview(body.data)
      setDraft(body.settings)
      toast.success("Preset optimizer settings saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  const selectPreset = async (preset: OptimizedPreset) => {
    if (!selectedConnectionId) return
    setSelectingId(preset.id)
    try {
      const response = await fetch("/api/preset-optimizer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "select",
          connectionId: selectedConnectionId,
          presetId: preset.id,
          symbol: preset.symbol,
          indicatorType: preset.indicator.type,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || `Selection failed (${response.status})`)
      setOverview(body.data)
      setDraft(body.data.settings)
      toast.success(`${preset.symbol} ${preset.indicator.type.toUpperCase()} preset selected`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to select preset")
    } finally {
      setSelectingId(null)
    }
  }

  const togglePresetEngine = async () => {
    if (!selectedConnectionId || !overview) return
    const next = overview.engine.enabled !== "1"
    setTogglingEngine(true)
    try {
      const response = await fetch(`/api/settings/connections/${encodeURIComponent(selectedConnectionId)}/preset-toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_preset_trade: next }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || `Engine switch failed (${response.status})`)
      await loadOverview(true)
      if (body.preset_trade_requested && !body.is_preset_trade) {
        toast.warning(`Preset engine blocked: ${body.preset_trade_blocked_reason || "production exchange requirements are not satisfied"}`)
      } else {
        toast.success(`Preset engine ${next ? "enabled" : "disabled"}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch Preset engine")
    } finally {
      setTogglingEngine(false)
    }
  }

  const visiblePresets = useMemo(() => {
    if (!overview) return []
    return overview.presets.filter((preset) => {
      if (symbolFilter !== "all" && preset.symbol !== symbolFilter) return false
      if (indicatorFilter !== "all" && preset.indicator.type !== indicatorFilter) return false
      if (eligibilityFilter === "eligible" && !preset.metrics.eligible) return false
      if (eligibilityFilter === "selected" && !preset.selected) return false
      if (trailingFilter === "enabled" && !preset.trailing.enabled) return false
      if (trailingFilter === "disabled" && preset.trailing.enabled) return false
      return true
    })
  }, [eligibilityFilter, indicatorFilter, overview, symbolFilter, trailingFilter])
  const renderedPresets = useMemo(
    () => visiblePresets.slice(0, visibleLimit),
    [visibleLimit, visiblePresets],
  )

  useEffect(() => {
    setVisibleLimit(48)
  }, [eligibilityFilter, indicatorFilter, selectedConnectionId, symbolFilter, trailingFilter])

  const updateRange = (key: "takeProfit" | "stopLossRatio" | "trailingStart" | "trailingStop", field: keyof NumericRange, value: number) => {
    setDraft((current) => current ? { ...current, [key]: { ...current[key], [field]: value } } : current)
  }

  const maxDailyPf = Math.max(1, ...(overview?.summary.daily.map((row) => Math.min(10, row.profitFactor)) || [1]))
  const presetEngineEnabled = overview?.engine.enabled === "1"
  const presetEngineRequested = overview?.engine.requested === "1"
  const presetEngineBlocked = presetEngineRequested && !presetEngineEnabled
  const progress = overview?.progress

  if (!selectedConnectionId) {
    return (
      <div className="space-y-4 p-4">
        <PageHeader title="Preset Optimizer" description="Select an active connection to calculate and trade ranked presets." />
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No active connection selected.</CardContent></Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Preset Optimizer"
          description="Cost-normalized 1–14 day evaluation, automatic ranking, and exchange-ready Preset execution."
        />
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${presetEngineEnabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" : presetEngineBlocked ? "border-red-500/40 bg-red-500/10 text-red-600" : "border-border text-muted-foreground"}`}
            title={presetEngineBlocked ? overview?.engine.blockedReason : undefined}
          >
            {presetEngineEnabled ? "Preset engine active" : presetEngineBlocked ? "Preset engine blocked" : "Preset engine stopped"}
          </div>
          <Button variant="outline" size="sm" onClick={togglePresetEngine} disabled={togglingEngine || loading}>
            {togglingEngine ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Activity className="mr-1.5 h-3.5 w-3.5" />}
            {presetEngineEnabled ? "Stop engine" : presetEngineBlocked ? "Retry engine" : "Start engine"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen((value) => !value)}>
            <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Settings
            {settingsOpen ? <ChevronUp className="ml-1 h-3.5 w-3.5" /> : <ChevronDown className="ml-1 h-3.5 w-3.5" />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadOverview()} disabled={loading || generating}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" onClick={() => void generate(false)} disabled={generating || loading || !draft}>
            {generating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
            {generating ? "Calculating…" : "Generate presets"}
          </Button>
        </div>
      </div>

      {progress?.status === "running" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-wrap items-center gap-3 p-3 text-xs">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="font-medium">Optimizing {progress.currentSymbol || "symbols"}</span>
            <span className="text-muted-foreground">{progress.symbolsCompleted}/{progress.symbolsTotal} symbols</span>
            <span className="text-muted-foreground">{progress.evaluatedConfigurations.toLocaleString()} configurations</span>
            <span className="text-muted-foreground">{progress.sourceCandles.toLocaleString()} source candles</span>
          </CardContent>
        </Card>
      )}

      {settingsOpen && draft && (
        <Card className="border-primary/20">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-sm">Optimizer and execution settings</CardTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">Ratios are applied to position cost; trailing ratios use market-price change (0.1 = 10%).</p>
            </div>
            <Button size="sm" onClick={saveSettings} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />} Save
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
              <NumberField label="History days" value={draft.historyDays} min={1} max={14} step={1} onChange={(value) => setDraft({ ...draft, historyDays: value })} />
              <NumberField label="Presets / type" value={draft.presetsPerSymbol} min={1} max={12} step={1} onChange={(value) => setDraft({ ...draft, presetsPerSymbol: value })} />
              <NumberField label="Min ProfitFactor" value={draft.minProfitFactor} min={0.4} max={3} step={0.1} onChange={(value) => setDraft({ ...draft, minProfitFactor: value })} />
              <NumberField label="Max drawdown h" value={draft.maxDrawdownHours} min={1} max={24} step={0.5} onChange={(value) => setDraft({ ...draft, maxDrawdownHours: value })} />
              <NumberField label="Indicator variants" value={draft.maxIndicatorVariantsPerType} min={1} max={12} step={1} onChange={(value) => setDraft({ ...draft, maxIndicatorVariantsPerType: value })} />
              <NumberField label="Signals / variant" value={draft.maxSignalsPerVariant} min={8} max={128} step={1} onChange={(value) => setDraft({ ...draft, maxSignalsPerVariant: value })} />
              <NumberField label="Max candles" value={draft.maxCandlesPerRun} min={500} max={20000} step={100} onChange={(value) => setDraft({ ...draft, maxCandlesPerRun: value })} />
              <NumberField label="Trail step factor" value={draft.trailingStepRatio} min={0.1} max={1} step={0.1} onChange={(value) => setDraft({ ...draft, trailingStepRatio: value })} />
            </div>

            <div className="grid gap-3 lg:grid-cols-4">
              {([
                ["takeProfit", "Take Profit / position cost", draft.takeProfit, { min: 3, max: 30, step: 1 }],
                ["stopLossRatio", "Stop Loss / TP", draft.stopLossRatio, { min: 0.25, max: 2, step: 0.25 }],
                ["trailingStart", "Trailing activation", draft.trailingStart, { min: 0.5, max: 1.5, step: 0.1 }],
                ["trailingStop", "Trailing stop", draft.trailingStop, { min: 0.2, max: 0.4, step: 0.1 }],
              ] as const).map(([key, title, range, bounds]) => (
                <div key={key} className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-2 text-xs font-medium">{title}</div>
                  <div className="grid grid-cols-3 gap-2">
                    <NumberField label="Min" value={range.min} min={bounds.min} max={bounds.max} step={bounds.step} onChange={(value) => updateRange(key, "min", value)} />
                    <NumberField label="Max" value={range.max} min={bounds.min} max={bounds.max} step={bounds.step} onChange={(value) => updateRange(key, "max", value)} />
                    <NumberField label="Step" value={range.step} min={bounds.step} max={bounds.max} step={bounds.step} onChange={(value) => updateRange(key, "step", value)} />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/20 p-3">
              {([
                ["autoGenerate", "Auto-generate missing presets"],
                ["autoSelect", "Auto-select best per symbol/type"],
                ["trailingEnabled", "Include trailing strategies"],
                ["trailingIndependent", "Trailing independent from TP"],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <Switch checked={draft[key]} onCheckedChange={(checked) => setDraft({ ...draft, [key]: checked })} />
                  <Label className="text-xs">{label}</Label>
                </div>
              ))}
            </div>

            <div className={`space-y-3 rounded-lg border p-3 ${draft.blockEnabled ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold">Block Strategy Type · Adjust</div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Independent Block counts keep their own volume state. Add quantity = current position base × (Block count × volume ratio), then that count pauses after profitable completion.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Enabled</Label>
                  <Switch checked={draft.blockEnabled} onCheckedChange={(checked) => setDraft({ ...draft, blockEnabled: checked })} />
                </div>
              </div>
              <div className={draft.blockEnabled ? "grid gap-2 md:grid-cols-2 xl:grid-cols-4" : "grid gap-2 md:grid-cols-2 xl:grid-cols-4 pointer-events-none"}>
                <NumberField label="Volume ratio" value={draft.blockVolumeRatio} min={0.25} max={3} step={0.05} onChange={(value) => setDraft({ ...draft, blockVolumeRatio: value })} />
                <NumberField label="ProfitFactor factor" value={draft.blockProfitFactorRatio} min={0.2} max={5} step={0.1} onChange={(value) => setDraft({ ...draft, blockProfitFactorRatio: value })} />
                <NumberField label="Independent counts" value={draft.blockMaxStack} min={1} max={10} step={1} onChange={(value) => setDraft({ ...draft, blockMaxStack: value })} />
                <NumberField label="Post-profit pause ratio" value={draft.blockPauseCountRatio} min={1} max={4} step={0.5} onChange={(value) => setDraft({ ...draft, blockPauseCountRatio: value })} />
              </div>
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <Switch disabled={!draft.blockEnabled} checked={draft.blockActiveRealEnabled} onCheckedChange={(checked) => setDraft({ ...draft, blockActiveRealEnabled: checked })} />
                  <Label className="text-xs">Active Real-position Block</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch disabled={!draft.blockEnabled} checked={draft.blockActiveLiveEnabled} onCheckedChange={(checked) => setDraft({ ...draft, blockActiveLiveEnabled: checked })} />
                  <Label className="text-xs">Active Live-position Block</Label>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px] tabular-nums">
                {[1, 2, Math.max(3, Math.min(10, Math.floor(draft.blockMaxStack)))].map((count, index) => (
                  <div key={`${count}-${index}`} className="rounded border bg-muted/20 px-2 py-1.5 text-center">
                    Block {count}: +{formatNumber(count * draft.blockVolumeRatio, 2)}× base
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label className="mb-2 block text-[11px] text-muted-foreground">Common indication types</Label>
              <div className="flex flex-wrap gap-2">
                {INDICATORS.map((indicator) => {
                  const active = draft.indicatorTypes.includes(indicator)
                  return (
                    <Button
                      key={indicator}
                      type="button"
                      variant={active ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-[11px] uppercase"
                      onClick={() => setDraft({
                        ...draft,
                        indicatorTypes: active
                          ? draft.indicatorTypes.filter((item) => item !== indicator)
                          : [...draft.indicatorTypes, indicator],
                      })}
                    >
                      {active && <Check className="mr-1 h-3 w-3" />}{indicator}
                    </Button>
                  )
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={Database} label="Presets" value={String(overview?.summary.total || 0)} detail={`${overview?.summary.symbols || 0} symbols · ${overview?.summary.indicatorTypes || 0} types`} />
        <StatCard icon={ShieldCheck} label="Eligible" value={String(overview?.summary.eligible || 0)} detail={`PF ≥ ${formatNumber(overview?.settings.minProfitFactor || 0.7, 1)}`} tone="text-emerald-500" />
        <StatCard icon={Check} label="Selected" value={String(overview?.summary.selected || 0)} detail="Best per symbol and indication" tone="text-blue-500" />
        <StatCard icon={TrendingUp} label="Average PF" value={formatProfitFactor(overview?.summary.averageProfitFactor || 0)} detail="Position-cost normalized" tone="text-emerald-500" />
        <StatCard icon={Target} label="Win rate" value={`${formatNumber(overview?.summary.averageWinRate || 0, 1)}%`} detail={`Net ${formatNumber(overview?.summary.netR || 0)}R`} />
        <StatCard icon={Clock3} label="Drawdown time" value={`${formatNumber(overview?.summary.averageDrawdownHours || 0, 1)}h`} detail={`Max configured ${formatNumber(overview?.settings.maxDrawdownHours || 5, 1)}h`} tone="text-amber-500" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><BarChart3 className="h-4 w-4 text-primary" /> Daily average ProfitFactor</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-28 items-end gap-1.5">
            {(overview?.summary.daily || []).map((row) => {
              const bounded = Math.min(10, Math.max(0, row.profitFactor))
              const height = row.positions > 0 ? Math.max(5, (bounded / maxDailyPf) * 100) : 2
              return (
                <div key={`${row.day}-${row.date}`} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <div className="hidden text-[9px] tabular-nums text-muted-foreground sm:block">{formatProfitFactor(row.profitFactor)}</div>
                  <div
                    className={`w-full max-w-10 rounded-t transition-colors ${row.profitFactor >= (overview?.settings.minProfitFactor || 0.7) ? "bg-emerald-500/75 group-hover:bg-emerald-500" : "bg-amber-500/60 group-hover:bg-amber-500"}`}
                    style={{ height: `${height}%` }}
                    title={`${row.date}: PF ${formatProfitFactor(row.profitFactor)}, ${row.positions} positions, ${formatNumber(row.netR)}R`}
                  />
                  <div className="text-[9px] text-muted-foreground">D{row.day}</div>
                </div>
              )
            })}
            {!overview?.summary.daily.length && <div className="m-auto text-xs text-muted-foreground">Generate presets to populate daily metrics.</div>}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <select value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="all">All symbols</option>
          {(overview?.facets.symbols || []).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
        </select>
        <select value={indicatorFilter} onChange={(event) => setIndicatorFilter(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="all">All indications</option>
          {(overview?.facets.indicatorTypes || []).map((type) => <option key={type} value={type}>{type.toUpperCase()}</option>)}
        </select>
        <select value={eligibilityFilter} onChange={(event) => setEligibilityFilter(event.target.value as typeof eligibilityFilter)} className="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="all">All results</option>
          <option value="eligible">Eligible only</option>
          <option value="selected">Selected only</option>
        </select>
        <select value={trailingFilter} onChange={(event) => setTrailingFilter(event.target.value as typeof trailingFilter)} className="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="all">All protection</option>
          <option value="enabled">Trailing</option>
          <option value="disabled">TP / SL</option>
        </select>
        <span className="ml-auto text-[11px] text-muted-foreground">{renderedPresets.length}/{visiblePresets.length} rendered · best results first</span>
      </div>

      <div className="max-h-[calc(100vh-360px)] space-y-2 overflow-y-auto pr-1">
        {loading && !overview ? (
          <Card><CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading presets…</CardContent></Card>
        ) : visiblePresets.length === 0 ? (
          <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No persisted optimizer results match these filters. Generate presets to calculate real historical metrics.</CardContent></Card>
        ) : renderedPresets.map((preset) => (
          <Card key={preset.id} className={`overflow-hidden ${preset.selected ? "border-primary/60 bg-primary/[0.035]" : "border-border/80"}`}>
            <CardContent className="p-3">
              <div className="grid items-center gap-3 xl:grid-cols-[minmax(190px,1.4fr)_repeat(6,minmax(76px,.55fr))_minmax(190px,1.2fr)_minmax(120px,.8fr)_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{preset.symbol}</span>
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">{preset.indicator.type}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Rank {preset.rank}</span>
                    {preset.metrics.eligible && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600">Eligible</span>}
                    {preset.selected && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">Selected</span>}
                  </div>
                  <div className="mt-1 truncate text-[10px] text-muted-foreground">
                    {Object.entries(preset.indicator.params).map(([key, value]) => `${key} ${value}`).join(" · ")}
                  </div>
                </div>

                {[
                  ["ProfitFactor", formatProfitFactor(preset.metrics.profitFactor), "text-emerald-500"],
                  ["Avg PF", formatProfitFactor(preset.metrics.averageProfitFactor), ""],
                  ["Win / Loss", `${preset.metrics.winningPositions} / ${preset.metrics.losingPositions}`, ""],
                  ["Win rate", `${formatNumber(preset.metrics.winRate, 1)}%`, ""],
                  ["Net", `${formatNumber(preset.metrics.netR)}R`, preset.metrics.netR >= 0 ? "text-emerald-500" : "text-red-500"],
                  ["DD time", `${formatNumber(preset.metrics.drawdownTimeHours, 1)}h`, preset.metrics.drawdownTimeHours <= (overview?.settings.maxDrawdownHours || 5) ? "" : "text-red-500"],
                ].map(([label, value, tone]) => (
                  <div key={label} className="min-w-0">
                    <div className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
                  </div>
                ))}

                <div className="rounded-md border bg-muted/25 px-2 py-1.5 text-[10px]">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span className="text-muted-foreground">Position cost</span><span className="text-right tabular-nums">{formatNumber(preset.positionCostPct, 4)}%</span>
                    <span className="text-muted-foreground">TP</span><span className="text-right tabular-nums">{preset.takeProfitEnabled ? `${formatNumber(preset.takeProfitRatio, 2)}× = ${formatNumber(preset.takeProfitPct, 4)}%` : "Trailing only"}</span>
                    <span className="text-muted-foreground">SL / TP</span><span className="text-right tabular-nums">{formatNumber(preset.stopLossToTakeProfitRatio, 2)}× = {formatNumber(preset.stopLossPct, 4)}%</span>
                    <span className="text-muted-foreground">Trailing</span><span className="text-right tabular-nums">{preset.trailing.enabled ? `${preset.trailing.startRatio}/${preset.trailing.stopRatio}/${preset.trailing.stepRatio}` : "Off"}</span>
                  </div>
                </div>

                <PresetDailyDiagram
                  rows={preset.metrics.daily}
                  minimumProfitFactor={overview?.settings.minProfitFactor || 0.7}
                />

                <Button
                  size="sm"
                  variant={preset.selected ? "outline" : "default"}
                  disabled={selectingId === preset.id || !preset.metrics.eligible}
                  onClick={() => void selectPreset(preset)}
                  className="h-8"
                >
                  {selectingId === preset.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : preset.selected
                      ? <><Check className="mr-1 h-3.5 w-3.5" />Selected</>
                      : preset.metrics.eligible ? "Select" : "Below threshold"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {renderedPresets.length < visiblePresets.length && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisibleLimit((current) => current + 48)}>
            Show 48 more · {visiblePresets.length - renderedPresets.length} remaining
          </Button>
        </div>
      )}
    </div>
  )
}
