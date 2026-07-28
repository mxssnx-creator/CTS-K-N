"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Activity, BarChart3, ExternalLink, RadioTower, RefreshCw, Save, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/simple-toast"

interface SourceDescriptor {
  id: string
  name: string
  market: "perpetual" | "futures" | "spot" | "aggregator"
  priority: 1 | 2 | 3
  timeframeMinutes: number
  officialDocs: string
  enabledByDefault: boolean
}

interface SourceHealth {
  sourceId: string
  successes: number
  failures: number
  consecutiveFailures: number
  lastCandleCount: number
  lastStopLossPct?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastError?: string
  circuitOpenUntil: number
}

interface PerformanceState {
  connectionId: string
  sourceId: string
  symbol: string
  direction: "long" | "short"
  count: number
  wins: number
  grossProfit: number
  grossLoss: number
  profitFactor: number
  totalPnl: number
  averagePnl: number
  winRate: number
  autoDisabled: boolean
  disabledUntil: number
  updatedAt: number
}

interface SignalSettings {
  enabled: boolean
  directExecutionEnabled: boolean
  trailingEnabled: boolean
  trailingOnly: boolean
  trailingStartPct: number
  trailingMinStopPct: number
  trailingPositiveMoveRatio: number
  trailingUpdateStopRangeRatio: number
  timeframeMinutes: number
  candleLimit: number
  maxSourcesPerCycle: number
  maxPositionsTotal: number
  positionSelectionMode: "best_first"
  requestIntervalSeconds: number
  requestTimeoutMs: number
  concurrency: number
  minimumSourceSignals: number
  minimumAgreement: number
  minimumConfidence: number
  minimumStrength: number
  stopLossMinPct: number
  stopLossMaxPct: number
  stopLossAtrMultiplier: number
  takeProfitRewardRisk: number
  takeProfitMaxPct: number
  performanceLookback: number
  performanceMinSamples: number
  performanceDisableBelowPnl: number
  configMinimumPfRatio: number
  performanceCooldownMinutes: number
  circuitFailureThreshold: number
  circuitCooldownSeconds: number
  databaseSize: number
  sources: Record<string, {
    enabled: boolean
    weight: number
    disabledSymbols: string[]
    disabledLanes: string[]
  }>
}

function numeric(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function SignalIndicationSettings() {
  const [settings, setSettings] = useState<SignalSettings | null>(null)
  const [sources, setSources] = useState<SourceDescriptor[]>([])
  const [health, setHealth] = useState<Record<string, SourceHealth>>({})
  const [performance, setPerformance] = useState<PerformanceState[]>([])
  const [signalVolumeFactor, setSignalVolumeFactor] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [settingsResponse, statusResponse] = await Promise.all([
        fetch(`/api/settings/indications/signal?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/indications/signals/status?t=${Date.now()}`, { cache: "no-store" }),
      ])
      const data = await settingsResponse.json()
      if (!settingsResponse.ok || !data.success) throw new Error(data.error || "Signal settings request failed")
      setSettings(data.settings)
      setSignalVolumeFactor(Math.max(1, Math.min(10, Number(data.signalVolumeFactor) || 1)))
      setSources(data.sources || [])
      if (statusResponse.ok) {
        const status = await statusResponse.json()
        const healthBySource: Record<string, SourceHealth> = {}
        const allPerformance: PerformanceState[] = []
        for (const connection of status.connections || []) {
          for (const item of connection.sourceHealth || []) {
            const previous = healthBySource[item.sourceId]
            if (!previous || Number(item.lastSuccessAt || 0) > Number(previous.lastSuccessAt || 0)) {
              healthBySource[item.sourceId] = item
            }
          }
          allPerformance.push(...(connection.performance || []).map((item: PerformanceState) => ({
            ...item,
            connectionId: connection.connectionId,
          })))
        }
        setHealth(healthBySource)
        setPerformance(allPerformance)
      }
      setDirty(false)
    } catch (error) {
      console.error("[signal-indications] Failed to load:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load Signal indication")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = <Key extends keyof SignalSettings>(key: Key, value: SignalSettings[Key]) => {
    setSettings((current) => current ? { ...current, [key]: value } : current)
    setDirty(true)
  }

  const updateNumber = (key: keyof SignalSettings, value: string) => {
    if (!settings) return
    update(key, numeric(value, Number(settings[key])) as never)
  }

  const updateSource = (
    sourceId: string,
    patch: Partial<{
      enabled: boolean
      weight: number
      disabledSymbols: string[]
      disabledLanes: string[]
    }>,
  ) => {
    if (!settings) return
    update("sources", {
      ...settings.sources,
      [sourceId]: {
        enabled: settings.sources[sourceId]?.enabled !== false,
        weight: settings.sources[sourceId]?.weight ?? 1,
        disabledSymbols: settings.sources[sourceId]?.disabledSymbols ?? [],
        disabledLanes: settings.sources[sourceId]?.disabledLanes ?? [],
        ...patch,
      },
    })
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    try {
      const response = await fetch("/api/settings/indications/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, signalVolumeFactor }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || "Signal settings save failed")
      setSettings(data.settings)
      setSignalVolumeFactor(Math.max(1, Math.min(10, Number(data.signalVolumeFactor) || 1)))
      setSources(data.sources || sources)
      setDirty(false)
      toast.success("Signal indication saved and applied")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Signal indication")
    } finally {
      setSaving(false)
    }
  }

  const enabledCount = useMemo(
    () => sources.filter((source) => settings?.sources[source.id]?.enabled !== false).length,
    [settings, sources],
  )
  const disabledPerformanceCount = performance.filter((item) => item.autoDisabled).length
  const sortedPerformance = useMemo(
    () => [...performance].sort((left, right) =>
      Number(right.autoDisabled) - Number(left.autoDisabled) ||
      left.connectionId.localeCompare(right.connectionId) ||
      left.symbol.localeCompare(right.symbol) ||
      left.direction.localeCompare(right.direction) ||
      left.sourceId.localeCompare(right.sourceId),
    ),
    [performance],
  )

  if (loading || !settings) {
    return (
      <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading multi-source Signal contract…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="border-primary/25">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <RadioTower className="h-4 w-4 text-primary" />
                Multi-source Signal indication
              </CardTitle>
              <CardDescription className="mt-1 max-w-3xl text-xs">
                Read-only public OHLCV feeds are normalized locally. Consensus, ATR/cost-aware short stops,
                source health, and the realized PnL guards are independent by source, symbol, and Long/Short.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{enabledCount}/{sources.length} sources enabled</Badge>
              <Badge variant={disabledPerformanceCount > 0 ? "destructive" : "secondary"}>
                {disabledPerformanceCount} underperforming lanes disabled
              </Badge>
              <Button size="sm" variant="outline" asChild>
                <Link href="/statistics/indications/signal">
                  <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                  Statistics
                </Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Reload
              </Button>
              <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border bg-muted/20 p-3">
            <div>
              <Label>Enabled by default</Label>
              <p className="text-xs text-muted-foreground">
                Realtime only; historical replay never performs external HTTP requests. Public-source
                requests are rate-limited to the configured interval, never below 30 seconds.
              </p>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={(checked) => update("enabled", checked)} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div>
              <Label>Direct bootstrap execution</Label>
              <p className="text-xs text-muted-foreground">
                Enabled by default. Exact config PF-history checks are bypassed; after 12 source results
                or 10 source × symbol × direction results, a negative average disables only the affected
                scope. A config whose newest 16 real exchange closes average negative remains permanently
                disabled. Turning this off keeps the same source/lane guards and additionally requires each
                exact config to pass its 12-result PositionCost-relative PF window.
              </p>
            </div>
            <Switch
              checked={settings.directExecutionEnabled}
              onCheckedChange={(checked) => update("directExecutionEnabled", checked)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ["maxPositionsTotal", "Max open positions (Long + Short)", 1, 120, 1],
              ["candleLimit", "Candles per source", 20, 250, 1],
              ["requestIntervalSeconds", "Request interval (seconds)", 30, 3600, 30],
              ["concurrency", "HTTP concurrency", 1, 10, 1],
              ["requestTimeoutMs", "Request timeout (ms)", 500, 10000, 100],
              ["minimumSourceSignals", "Minimum agreeing sources", 2, 20, 1],
              ["minimumAgreement", "Minimum agreement", 0.5, 1, 0.05],
              ["minimumConfidence", "Minimum confidence", 0.5, 0.99, 0.01],
              ["minimumStrength", "Minimum signal strength", 0.05, 0.95, 0.05],
            ] as const).map(([key, label, min, max, step]) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={settings[key]}
                  onChange={(event) => updateNumber(key, event.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div>
              <Label>Website source processing</Label>
              <p className="text-xs text-muted-foreground">
                Every enabled source compatible with the symbol is evaluated
                each cycle. HTTP concurrency controls work in flight only.
              </p>
            </div>
            <Badge variant="secondary">All enabled · Unlimited</Badge>
          </div>
          <div className="grid gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-[11px] sm:grid-cols-2">
            <div>
              <div className="font-medium">Source coverage is independent</div>
              <p className="mt-0.5 text-muted-foreground">
                The 35-source registry counts different public websites only. It never limits symbols or positions.
              </p>
            </div>
            <div>
              <div className="flex items-center gap-2 font-medium">
                Position admission
                <Badge variant="outline" className="text-[10px]">Best quality first</Badge>
              </div>
              <p className="mt-0.5 text-muted-foreground">
                Up to {settings.maxPositionsTotal} active physical Signal positions across Long and Short.
                Consensus quality, confidence, agreement, strength, and reward/risk determine processing order.
              </p>
            </div>
          </div>
          <div className="space-y-2 rounded-md border bg-muted/15 p-3">
            <div>
              <div className="text-xs font-medium">Fixed Signal engine contracts</div>
              <p className="text-[10px] text-muted-foreground">
                Safety and comparability invariants are visible here but cannot be weakened by legacy JSON or a manual request.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded border bg-border sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Timeframe", `${settings.timeframeMinutes} minute`],
                ["Registry", `${sources.length} websites`],
                ["Selection", settings.positionSelectionMode === "best_first" ? "Best first" : settings.positionSelectionMode],
                ["Source gate", "12 closed · avg ≥ 0"],
                ["Symbol + direction", "10 closed · avg ≥ 0"],
                ["Config PF", `${settings.performanceLookback} · ratio ${settings.configMinimumPfRatio.toFixed(2)}`],
                ["Permanent disable", "16-result avg < 0"],
              ].map(([label, value]) => (
                <div key={label} className="bg-background px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
                  <div className="mt-0.5 font-mono text-[10px] font-medium">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-emerald-500/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-emerald-500" />
            Signal trailing lane
          </CardTitle>
          <CardDescription className="text-xs">
            Runs as a separate position lane alongside the normal Signal position. Ratios use 1 = 100%.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Signal volume factor</Label>
                <p className="text-xs text-muted-foreground">
                  Global Signal multiplier; a connection-specific value in Connection Settings → Overall takes precedence.
                </p>
              </div>
              <Badge variant="outline">{signalVolumeFactor.toFixed(1)}×</Badge>
            </div>
            <Slider
              min={1}
              max={10}
              step={0.1}
              value={[signalVolumeFactor]}
              onValueChange={([value]) => {
                setSignalVolumeFactor(value)
                setDirty(true)
              }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border bg-muted/20 p-3">
              <div>
                <Label>Trailing enabled</Label>
                <p className="text-xs text-muted-foreground">Enabled by default; opens the independent trailing lane.</p>
              </div>
              <Switch
                checked={settings.trailingEnabled}
                onCheckedChange={(checked) => {
                  setSettings((current) => current
                    ? { ...current, trailingEnabled: checked, trailingOnly: checked ? current.trailingOnly : false }
                    : current)
                  setDirty(true)
                }}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/20 p-3">
              <div>
                <Label>Trailing only</Label>
                <p className="text-xs text-muted-foreground">Disabled by default; suppresses the normal Signal lane.</p>
              </div>
              <Switch
                checked={settings.trailingOnly}
                onCheckedChange={(checked) => {
                  setSettings((current) => current
                    ? { ...current, trailingOnly: checked, trailingEnabled: checked || current.trailingEnabled }
                    : current)
                  setDirty(true)
                }}
              />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Start after favorable move</Label>
                <Badge variant="outline">
                  {settings.trailingStartPct === 0 ? "General entry (0%)" : `${settings.trailingStartPct.toFixed(1)}%`}
                </Badge>
              </div>
              <Slider
                min={0}
                max={10}
                step={0.1}
                value={[settings.trailingStartPct]}
                onValueChange={([value]) => update("trailingStartPct", value)}
                disabled={!settings.trailingEnabled}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Minimum stop range</Label>
                <Badge variant="outline">{settings.trailingMinStopPct.toFixed(1)}%</Badge>
              </div>
              <Slider
                min={0.8}
                max={10}
                step={0.1}
                value={[settings.trailingMinStopPct]}
                onValueChange={([value]) => update("trailingMinStopPct", value)}
                disabled={!settings.trailingEnabled}
              />
              <p className="text-[11px] text-muted-foreground">Execution floor: 0.8%.</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Positive market-move ratio</Label>
                <Badge variant="outline">
                  {settings.trailingPositiveMoveRatio.toFixed(2)} ({Math.round(settings.trailingPositiveMoveRatio * 100)}%)
                </Badge>
              </div>
              <Slider
                min={0.05}
                max={1}
                step={0.05}
                value={[settings.trailingPositiveMoveRatio]}
                onValueChange={([value]) => update("trailingPositiveMoveRatio", value)}
                disabled={!settings.trailingEnabled}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Update ratio of stop range</Label>
                <Badge variant="outline">
                  {settings.trailingUpdateStopRangeRatio.toFixed(2)} ({Math.round(settings.trailingUpdateStopRangeRatio * 100)}%)
                </Badge>
              </div>
              <Slider
                min={0.1}
                max={1}
                step={0.05}
                value={[settings.trailingUpdateStopRangeRatio]}
                onValueChange={([value]) => update("trailingUpdateStopRangeRatio", value)}
                disabled={!settings.trailingEnabled}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4" />
              TP / SL contract
            </CardTitle>
            <CardDescription className="text-xs">
              Volatility above the permitted stop band rejects a source instead of forcing an unsafe tight stop.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {([
              ["stopLossMinPct", "Minimum SL (%)", 0.2, 2, 0.05],
              ["stopLossMaxPct", "Short-trade maximum SL (%)", 0.2, 5, 0.05],
              ["stopLossAtrMultiplier", "ATR multiplier", 0.1, 3, 0.05],
              ["takeProfitRewardRisk", "Minimum reward/risk", 1.1, 5, 0.1],
              ["takeProfitMaxPct", "Maximum TP (%)", 0.5, 22, 0.25],
              ["databaseSize", "Entries per Signal Set", 25, 2000, 25],
            ] as const).map(([key, label, min, max, step]) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={settings[key]}
                  onChange={(event) => updateNumber(key, event.target.value)}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4" />
              Realized performance guard
            </CardTitle>
            <CardDescription className="text-xs">
              Source health uses the newest 12 realized positions; each source × symbol × direction
              lane uses its own newest 10. These windows never cap open positions.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/20 p-3 sm:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Fixed evidence window</Label>
                <Badge variant="outline">Source 12 · lane 10</Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Fresh lanes bootstrap directly. Mature negative source averages stop that source;
                mature negative Long or Short averages stop only that exact lane.
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-3 sm:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Fixed performance boundary</Label>
                <Badge variant="outline">Disable when total PnL &lt; 0</Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                A persisted legacy threshold cannot keep a negative source × symbol × direction lane enabled.
              </p>
            </div>
            {([
              ["performanceCooldownMinutes", "Probe cooldown (minutes)", 1, 1440, 1],
              ["circuitFailureThreshold", "HTTP failures before circuit", 1, 20, 1],
              ["circuitCooldownSeconds", "Circuit cooldown (seconds)", 10, 3600, 10],
            ] as const).map(([key, label, min, max, step]) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={settings[key]}
                  onChange={(event) => updateNumber(key, event.target.value)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Independent Signal performance lanes</CardTitle>
          <CardDescription className="text-xs">
            Source × symbol × Long/Short windows are stored and gated separately. Consensus has its own lane.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sortedPerformance.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              No realized Signal outcomes yet.
            </p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Connection</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Symbol</th>
                    <th className="px-3 py-2 font-medium">Direction</th>
                    <th className="px-3 py-2 text-right font-medium">Samples</th>
                    <th className="px-3 py-2 text-right font-medium">PnL</th>
                    <th className="px-3 py-2 text-right font-medium">PF</th>
                    <th className="px-3 py-2 text-right font-medium">Average</th>
                    <th className="px-3 py-2 text-right font-medium">Win rate</th>
                    <th className="px-3 py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPerformance.map((item) => (
                    <tr
                      key={`${item.connectionId}:${item.sourceId}:${item.symbol}:${item.direction}`}
                      className="border-b last:border-b-0"
                    >
                      <td className="max-w-36 truncate px-3 py-2">{item.connectionId}</td>
                      <td className="px-3 py-2">{item.sourceId}</td>
                      <td className="px-3 py-2 font-mono">{item.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="capitalize">{item.direction}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.count}/10</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${item.totalPnl < 0 ? "text-destructive" : "text-emerald-600"}`}>
                        {Number(item.totalPnl || 0).toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(item.profitFactor || 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(item.averagePnl || 0).toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(Number(item.winRate || 0) * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={item.autoDisabled ? "destructive" : "secondary"}>
                          {item.autoDisabled ? "disabled" : item.count < 10 ? "warming" : "enabled"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Free public source adapters</CardTitle>
          <CardDescription className="text-xs">
            Four liquid derivatives feeds remain in every batch; the remaining enabled sources rotate so all 35
            are exercised without a request storm. Source priority selects batches; current low-stop quality
            and configured weight influence consensus.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {sources.map((source) => {
            const configured = settings.sources[source.id] || {
              enabled: true,
              weight: 1,
              disabledSymbols: [],
              disabledLanes: [],
            }
            const sourceHealth = health[source.id]
            const circuitOpen = Number(sourceHealth?.circuitOpenUntil || 0) > Date.now()
            return (
              <div
                key={source.id}
                className={`rounded-md border p-3 ${configured.enabled ? "border-emerald-500/25" : "opacity-65"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{source.name}</span>
                      <Badge variant="outline" className="text-[10px]">P{source.priority}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{source.market}</Badge>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {source.timeframeMinutes}m · {sourceHealth?.lastCandleCount || 0} candles ·
                      {" "}{sourceHealth?.lastStopLossPct?.toFixed(3) || "—"}% last SL
                    </div>
                  </div>
                  <Switch
                    checked={configured.enabled}
                    onCheckedChange={(checked) => updateSource(source.id, { enabled: checked })}
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Label className="text-[10px]">Weight</Label>
                  <Input
                    className="h-7 w-20 text-xs"
                    type="number"
                    min={0.1}
                    max={2}
                    step={0.05}
                    value={configured.weight}
                    onChange={(event) => updateSource(source.id, {
                      weight: numeric(event.target.value, configured.weight),
                    })}
                  />
                  <a
                    href={source.officialDocs}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                  >
                    Official docs <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {circuitOpen && (
                  <p className="mt-1 text-[10px] text-destructive">
                    Circuit open after {sourceHealth.consecutiveFailures} failures
                  </p>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
